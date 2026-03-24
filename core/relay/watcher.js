/**
 * Inbox Watcher v4.2 — Fixed duplicate message delivery
 *
 * Core loop: inbox.jsonl -> claude CLI (async spawn) -> outbox/ -> Telegram
 *
 * Features:
 * - Real-time text streaming to Telegram via stream-outbox
 * - Async spawn (not execSync) — non-blocking, cancellable
 * - Progress updates every 30s during long tasks
 * - /stop command kills active process immediately
 * - Full system prompt: IDENTITY + SOUL + GLOBAL_POLICY + USER + TOOLS + memory
 * - Media handling: photos/documents/voice passed to Claude as file references
 * - Daily memory writing after each call
 * - Session owner persistence (survives restarts)
 * - Cron scheduler integration
 * - Gateway API integration
 * - Delivery queue processing
 * - Inbox rotation & processed cleanup
 * - Health heartbeat
 * - Watchdog-compatible (crash recovery)
 *
 * Adapted for TamerClaw: all paths resolved via paths.js, no hardcoded paths.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { readConfigCached, writeFileAtomic, ensureDir, appendFile as asyncAppend } from '../shared/async-fs.js';
import { extractTrace, tracedLogger, createTrace, newTraceId } from '../shared/trace.js';
import { getProxyMode, setProxyMode, resolveProxyModel, getProxiedAgents } from '../shared/proxy.js';
import paths from '../shared/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths ────────────────────────────────────────────────────────────────────
const RELAY_DIR = paths.relay;
const INBOX = path.join(RELAY_DIR, 'inbox.jsonl');
const OUTBOX_DIR = path.join(RELAY_DIR, 'outbox');
const PROCESSED = path.join(RELAY_DIR, 'processed.txt');
const AGENTS_DIR = paths.agents;
const SHARED_DIR = paths.shared;
const CONFIG_PATH = paths.config;
const CURRENT_AGENT_FILE = path.join(RELAY_DIR, 'current-agent.txt');
const PROCESSING_FILE = path.join(RELAY_DIR, 'processing.json');
const SESSION_OWNER_FILE = path.join(RELAY_DIR, 'session-owners.json');
const AGENT_SESSIONS_FILE = path.join(RELAY_DIR, 'agent-sessions.json');
const HEALTH_FILE = path.join(RELAY_DIR, 'health.json');

const STREAM_OUTBOX_DIR = path.join(RELAY_DIR, 'stream-outbox');

if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
if (!fs.existsSync(STREAM_OUTBOX_DIR)) fs.mkdirSync(STREAM_OUTBOX_DIR, { recursive: true });

// ── Startup Cleanup ──────────────────────────────────────────────────────────
// Clean stale state from previous crash/restart to prevent phantom behavior.

// 1. Remove stale processing.json — prevents phantom typing indicator in bot.js
try {
  if (fs.existsSync(PROCESSING_FILE)) {
    console.log('[startup] Cleaning stale processing.json from previous run');
    fs.unlinkSync(PROCESSING_FILE);
  }
} catch {}

// 2. Clean stale stream-outbox files — prevents sending old partial streams
try {
  const staleFiles = fs.readdirSync(STREAM_OUTBOX_DIR).filter(f => f.endsWith('.json') || f.endsWith('.msgid') || f.endsWith('.tmp'));
  if (staleFiles.length > 0) {
    console.log(`[startup] Cleaning ${staleFiles.length} stale stream-outbox files`);
    for (const f of staleFiles) {
      try { fs.unlinkSync(path.join(STREAM_OUTBOX_DIR, f)); } catch {}
    }
  }
} catch {}

// ── Config Cache ─────────────────────────────────────────────────────────────
let _configCache = null;
let _configMtime = 0;

function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (_configCache && stat.mtimeMs === _configMtime) return _configCache;
    _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch (e) {
    console.error('[config] Failed to load:', e.message);
    return _configCache || { agents: {}, defaults: {} };
  }
}

async function loadConfigAsync() {
  try {
    return await readConfigCached(CONFIG_PATH);
  } catch (e) {
    console.error('[config] Async load failed:', e.message);
    return loadConfig(); // fallback to sync cached
  }
}

// ── Processed Message Tracking ───────────────────────────────────────────────
function getProcessed() {
  try { return new Set(fs.readFileSync(PROCESSED, 'utf-8').trim().split('\n').filter(Boolean)); }
  catch { return new Set(); }
}

function markProcessed(id) {
  fs.appendFileSync(PROCESSED, id + '\n');
}

function trimProcessed(keepLast = 500) {
  try {
    const lines = fs.readFileSync(PROCESSED, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length > keepLast * 2) {
      fs.writeFileSync(PROCESSED, lines.slice(-keepLast).join('\n') + '\n');
      console.log(`[cleanup] Trimmed processed.txt: ${lines.length} -> ${keepLast}`);
    }
  } catch {}
}

function rotateInbox() {
  try {
    const processed = getProcessed();
    const lines = fs.readFileSync(INBOX, 'utf-8').trim().split('\n').filter(Boolean);
    const kept = [];
    let processedCount = 0;
    for (const line of lines.reverse()) {
      try {
        const msg = JSON.parse(line);
        if (!processed.has(msg.id)) {
          kept.unshift(line);
        } else if (processedCount < 50) {
          kept.unshift(line);
          processedCount++;
        }
      } catch { kept.unshift(line); }
    }
    if (lines.length > kept.length + 20) {
      fs.writeFileSync(INBOX, kept.join('\n') + '\n');
      console.log(`[cleanup] Rotated inbox: ${lines.length} -> ${kept.length} lines`);
    }
  } catch {}
}

// ── Current Agent ────────────────────────────────────────────────────────────
function loadCurrentAgent() {
  try { return fs.readFileSync(CURRENT_AGENT_FILE, 'utf-8').trim() || 'scrum'; }
  catch { return 'scrum'; }
}
function saveCurrentAgent(agentId) {
  fs.writeFileSync(CURRENT_AGENT_FILE, agentId);
}
let currentAgent = loadCurrentAgent();

// ── Session Owner Persistence ────────────────────────────────────────────────
function loadSessionOwners() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_OWNER_FILE, 'utf-8')))); }
  catch { return new Map(); }
}
function saveSessionOwners(map) {
  try { fs.writeFileSync(SESSION_OWNER_FILE, JSON.stringify(Object.fromEntries(map), null, 2)); }
  catch {}
}
const sessionOwner = loadSessionOwners();

// ── Per-Agent Session ID Tracking (deterministic context resumption) ─────────

function loadAgentSessions() {
  try { return JSON.parse(fs.readFileSync(AGENT_SESSIONS_FILE, 'utf-8')); }
  catch { return {}; }
}

function saveAgentSessions(sessions) {
  try { fs.writeFileSync(AGENT_SESSIONS_FILE, JSON.stringify(sessions, null, 2)); }
  catch (e) { console.error('[sessions] Save failed:', e.message); }
}

// Structure: { agentId: { sessionId: "uuid", startedAt: "iso", messageCount: N } }
const agentSessions = loadAgentSessions();

function getAgentSessionId(agentId) {
  return agentSessions[agentId]?.sessionId || null;
}

function createAgentSession(agentId) {
  const sessionId = randomUUID();
  agentSessions[agentId] = {
    sessionId,
    startedAt: new Date().toISOString(),
    messageCount: 0
  };
  saveAgentSessions(agentSessions);
  console.log(`[sessions] Created new session for ${agentId}: ${sessionId}`);
  return sessionId;
}

function incrementSessionMessageCount(agentId) {
  if (agentSessions[agentId]) {
    agentSessions[agentId].messageCount = (agentSessions[agentId].messageCount || 0) + 1;
    agentSessions[agentId].lastMessageAt = new Date().toISOString();
    saveAgentSessions(agentSessions);
  }
}

function resetAgentSession(agentId) {
  delete agentSessions[agentId];
  saveAgentSessions(agentSessions);
  console.log(`[sessions] Cleared session for ${agentId}`);
}

// ── Workspace Resolution ─────────────────────────────────────────────────────
function getWorkspace(agentId) {
  const newWs = paths.agentDir(agentId);
  if (fs.existsSync(newWs)) return newWs;
  try {
    const config = loadConfig();
    const agent = config.agents[agentId];
    const ws = agent?.legacyWorkspace || agent?.workspace || os.homedir();
    if (fs.existsSync(ws)) return ws;
  } catch {}
  return os.homedir();
}

function getProjectWorkspace(agentId) {
  const wsDir = path.join(paths.agentDir(agentId), 'workspace');
  if (fs.existsSync(wsDir)) return wsDir;
  return getWorkspace(agentId);
}

// ── Model & Tools ────────────────────────────────────────────────────────────

/**
 * Resolve model configuration for an agent.
 * Returns { provider, modelId, cliFlag, api, baseUrl, envKey }
 */
function resolveModelConfig(agentId) {
  const config = loadConfig();
  const rawModel = config.agents[agentId]?.model || config.defaults?.model || 'claude-sonnet-4-6';

  // Parse "provider/model" syntax
  let provider = null;
  let modelId = rawModel;
  if (rawModel.includes('/')) {
    const parts = rawModel.split('/');
    provider = parts[0];
    modelId = parts.slice(1).join('/');
  }

  // Look up model in providers to determine provider if not explicit
  const providers = config.models?.providers || {};
  if (!provider) {
    for (const [pName, pConfig] of Object.entries(providers)) {
      if (pConfig.models && (pConfig.models[modelId] || pConfig.models.hasOwnProperty(modelId))) {
        provider = pName;
        break;
      }
    }
  }

  // Default to anthropic if not found
  if (!provider) provider = config.models?.defaultProvider || 'anthropic';

  const providerConfig = providers[provider] || {};
  const modelDef = providerConfig.models?.[modelId] || {};

  return {
    provider,
    modelId,
    cliFlag: modelDef.cliFlag || null,
    api: providerConfig.api || 'claude-cli',
    baseUrl: providerConfig.baseUrl || null,
    envKey: providerConfig.envKey || null,
    maxTokens: modelDef.maxTokens || config.defaults?.maxTokens || 16384,
    contextWindow: modelDef.contextWindow || config.defaults?.contextTokens || 131072
  };
}

/**
 * Resolve the fallback model for an agent (used when primary model is rate-limited).
 */
function resolveFallbackModel(agentId) {
  const config = loadConfig();
  const providers = config.models?.providers || {};

  // Agent-level override
  let fallbackRaw = config.agents[agentId]?.fallbackModel;
  // Default fallback from config
  if (!fallbackRaw && config.defaults?.fallbackModels?.length) {
    fallbackRaw = config.defaults.fallbackModels[0];
  }
  if (!fallbackRaw) return null;

  // Resolve to CLI flag
  for (const [, pConfig] of Object.entries(providers)) {
    const modelDef = pConfig.models?.[fallbackRaw];
    if (modelDef?.cliFlag) return modelDef.cliFlag;
  }
  // If it's already a short name like 'sonnet', return as-is
  return fallbackRaw;
}

// Legacy shim used by /status and health — returns CLI flag or model name
function resolveModel(agentId) {
  const mc = resolveModelConfig(agentId);
  return mc.cliFlag || mc.modelId;
}

function getAllowedTools() {
  try {
    const config = loadConfig();
    const tools = config.defaults?.allowedTools;
    if (tools && Array.isArray(tools)) return tools.join(' ');
  } catch {}
  return 'Read Edit Write Bash Glob Grep Agent WebSearch WebFetch';
}

// ── Memory Loading ───────────────────────────────────────────────────────────
function loadRecentMemory(agentId) {
  const memDir = paths.memory(agentId);
  const parts = [];
  try {
    const memFiles = fs.readdirSync(memDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();

    const today = new Date().toISOString().slice(0, 10);
    let loadedChars = 0;
    const MAX_CHARS = 12000;

    for (const file of memFiles.slice(0, 5)) {
      const date = file.replace('.md', '');
      const content = fs.readFileSync(path.join(memDir, file), 'utf-8');
      const budget = MAX_CHARS - loadedChars;
      if (budget <= 200) break;
      const label = date === today ? `Today (${date})` : `Session ${date}`;
      const slice = content.slice(-Math.min(budget, content.length));
      parts.push(`# ${label}\n${slice}`);
      loadedChars += slice.length;
    }
  } catch {}
  return parts;
}

// ── Memory Writing ───────────────────────────────────────────────────────────
function appendDailyMemory(agentId, userMessage, responseLength) {
  const memDir = paths.memory(agentId);
  try {
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const memPath = path.join(memDir, `${today}.md`);
    const time = new Date().toISOString().slice(11, 19);
    const summary = userMessage.slice(0, 150).replace(/\n/g, ' ');
    const entry = `\n[${time}] User: ${summary}${userMessage.length > 150 ? '...' : ''} -> responded (${responseLength} chars)\n`;

    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath, `# ${today}\n\n## Conversation Log\n`);
    }
    fs.appendFileSync(memPath, entry);
  } catch (e) {
    console.error(`[${agentId}] Memory write failed:`, e.message);
  }
}

// ── Shared Files Loading ─────────────────────────────────────────────────────
function readSharedFile(filename) {
  try {
    const filePath = path.join(SHARED_DIR, filename);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch {}
  return null;
}

// ── System Prompt Builder ────────────────────────────────────────────────────
function getAgentPrompt(agentId) {
  const parts = [];

  // 1. Identity — MUST be first
  const identityPath = paths.agentIdentity(agentId);
  try { parts.push(fs.readFileSync(identityPath, 'utf-8')); }
  catch { parts.push(`You are the **${agentId}** agent.`); }

  // 2. Shared SOUL.md (personality)
  const soul = readSharedFile('SOUL.md');
  if (soul) parts.push(soul);

  // 3. Shared GLOBAL_POLICY.md (system-wide rules)
  const policy = readSharedFile('GLOBAL_POLICY.md');
  if (policy) parts.push(policy);

  // 4. USER.md (who the user is)
  const userPath = paths.agentUser(agentId);
  try { parts.push(fs.readFileSync(userPath, 'utf-8')); } catch {}

  // 5. TOOLS.md (agent-specific tool notes)
  const toolsPath = paths.agentTools(agentId);
  try {
    const content = fs.readFileSync(toolsPath, 'utf-8');
    if (content.trim().length > 50) parts.push(content); // Skip near-empty template files
  } catch {}

  // 6. MEMORY.md (long-term structured memory)
  const memPath = paths.agentMemoryMd(agentId);
  try {
    const content = fs.readFileSync(memPath, 'utf-8');
    if (content.trim()) parts.push('# Long-term Memory\n' + content.slice(0, 5000));
  } catch {}

  // 7. Recent daily session memories
  parts.push(...loadRecentMemory(agentId));

  // 8. Workspace + behavior instructions
  const ws = getWorkspace(agentId);
  const projectWs = getProjectWorkspace(agentId);

  // List available agents for inter-agent awareness
  let agentList = '';
  try {
    const config = loadConfig();
    if (config.tools?.agentToAgent?.enabled) {
      const others = Object.keys(config.agents).filter(id => id !== agentId).join(', ');
      agentList = `\n\n## Inter-Agent Communication\nAvailable agents: ${others}\nTo communicate with another agent, read/write files in their workspace at ${AGENTS_DIR}/<name>/workspace/.`;
    }
  } catch {}

  const memoryDir = paths.memory(agentId);
  const mediaDir = paths.agentMedia(agentId);

  parts.push(`
# Instructions
You are the **${agentId}** agent chatting via Telegram. Respond directly and concisely.

When the user asks about your last task, previous work, or context — READ your memory sections above carefully. They contain your full session history including timestamps, builds, and task details. Do NOT say you have no context if memory sections are present above.

For large tasks, proceed with the full implementation by default. Only pause if the user says "stop", "pause", or explicitly asks to review first. Provide progress updates during long-running work.

When you complete significant work, write a summary to your daily memory file at:
${path.join(memoryDir, new Date().toISOString().slice(0, 10) + '.md')}

# Your Workspace
- Agent config: ${ws}
- Project files: ${projectWs}
- Memory: ${memoryDir}/ (YYYY-MM-DD.md)
- Design files: ${projectWs}/design/ (if applicable)
- Media received: ${mediaDir}/

IMPORTANT: Use ${projectWs} for project files.
Other agents: ${AGENTS_DIR}/<name>/workspace/.${agentList}

# Telegram Formatting Rules
- No markdown tables (use bullet lists instead)
- Keep messages concise for mobile
- Use emoji sparingly`);

  return parts.join('\n\n---\n\n');
}

// ── Claude CLI Execution (async with progress updates) ───────────────────────

let activeProcess = null;  // current running claude child process
let stopRequested = false; // set by /stop command

const PROGRESS_THROTTLE_MS = 30000; // Min 30s between progress updates
const FALLBACK_PROGRESS_MS = 60000; // Fallback timer checks every 60s

// ── Stream Event Helpers ──────────────────────────────────────────────────────

function formatToolActivity(toolName, input) {
  const shortPath = (p) => p ? p.split('/').slice(-2).join('/') : '';
  switch (toolName) {
    case 'Read': return `Reading ${shortPath(input?.file_path)}`;
    case 'Edit': return `Editing ${shortPath(input?.file_path)}`;
    case 'Write': return `Writing ${shortPath(input?.file_path)}`;
    case 'Bash': {
      const cmd = (input?.command || '').slice(0, 60);
      return `Running: ${cmd}${cmd.length >= 60 ? '...' : ''}`;
    }
    case 'Grep': return `Searching: ${(input?.pattern || '').slice(0, 40)}`;
    case 'Glob': return `Finding: ${(input?.pattern || '').slice(0, 40)}`;
    case 'Agent': return `Delegating: ${(input?.description || 'subtask').slice(0, 40)}`;
    case 'WebSearch': return `Web search: ${(input?.query || '').slice(0, 40)}`;
    case 'WebFetch': return `Fetching URL`;
    default: return `Tool: ${toolName}`;
  }
}

function extractResultText(events) {
  // First check for a 'result' type event (final output)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'result' && ev.result) return ev.result;
  }
  // Fallback: collect assistant text blocks
  const texts = [];
  for (const ev of events) {
    if (ev.type === 'assistant' && ev.message) {
      if (typeof ev.message === 'string') {
        texts.push(ev.message);
      } else if (ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
      }
    }
  }
  return texts.join('\n') || null;
}

/**
 * Extract stop_reason from stream-json events.
 * Returns 'max_turns' when the agent hit the turn limit.
 */
function extractStopReason(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'result' && ev.stop_reason) return ev.stop_reason;
  }
  return null;
}

// ── Stream Outbox ─────────────────────────────────────────────────────────────

/**
 * Write stream message to stream-outbox atomically.
 * Uses a separate .msgid sidecar file for bot.js to write messageId.
 */
function updateStreamMessage(chatId, streamId, text, done) {
  const filename = `${chatId}-${streamId}.json`;
  const filePath = path.join(STREAM_OUTBOX_DIR, filename);
  const msgIdFile = path.join(STREAM_OUTBOX_DIR, `${chatId}-${streamId}.msgid`);

  // Read messageId from sidecar file (written by bot.js)
  let messageId = null;
  try {
    messageId = fs.readFileSync(msgIdFile, 'utf-8').trim() || null;
    if (messageId) messageId = parseInt(messageId, 10);
  } catch {
    // Sidecar doesn't exist yet — first write
  }

  const payload = { chatId, streamId, text, done };
  if (messageId) payload.messageId = messageId;

  // Write atomically: temp file + rename to prevent partial reads by bot.js
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error('[stream] Write error:', e.message);
    // Fallback: direct write (less safe but better than losing the message)
    try { fs.writeFileSync(filePath, JSON.stringify(payload)); } catch {}
  }
}

function isStreamingEnabled() {
  try {
    const config = loadConfig();
    const setting = config.telegram?.streaming;
    return setting === 'on' || setting === 'chunked';
  } catch {
    return false;
  }
}

// ── Claude CLI Execution (streaming with real-time feedback) ──────────────────

function callClaude(message, agentId, chatId, mediaPath = null) {
  const mc = resolveModelConfig(agentId);

  // Route to OpenAI-compatible provider (DeepSeek, Ollama, etc.)
  if (mc.api === 'openai-compatible') {
    return callOpenAICompatible(message, agentId, chatId, mc, mediaPath);
  }

  // Default: Claude CLI path
  return callClaudeCLI(message, agentId, chatId, mc, mediaPath);
}

/**
 * Call an OpenAI-compatible API (DeepSeek, Ollama, etc.)
 * Uses curl to POST to the chat completions endpoint.
 */
async function callOpenAICompatible(message, agentId, chatId, modelConfig, mediaPath = null) {
  const systemPrompt = getAgentPrompt(agentId);
  const cwd = getProjectWorkspace(agentId);

  let userMessage = message;
  if (mediaPath) {
    userMessage = `[Media file received and saved at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
  }

  console.log(`[${agentId}] Processing via ${modelConfig.provider}/${modelConfig.modelId}: "${userMessage.slice(0, 80)}..." in ${cwd}`);

  // Build the API request payload
  const payload = {
    model: modelConfig.modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: modelConfig.maxTokens,
    temperature: 0.7,
    stream: false
  };

  const tmpDir = paths.tmp;
  await ensureDir(tmpDir);
  const payloadFile = path.join(tmpDir, `tamerclaw-relay-${agentId}-openai-payload.json`);
  await fsp.writeFile(payloadFile, JSON.stringify(payload));

  // Resolve the API key from environment variable
  const apiKeyEnv = modelConfig.envKey || `${modelConfig.provider.toUpperCase()}_API_KEY`;
  const apiKey = process.env[apiKeyEnv] || '';

  return new Promise((resolve, reject) => {

    if (!apiKey) {
      console.error(`[${agentId}] No API key found in env var ${apiKeyEnv} for provider ${modelConfig.provider}`);
      reject(new Error(`Missing API key: set ${apiKeyEnv} environment variable for ${modelConfig.provider}`));
      return;
    }

    const baseUrl = (modelConfig.baseUrl || '').replace(/\/$/, '');
    const endpoint = `${baseUrl}/v1/chat/completions`;

    const curlCmd = `curl -s -X POST "${endpoint}" -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d @${payloadFile}`;

    const env = { ...process.env };
    env.HOME = os.homedir();

    const proc = spawn('bash', ['-c', curlCmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;
    stopRequested = false;

    let stdout = '';
    let stderr = '';
    const startTime = Date.now();

    // Progress timer for OpenAI-compatible calls
    const progressTimer = setInterval(() => {
      if (stopRequested) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed < 30) return;
      const mins = Math.floor(elapsed / 60);
      if (chatId) {
        sendReply(chatId, `*${agentId}* waiting for ${modelConfig.provider}/${modelConfig.modelId} (${mins}m+)\n\nSend /stop to cancel.`);
      }
    }, FALLBACK_PROGRESS_MS);

    // 5 min timeout for API calls
    const timeoutTimer = setTimeout(() => {
      console.error(`[${agentId}] ${modelConfig.provider} API timeout after 300s — killing`);
      proc.kill('SIGTERM');
    }, 300000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      activeProcess = null;

      if (stopRequested) {
        resolve({ text: '[Agent stopped by user. Partial work may have been saved.]', streamed: false });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(`${modelConfig.provider} API error: ${result.error.message || JSON.stringify(result.error)}`));
          return;
        }
        const response = result.choices?.[0]?.message?.content;
        if (response) {
          console.log(`[${agentId}] ${modelConfig.provider}/${modelConfig.modelId}: ${response.length} chars`);
          appendDailyMemory(agentId, userMessage, response.length);
          resolve({ text: response, streamed: false });
        } else {
          reject(new Error(`${modelConfig.provider} returned empty response`));
        }
      } catch (e) {
        reject(new Error(`${modelConfig.provider} response parse error: ${e.message}. Raw: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      activeProcess = null;
      reject(err);
    });
  });
}

/**
 * Call Claude via the Claude CLI (original path).
 */
async function callClaudeCLI(message, agentId, chatId, modelConfig, mediaPath = null) {
  const systemPrompt = getAgentPrompt(agentId);
  const cwd = getProjectWorkspace(agentId);
  const originalModel = modelConfig.cliFlag || 'sonnet';
  const tools = getAllowedTools();

  // Check proxy mode — dynamic routing overrides the model
  const proxyResult = resolveProxyModel(agentId, originalModel, message);
  const model = proxyResult.model;
  if (proxyResult.proxied) {
    console.log(`[${agentId}] Proxy mode 2: "${message.slice(0, 60)}..." -> ${proxyResult.complexity} -> ${model}`);
  }

  // Build user message with media reference
  let userMessage = message;
  if (mediaPath) {
    userMessage = `[Media file received and saved at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
  }

  console.log(`[${agentId}] Processing: "${userMessage.slice(0, 80)}..." in ${cwd} (model: ${model})`);

  // Resolve claude binary path — check common locations
  const claudeLocations = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    'claude'  // fallback to PATH
  ];
  let CLAUDE_BIN = 'claude';
  for (const loc of claudeLocations) {
    if (loc === 'claude' || fs.existsSync(loc)) {
      CLAUDE_BIN = loc;
      break;
    }
  }

  return new Promise((resolve, reject) => {

    // ── Deterministic Session Management ──
    const existingSessionId = getAgentSessionId(agentId);
    const isResume = !!existingSessionId;

    // Resolve fallback model for rate-limit resilience
    const fallbackModel = resolveFallbackModel(agentId);

    const baseArgs = [
      '-p', userMessage,
      '--verbose',
      '--output-format', 'stream-json',
      '--max-turns', '500',
      '--model', model,
      '--allowedTools', tools
    ];

    // Add fallback model if configured
    if (fallbackModel && fallbackModel !== model) {
      baseArgs.push('--fallback-model', fallbackModel);
      console.log(`[${agentId}] Fallback model: ${fallbackModel} (primary: ${model})`);
    }

    let args;
    if (isResume) {
      args = [...baseArgs, '--resume', existingSessionId, '--append-system-prompt', systemPrompt];
      console.log(`[${agentId}] Resuming session ${existingSessionId.slice(0, 8)}...`);
    } else {
      // New session — generate a UUID and track it
      const newSessionId = createAgentSession(agentId);
      args = [...baseArgs, '--session-id', newSessionId, '--system-prompt', systemPrompt];
      console.log(`[${agentId}] Starting NEW session ${newSessionId.slice(0, 8)}...`);
    }

    // Inherit env but remove CLAUDE* vars
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
    }
    env.HOME = os.homedir();

    const proc = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;
    stopRequested = false;

    let rawStdout = '';
    let stderr = '';
    const startTime = Date.now();

    // ── Streaming state ──
    const parsedEvents = [];     // All parsed JSON events
    let lineBuffer = '';          // Incomplete line buffer
    let lastActivity = '';        // Last tool activity description
    let lastProgressSent = 0;    // Timestamp of last progress message
    let toolCount = 0;           // Number of tool operations
    let hasStreamData = false;   // Whether we got any valid stream-json lines

    // ── Text streaming state ──
    const streamingEnabled = isStreamingEnabled() && !!chatId;
    const streamId = streamingEnabled ? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : null;
    let streamText = '';          // Accumulated assistant text
    let lastStreamUpdate = 0;    // Timestamp of last stream outbox write
    let lastStreamedLength = 0;  // Length of text at last stream update
    let streamedAnyText = false;  // Whether we successfully streamed any text

    // Parse each line of stream-json output
    function processChunk(chunk) {
      rawStdout += chunk;
      lineBuffer += chunk;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          hasStreamData = true;
          parsedEvents.push(event);
          processStreamEvent(event);
        } catch {
          // Not valid JSON — skip silently
        }
      }
    }

    function processStreamEvent(event) {
      // Track tool usage for real-time progress
      if (event.type === 'tool_use') {
        const toolName = event.tool || event.name || (event.tool_use && event.tool_use.name) || 'tool';
        const toolInput = event.input || (event.tool_use && event.tool_use.input) || {};
        lastActivity = formatToolActivity(toolName, toolInput);
        toolCount++;
        maybeSendProgress();
      }

      // Also detect tool use inside assistant message content blocks
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            lastActivity = formatToolActivity(block.name, block.input);
            toolCount++;
            maybeSendProgress();
          }
          // Extract assistant text from content blocks
          if (streamingEnabled && block.type === 'text' && block.text) {
            streamText += block.text;
            maybeUpdateStream();
          }
        }
      }

      // Handle content_block_delta for incremental text streaming
      if (streamingEnabled && event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
        streamText += event.delta.text;
        maybeUpdateStream();
      }
    }

    function maybeUpdateStream() {
      if (!streamingEnabled || !streamText) return;

      const now = Date.now();
      const newChars = streamText.length - lastStreamedLength;
      const timeSinceUpdate = now - lastStreamUpdate;

      if ((newChars >= 80 && timeSinceUpdate >= 4000) || (newChars > 0 && timeSinceUpdate >= 4000)) {
        updateStreamMessage(chatId, streamId, streamText, false);
        lastStreamUpdate = now;
        lastStreamedLength = streamText.length;
        streamedAnyText = true;
      }
    }

    function maybeSendProgress() {
      const now = Date.now();
      if (now - lastProgressSent < PROGRESS_THROTTLE_MS) return;
      if (!chatId || stopRequested) return;
      // Skip status messages when streaming text — the stream itself shows progress
      if (streamingEnabled && streamedAnyText) return;

      lastProgressSent = now;
      const elapsed = Math.floor((now - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;

      let statusMsg = `*${agentId}* (${mins}m${secs > 0 ? secs + 's' : ''})`;
      if (lastActivity) statusMsg += `\n${lastActivity}`;
      if (toolCount > 3) statusMsg += `\n${toolCount} operations`;

      sendReply(chatId, statusMsg);
      console.log(`[${agentId}] Progress: ${mins}m${secs}s — ${lastActivity} (${toolCount} ops)`);
    }

    // Fallback timer — fires if no tool-based or stream updates happened recently
    const progressTimer = setInterval(() => {
      if (stopRequested) return;
      // Skip fallback progress when streaming text
      if (streamingEnabled && streamedAnyText) return;
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      if (elapsed < 30) return; // Stay silent for first 30 seconds
      if (now - lastProgressSent < 20000) return; // Skip if recent update sent

      lastProgressSent = now;
      const mins = Math.floor(elapsed / 60);

      let statusMsg = `*${agentId}* working (${mins}m+)`;
      if (lastActivity) {
        statusMsg += `\nLast: ${lastActivity}`;
      }
      if (toolCount > 0) {
        statusMsg += `\n${toolCount} operations so far`;
      }
      statusMsg += `\n\nSend /stop to cancel.`;

      if (chatId) sendReply(chatId, statusMsg);
      console.log(`[${agentId}] Fallback progress: ${mins}m+`);
    }, FALLBACK_PROGRESS_MS);

    // 20 min hard timeout
    const timeoutTimer = setTimeout(() => {
      console.error(`[${agentId}] Timeout after 1200s — killing`);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    }, 1200000);

    proc.stdout.on('data', (data) => { processChunk(data.toString()); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      activeProcess = null;

      // Process any remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          hasStreamData = true;
          parsedEvents.push(event);
        } catch {}
      }

      sessionOwner.set(cwd, agentId);
      saveSessionOwners(sessionOwner);

      if (stopRequested) {
        // Send final stream update if we were streaming
        if (streamingEnabled && streamedAnyText) {
          updateStreamMessage(chatId, streamId, streamText || '[Agent stopped by user.]', true);
        }
        console.log(`[${agentId}] Stopped by user`);
        resolve({ text: '[Agent stopped by user. Partial work may have been saved.]', streamed: streamedAnyText });
        return;
      }

      // Send any remaining streamed text that wasn't flushed yet
      if (streamingEnabled && streamText && streamText.length > lastStreamedLength) {
        updateStreamMessage(chatId, streamId, streamText, false);
        streamedAnyText = true;
      }

      // Extract final response text
      let response;
      if (hasStreamData) {
        response = extractResultText(parsedEvents);
      }
      // Fallback: if stream-json parsing failed, treat raw stdout as text
      if (!response && rawStdout.trim()) {
        response = rawStdout.trim();
      }

      // ── Auto-continue on max_turns (regardless of exit code) ──
      const stopReason = hasStreamData ? extractStopReason(parsedEvents) : null;
      const hitMaxTurns = stopReason === 'max_turns' ||
        (rawStdout || '').includes('Reached max turns') ||
        (rawStdout || '').includes('max_turns') ||
        (stderr || '').includes('Reached max turns') ||
        (stderr || '').match(/Reached max turns\s*\(\d+\)/);
      if (hitMaxTurns) {
        const sessionId = existingSessionId || agentSessions[agentId]?.sessionId;
        if (sessionId) {
          console.log(`[${agentId}] Hit max_turns — auto-continuing session ${sessionId.slice(0, 8)}...`);
          if (chatId) {
            sendReply(chatId, `*${agentId}* hit turn limit — auto-continuing...`);
          }
          // Resume the same session with a "continue" prompt
          const continueArgs = [
            '-p', 'Continue where you left off. Complete the task.',
            '--verbose',
            '--output-format', 'stream-json',
            '--max-turns', '500',
            '--model', model,
            '--allowedTools', tools,
            '--resume', sessionId,
            '--append-system-prompt', systemPrompt
          ];
          if (fallbackModel && fallbackModel !== model) {
            continueArgs.push('--fallback-model', fallbackModel);
          }

          const contProc = spawn(CLAUDE_BIN, continueArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
          activeProcess = contProc;

          let contRaw = '';
          let contErr = '';
          const contEvents = [];
          let contLineBuffer = '';
          let contStreamText = streamText || ''; // carry over existing streamed text
          let contLastStreamUpdate = 0;
          let contLastStreamedLength = contStreamText.length;
          let contStreamedAny = streamedAnyText;
          const contStreamId = streamingEnabled ? `${Date.now()}-cont-${Math.random().toString(36).slice(2, 8)}` : null;
          const contStartTime = Date.now();
          let contLastProgressSent = 0;
          let contToolCount = toolCount;

          const contProgressTimer = setInterval(() => {
            if (stopRequested) return;
            if (streamingEnabled && contStreamedAny) return;
            const now = Date.now();
            const elapsed = Math.floor((now - contStartTime) / 1000);
            if (elapsed < 30 || now - contLastProgressSent < 20000) return;
            contLastProgressSent = now;
            const mins = Math.floor(elapsed / 60);
            if (chatId) sendReply(chatId, `*${agentId}* still working (${mins}m+, continued)\n\nSend /stop to cancel.`);
          }, FALLBACK_PROGRESS_MS);

          const contTimeoutTimer = setTimeout(() => {
            console.error(`[${agentId}] Continuation timeout after 1200s — killing`);
            contProc.kill('SIGTERM');
            setTimeout(() => { try { contProc.kill('SIGKILL'); } catch {} }, 5000);
          }, 1200000);

          contProc.stdout.on('data', (d) => {
            const chunk = d.toString();
            contRaw += chunk;
            contLineBuffer += chunk;
            const lines = contLineBuffer.split('\n');
            contLineBuffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                contEvents.push(event);
                if (streamingEnabled && event.type === 'assistant' && event.message?.content) {
                  for (const block of event.message.content) {
                    if (block.type === 'text' && block.text) contStreamText += block.text;
                    if (block.type === 'tool_use') contToolCount++;
                  }
                }
                if (streamingEnabled && event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
                  contStreamText += event.delta.text;
                }
                if (streamingEnabled && contStreamText) {
                  const now = Date.now();
                  const newChars = contStreamText.length - contLastStreamedLength;
                  if ((newChars >= 80 && now - contLastStreamUpdate >= 4000) || (newChars > 0 && now - contLastStreamUpdate >= 4000)) {
                    updateStreamMessage(chatId, contStreamId, contStreamText, false);
                    contLastStreamUpdate = now;
                    contLastStreamedLength = contStreamText.length;
                    contStreamedAny = true;
                  }
                }
              } catch {}
            }
          });
          contProc.stderr.on('data', (d) => { contErr += d.toString(); });

          contProc.on('close', (rc) => {
            clearInterval(contProgressTimer);
            clearTimeout(contTimeoutTimer);
            activeProcess = null;
            sessionOwner.set(cwd, agentId);
            saveSessionOwners(sessionOwner);

            if (contLineBuffer.trim()) {
              try { contEvents.push(JSON.parse(contLineBuffer)); } catch {}
            }

            let contResponse = extractResultText(contEvents);
            if (!contResponse && contRaw.trim()) contResponse = contRaw.trim();

            // Use continuation response if available, otherwise fall back to original
            const finalResponse = contResponse || response;

            if (finalResponse) {
              incrementSessionMessageCount(agentId);
              console.log(`[${agentId}] Continuation completed: ${finalResponse.length} chars (${contToolCount} total tool ops)`);
              appendDailyMemory(agentId, userMessage, finalResponse.length);

              if (streamingEnabled && contStreamedAny) {
                const cleanedCont = extractAndSendMedia(chatId, finalResponse, agentId);
                updateStreamMessage(chatId, contStreamId, cleanedCont, true);
                resolve({ text: finalResponse, streamed: true });
              } else {
                resolve({ text: finalResponse, streamed: false });
              }
            } else {
              console.error(`[${agentId}] Continuation failed (code ${rc}): ${contErr.slice(0, 200)}`);
              // Return original response from before the continuation
              if (response) {
                resolve({ text: response, streamed: streamedAnyText });
              } else {
                resolve({ text: `[${agentId} hit turn limit and continuation failed. Error: ${contErr.slice(0, 100)}]`, streamed: false });
              }
            }
          });
          return; // Don't fall through to normal result handling
        }
      }

      if (code === 0 && response) {
        // ── Session tracking: mark successful call ──
        incrementSessionMessageCount(agentId);
        console.log(`[${agentId}] ${response.length} chars (${toolCount} tool ops, stream: ${hasStreamData}, streamed: ${streamedAnyText}, session: ${(existingSessionId || agentSessions[agentId]?.sessionId || '?').slice(0, 8)})`);
        appendDailyMemory(agentId, userMessage, response.length);

        // Send final stream update OR prepare for outbox delivery
        if (streamingEnabled && streamedAnyText) {
          // Extract MEDIA: tags ONLY for streamed responses (tick() handles non-streamed)
          const mediaCleanedResponse = extractAndSendMedia(chatId, response, agentId);
          updateStreamMessage(chatId, streamId, mediaCleanedResponse, true);

          resolve({ text: response, streamed: true });
        } else {
          // Non-streamed: tick() will handle media extraction + outbox delivery
          resolve({ text: response, streamed: false });
        }
      } else if (isResume && code !== 0) {
        // ── --resume failed: session may be expired/corrupted ──
        console.log(`[${agentId}] --resume failed (code ${code}, stderr: ${stderr.slice(0, 100)}), starting fresh session`);

        const freshSessionId = createAgentSession(agentId);
        const freshArgs = [...baseArgs, '--session-id', freshSessionId, '--system-prompt', systemPrompt];

        if (chatId) {
          sendReply(chatId, `*${agentId}*'s previous session couldn't be resumed. Starting fresh context.\n\nYour message is being processed now.`);
        }

        const retryProc = spawn(CLAUDE_BIN, freshArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        activeProcess = retryProc;

        let retryRaw = '';
        let retryErr = '';
        const retryEvents = [];
        let retryLineBuffer = '';
        let retryStreamText = '';
        let retryLastStreamUpdate = 0;
        let retryLastStreamedLength = 0;
        let retryStreamedAny = false;
        const retryStreamId = streamingEnabled ? `${Date.now()}-retry-${Math.random().toString(36).slice(2, 8)}` : null;
        const retryStartTime = Date.now();
        let retryLastProgressSent = 0;
        let retryToolCount = 0;
        let retryLastActivity = '';

        // Progress timer for retry
        const retryProgressTimer = setInterval(() => {
          if (stopRequested) return;
          if (streamingEnabled && retryStreamedAny) return;
          const now = Date.now();
          const elapsed = Math.floor((now - retryStartTime) / 1000);
          if (elapsed < 30 || now - retryLastProgressSent < 20000) return;
          retryLastProgressSent = now;
          const mins = Math.floor(elapsed / 60);
          if (chatId) sendReply(chatId, `*${agentId}* working (${mins}m+, fresh session)\n\nSend /stop to cancel.`);
        }, FALLBACK_PROGRESS_MS);

        // 20 min timeout for retry
        const retryTimeoutTimer = setTimeout(() => {
          console.error(`[${agentId}] Retry timeout after 1200s — killing`);
          retryProc.kill('SIGTERM');
          setTimeout(() => { try { retryProc.kill('SIGKILL'); } catch {} }, 5000);
        }, 1200000);

        retryProc.stdout.on('data', (d) => {
          const chunk = d.toString();
          retryRaw += chunk;
          retryLineBuffer += chunk;
          const lines = retryLineBuffer.split('\n');
          retryLineBuffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              retryEvents.push(event);
              // Stream text extraction for retry
              if (streamingEnabled && event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text' && block.text) retryStreamText += block.text;
                  if (block.type === 'tool_use') { retryToolCount++; retryLastActivity = formatToolActivity(block.name, block.input); }
                }
              }
              if (streamingEnabled && event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
                retryStreamText += event.delta.text;
              }
              // Send stream updates
              if (streamingEnabled && retryStreamText) {
                const now = Date.now();
                const newChars = retryStreamText.length - retryLastStreamedLength;
                if ((newChars >= 80 && now - retryLastStreamUpdate >= 4000) || (newChars > 0 && now - retryLastStreamUpdate >= 4000)) {
                  updateStreamMessage(chatId, retryStreamId, retryStreamText, false);
                  retryLastStreamUpdate = now;
                  retryLastStreamedLength = retryStreamText.length;
                  retryStreamedAny = true;
                }
              }
            } catch {}
          }
        });
        retryProc.stderr.on('data', (d) => { retryErr += d.toString(); });

        retryProc.on('close', (rc) => {
          clearInterval(retryProgressTimer);
          clearTimeout(retryTimeoutTimer);
          activeProcess = null;
          sessionOwner.set(cwd, agentId);
          saveSessionOwners(sessionOwner);

          if (retryLineBuffer.trim()) {
            try { retryEvents.push(JSON.parse(retryLineBuffer)); } catch {}
          }

          let retryResponse = extractResultText(retryEvents);
          if (!retryResponse && retryRaw.trim()) retryResponse = retryRaw.trim();

          if (rc === 0 && retryResponse) {
            incrementSessionMessageCount(agentId);
            appendDailyMemory(agentId, userMessage, retryResponse.length);
            console.log(`[${agentId}] Fresh session succeeded: ${retryResponse.length} chars`);

            if (streamingEnabled && retryStreamedAny) {
              const cleanedRetry = extractAndSendMedia(chatId, retryResponse, agentId);
              updateStreamMessage(chatId, retryStreamId, cleanedRetry, true);
              resolve({ text: retryResponse, streamed: true });
            } else {
              resolve({ text: retryResponse, streamed: false });
            }
          } else {
            resetAgentSession(agentId);
            reject(new Error(`Claude failed after session reset: ${(retryErr || stderr).slice(0, 200)}`));
          }
        });

        retryProc.on('error', (err) => {
          clearInterval(retryProgressTimer);
          clearTimeout(retryTimeoutTimer);
          activeProcess = null;
          reject(err);
        });
      } else {
        // Non-resume failure — reset session state so next call starts clean
        resetAgentSession(agentId);
        reject(new Error(`Claude exited (${code}): ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      activeProcess = null;
      reject(err);
    });
  });
}

// Kill the active process (called by /stop)
function stopActiveProcess(chatId) {
  if (activeProcess) {
    stopRequested = true;
    console.log(`[${currentAgent}] /stop received — killing active process`);
    activeProcess.kill('SIGTERM');
    // Force kill after 3s if still alive
    setTimeout(() => {
      try { if (activeProcess) activeProcess.kill('SIGKILL'); } catch {}
    }, 3000);
    sendReply(chatId, `Stopping *${currentAgent}*... Send your next command.`);
    return true;
  } else {
    sendReply(chatId, `No active task running for *${currentAgent}*.`);
    return false;
  }
}

// ── Outbox ───────────────────────────────────────────────────────────────────
function sendReply(chatId, text, mediaPath = null, traceId = null) {
  const id = Date.now().toString();
  const payload = { chatId, text };
  if (mediaPath) payload.mediaPath = mediaPath;
  if (traceId) payload.traceId = traceId;
  // Use async write to avoid blocking event loop
  fsp.writeFile(path.join(OUTBOX_DIR, `${id}.json`), JSON.stringify(payload)).catch(
    e => console.error('[outbox] Write error:', e.message)
  );
}

// ── MEDIA: tag extraction ────────────────────────────────────────────────────
function extractAndSendMedia(chatId, text, agentId, traceId = null) {
  const mediaRegex = /MEDIA:(\.\/[^\s\n]+|\/[^\s\n]+)/g;
  const matches = [...text.matchAll(mediaRegex)];
  if (matches.length === 0) return text;

  const agentRoot = paths.agentDir(agentId);
  let counter = 0;
  for (const match of matches) {
    let filePath = match[1];
    // Resolve relative paths against agent root dir
    if (filePath.startsWith('./')) {
      filePath = path.join(agentRoot, filePath.slice(2));
    }
    if (fs.existsSync(filePath)) {
      // Send media via outbox with small delay offset to preserve ordering
      const mediaId = (Date.now() + counter).toString();
      const payload = { chatId, text: '', mediaPath: filePath };
      if (traceId) payload.traceId = traceId;
      fsp.writeFile(path.join(OUTBOX_DIR, `${mediaId}.json`), JSON.stringify(payload)).catch(
        e => console.error('[outbox] Media write error:', e.message)
      );
      console.log(`[${agentId}] Queued media: ${filePath}`);
      counter++;
    } else {
      console.error(`[${agentId}] MEDIA file not found: ${filePath}`);
    }
  }

  // Remove MEDIA: lines from text and clean up extra blank lines
  let cleaned = text;
  for (const match of matches) {
    cleaned = cleaned.replace(match[0], '');
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Command Handling ─────────────────────────────────────────────────────────
function handleCommand(msg) {
  if (msg.text === '/stop') {
    stopActiveProcess(msg.chatId);
    return true;
  }
  if (msg.text.startsWith('/switch')) {
    const requested = msg.text.split(/\s+/)[1];
    try {
      const agents = fs.readdirSync(AGENTS_DIR).filter(f =>
        fs.statSync(path.join(AGENTS_DIR, f)).isDirectory()
      );
      if (requested && agents.includes(requested)) {
        const prevAgent = currentAgent;
        currentAgent = requested;
        saveCurrentAgent(requested);

        // Session info for the target agent
        const session = agentSessions[requested];
        const hasSession = !!session?.sessionId;
        const msgCount = session?.messageCount || 0;

        let statusMsg = `Switched to *${requested}*.`;
        if (hasSession) {
          statusMsg += ` Resuming session (${msgCount} messages).`;
        } else {
          statusMsg += ` Fresh session.`;
        }
        sendReply(msg.chatId, statusMsg);
        console.log(`[switch] ${prevAgent} -> ${requested} (session: ${hasSession ? session.sessionId.slice(0, 8) : 'new'})`);
      } else {
        sendReply(msg.chatId, `Available: ${agents.join(', ')}\nUse: /switch <name>`);
      }
    } catch {
      sendReply(msg.chatId, 'Error reading agents directory.');
    }
    return true;
  }
  if (msg.text === '/reset') {
    // Force reset current agent's session — starts fresh on next message
    resetAgentSession(currentAgent);
    sendReply(msg.chatId, `Session reset for *${currentAgent}*. Next message starts a fresh conversation.`);
    return true;
  }
  if (msg.text === '/agents') {
    try {
      const agents = fs.readdirSync(AGENTS_DIR).filter(f =>
        fs.statSync(path.join(AGENTS_DIR, f)).isDirectory()
      );
      sendReply(msg.chatId, `Agents:\n- ${agents.join('\n- ')}\n\nCurrent: *${currentAgent}*`);
    } catch { sendReply(msg.chatId, 'Error listing agents.'); }
    return true;
  }
  if (msg.text.startsWith('/proxy')) {
    const arg = msg.text.split(/\s+/)[1];
    if (arg === '1') {
      setProxyMode(currentAgent, 1);
      sendReply(msg.chatId, `*${currentAgent}* -> original model (${resolveModel(currentAgent)})\n\nRate limit: agent's own config.`);
    } else if (arg === '2') {
      setProxyMode(currentAgent, 2);
      sendReply(msg.chatId, `*${currentAgent}* -> dynamic routing active\n\nSimple messages -> haiku (saves rate limit)\nComplex messages -> opus\n\nUse /proxy 1 to switch back.`);
    } else {
      const mode = getProxyMode(currentAgent);
      const proxied = getProxiedAgents();
      let statusMsg = `*${currentAgent}* proxy mode: ${mode === 2 ? 'Dynamic (mode 2)' : 'Original (mode 1)'}`;
      if (proxied.length > 0) {
        statusMsg += `\n\nAgents on dynamic routing: ${proxied.join(', ')}`;
      }
      statusMsg += `\n\nCommands:\n- /proxy 1 — original model\n- /proxy 2 — dynamic (haiku/opus)`;
      sendReply(msg.chatId, statusMsg);
    }
    return true;
  }
  if (msg.text === '/status') {
    const uptime = Math.floor(process.uptime());
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const session = agentSessions[currentAgent];
    const sessionInfo = session
      ? `Session: ${session.sessionId.slice(0, 8)}... (${session.messageCount || 0} msgs)`
      : 'Session: none (will create on next message)';
    const proxyMode = getProxyMode(currentAgent);
    const proxyInfo = proxyMode === 2 ? 'Dynamic (haiku/opus)' : 'Original';
    sendReply(msg.chatId, `Agent: *${currentAgent}*\nModel: ${resolveModel(currentAgent)}\nProxy: ${proxyInfo}\n${sessionInfo}\nUptime: ${uptime}s\nMemory: ${memMB}MB\n\nCommands: /switch /stop /reset /proxy /agents`);
    return true;
  }
  return false;
}

// ── Cron Integration ─────────────────────────────────────────────────────────
let cronModule = null;

async function loadCron() {
  try {
    cronModule = await import('../cron/scheduler.js');
    console.log('[cron] Scheduler loaded');
  } catch (e) {
    console.error('[cron] Failed to load scheduler:', e.message);
  }
}

async function cronTick() {
  if (!cronModule) return;
  try {
    const config = loadConfig();
    if (!config.cron?.enabled) return;

    const dueJobs = cronModule.getDueJobs();
    for (const job of dueJobs) {
      console.log(`[cron] Running job "${job.name}" for agent ${job.agentId}`);
      try {
        const message = job.payload?.message || job.name;
        const result = await callClaude(message, job.agentId, null);
        const response = result.text;

        // Deliver to Telegram if configured
        if (job.delivery?.mode === 'announce' || job.delivery?.mode === 'direct') {
          try {
            const lines = fs.readFileSync(INBOX, 'utf-8').trim().split('\n').filter(Boolean).reverse();
            for (const line of lines) {
              const msg = JSON.parse(line);
              if (msg.chatId) {
                sendReply(msg.chatId, `*Scheduled: ${job.name}*\n\n${response}`);
                break;
              }
            }
          } catch {}
        }

        cronModule.recordRun(job, 'success', null, response);
      } catch (err) {
        console.error(`[cron] Job "${job.name}" failed:`, err.message);
        cronModule.recordRun(job, 'error', err.message);
      }
    }
  } catch (e) {
    console.error('[cron] Tick error:', e.message);
  }
}

// ── Gateway Integration ──────────────────────────────────────────────────────
let gatewayModule = null;

async function loadGateway() {
  try {
    gatewayModule = await import('../bridge/gateway.js');
    const config = loadConfig();
    if (config.gateway?.enabled) {
      // Provide bridge interface to gateway
      gatewayModule.setBridge({
        sendAgentMessage: async (agentId, message, chatId) => {
          const result = await callClaude(message, agentId, null);
          return result.text;
        },
        sendAgentToAgent: async (fromAgent, toAgent, message) => {
          const taggedMessage = `[Message from agent "${fromAgent}"]: ${message}`;
          const result = await callClaude(taggedMessage, toAgent, null);
          return result.text;
        },
        getActiveBotCount: () => 1,
        getBotStatuses: () => ({ [currentAgent]: { active: true } })
      });
      gatewayModule.startGateway(config);
      console.log('[gateway] API started');
    }
  } catch (e) {
    console.error('[gateway] Failed to load:', e.message);
  }
}

// ── Delivery Queue Integration ───────────────────────────────────────────────
let deliveryModule = null;

async function loadDeliveryQueue() {
  try {
    deliveryModule = await import('../bridge/delivery-queue.js');
    console.log('[delivery] Queue module loaded');
  } catch (e) {
    console.error('[delivery] Failed to load:', e.message);
  }
}

async function processDeliveryQueue() {
  if (!deliveryModule) return;
  try {
    const config = loadConfig();
    if (!config.deliveryQueue?.enabled) return;

    const pending = deliveryModule.getPending();
    for (const item of pending) {
      try {
        if (item.type === 'agent-message') {
          const result = await callClaude(item.message, item.agentId, null);
          deliveryModule.markAttempt(item.id);
        } else if (item.type === 'telegram-message' && item.chatId) {
          sendReply(item.chatId, item.message);
          deliveryModule.markAttempt(item.id);
        } else {
          deliveryModule.markAttempt(item.id, `Unknown type: ${item.type}`);
        }
      } catch (err) {
        deliveryModule.markAttempt(item.id, err.message);
      }
    }
  } catch (e) {
    console.error('[delivery] Queue error:', e.message);
  }
}

// ── Main Loop ────────────────────────────────────────────────────────────────
let processing = false;
let callCount = 0;
let errorCount = 0;

async function tick() {
  let inboxContent;
  try {
    inboxContent = await fsp.readFile(INBOX, 'utf-8');
  } catch { return; }

  let lines = inboxContent.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return;

  const processed = getProcessed();

  // ALWAYS check for critical commands even while processing
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (processed.has(msg.id)) continue;
      if (msg.text === '/stop' || msg.text.startsWith('/switch') || msg.text === '/reset') {
        markProcessed(msg.id);
        handleCommand(msg);
      }
    } catch {}
  }

  // Don't start new work if already processing
  if (processing) return;

  const pending = [];
  let chatId = null;
  let mediaPath = null;

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (processed.has(msg.id)) continue;
      if (!msg.text || msg.text.startsWith('/start')) {
        markProcessed(msg.id);
        continue;
      }
      if (msg.text.startsWith('/')) {
        markProcessed(msg.id);
        handleCommand(msg);
        continue;
      }
      pending.push(msg);
      chatId = msg.chatId;
      if (msg.mediaPath) mediaPath = msg.mediaPath;
    } catch (e) {
      console.error('[parse] Error:', e.message);
    }
  }

  if (pending.length === 0) return;

  for (const msg of pending) markProcessed(msg.id);

  // Build combined text, including media references
  let combinedText;
  if (pending.length === 1) {
    combinedText = pending[0].text;
    if (pending[0].mediaPath) {
      combinedText = `[Media file at: ${pending[0].mediaPath}${pending[0].fileName ? ` (${pending[0].fileName})` : ''}]\n\n${combinedText}`;
    }
  } else {
    combinedText = pending.map((m, i) => {
      let text = `[Message ${i + 1}]: ${m.text}`;
      if (m.mediaPath) {
        text = `[Message ${i + 1} + media at: ${m.mediaPath}${m.fileName ? ` (${m.fileName})` : ''}]: ${m.text}`;
      }
      return text;
    }).join('\n\n');
    console.log(`[${currentAgent}] Batching ${pending.length} queued messages`);
  }

  const taskStartTime = Date.now();
  const traceId = pending[0]?.traceId || newTraceId();
  const trace = createTrace('watcher', 'process', traceId);
  const log = tracedLogger(trace);
  processing = true;
  try {
    await fsp.writeFile(PROCESSING_FILE, JSON.stringify({
      chatId,
      agent: currentAgent,
      traceId,
      startedAt: new Date().toISOString()
    }));
    const result = await callClaude(combinedText, currentAgent, chatId, mediaPath);

    if (result.streamed) {
      log.log(`Response delivered via streaming (${result.text.length} chars)`);
    } else {
      const cleanedText = extractAndSendMedia(chatId, result.text, currentAgent, traceId);
      sendReply(chatId, cleanedText, null, traceId);
    }
    callCount++;

    // ── Completion signal ──
    const elapsed = Math.floor((Date.now() - taskStartTime) / 1000);
    if (elapsed >= 25) {
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
      sendReply(chatId, `*${currentAgent}* finished (${timeStr})`);
    }
  } catch (err) {
    const errMsg = err.message || '';
    const nonFatalPatterns = [
      /no stdin data received/i,
      /redirect stdin explicitly/i,
      /When using --print/i,
      /--output-format/i,
      /proceeding without it/i
    ];
    const isNonFatal = nonFatalPatterns.some(p => p.test(errMsg));
    if (isNonFatal) {
      console.log(`[${currentAgent}] Suppressed non-fatal CLI warning:`, errMsg.slice(0, 150));
    } else {
      console.error(`[${currentAgent}] Error:`, errMsg.slice(0, 300));
      errorCount++;
      const elapsed = Math.floor((Date.now() - taskStartTime) / 1000);
      const timeStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
      sendReply(chatId, `*${currentAgent}* failed after ${timeStr}\n\n_${errMsg.slice(0, 100)}_\n\nSend your message again to retry.`);
    }
  } finally {
    fsp.unlink(PROCESSING_FILE).catch(() => {});
    processing = false;
  }
}

// ── Health Heartbeat ─────────────────────────────────────────────────────────
function writeHealth() {
  // Build compact session summary
  const sessionSummary = {};
  for (const [aid, sess] of Object.entries(agentSessions)) {
    sessionSummary[aid] = { id: sess.sessionId?.slice(0, 8), msgs: sess.messageCount || 0 };
  }
  fsp.writeFile(HEALTH_FILE, JSON.stringify({
    alive: true,
    version: '4.2-tamerclaw',
    agent: currentAgent,
    model: resolveModel(currentAgent),
    uptime: Math.floor(process.uptime()),
    calls: callCount,
    errors: errorCount,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    sessions: sessionSummary,
    cron: !!cronModule,
    gateway: !!gatewayModule,
    delivery: !!deliveryModule,
    ts: new Date().toISOString()
  }, null, 2)).catch(() => {});
}

// ── Cleanup (every 5 min) ────────────────────────────────────────────────────
function cleanup() {
  trimProcessed(500);
  rotateInbox();
  cleanStaleStreamFiles();
  writeHealth();
}

/**
 * Clean stale stream-outbox files that are older than 60 seconds.
 */
function cleanStaleStreamFiles() {
  try {
    const files = fs.readdirSync(STREAM_OUTBOX_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const f of files) {
      if (!f.endsWith('.json') && !f.endsWith('.msgid') && !f.endsWith('.tmp')) continue;
      const fp = path.join(STREAM_OUTBOX_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (!processing && (now - stat.mtimeMs) > 60000) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`[cleanup] Removed ${cleaned} stale stream-outbox files`);
  } catch {}
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[watcher] ${signal} — shutting down`);
  writeHealth();
  saveSessionOwners(sessionOwner);
  saveAgentSessions(agentSessions);
  try { fs.unlinkSync(PROCESSING_FILE); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  errorCount++;
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  errorCount++;
});

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  console.log('=======================================');
  console.log('   TamerClaw Relay Watcher v4.2');
  console.log('=======================================');
  console.log(`Agent: ${currentAgent} | Model: ${resolveModel(currentAgent)}`);
  console.log(`Workspace: ${getProjectWorkspace(currentAgent)}`);
  console.log(`Tracked sessions: ${Object.keys(agentSessions).length}`);
  for (const [aid, sess] of Object.entries(agentSessions)) {
    console.log(`  ${aid}: ${sess.sessionId.slice(0, 8)}... (${sess.messageCount || 0} msgs, started ${sess.startedAt})`);
  }

  // Load optional modules
  await loadCron();
  await loadGateway();
  await loadDeliveryQueue();

  // Check shared files
  const soul = readSharedFile('SOUL.md');
  const policy = readSharedFile('GLOBAL_POLICY.md');
  console.log(`Shared: SOUL.md=${soul ? 'loaded' : 'missing'} GLOBAL_POLICY.md=${policy ? 'loaded' : 'missing'}`);

  console.log('');
  writeHealth();

  // Main message loop
  setInterval(tick, 2000);

  // Cron tick (every 30s)
  const config = loadConfig();
  const cronInterval = config.cron?.tickIntervalMs || 30000;
  setInterval(cronTick, cronInterval);

  // Delivery queue (every 60s)
  const deliveryInterval = config.deliveryQueue?.retryIntervalMs || 60000;
  setInterval(processDeliveryQueue, deliveryInterval);

  // Cleanup (every 5 min)
  setInterval(cleanup, 300000);
}

start();
