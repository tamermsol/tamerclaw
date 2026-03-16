/**
 * Claude Agents Telegram Bridge v2.0 — Tamerclaw
 *
 * Features:
 * - Multi-bot Telegram routing with shared token fallback
 * - Cron scheduler with at/recurring jobs
 * - HTTP gateway API (port 19789)
 * - Delivery queue with retry logic
 * - Agent-to-agent communication
 * - Per-agent model config with fallback chain
 * - Credential/allowlist management
 * - Config audit logging
 * - Subagent spawning
 * - Media handling
 * - Session persistence
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';
import TelegramBot from 'node-telegram-bot-api';
import { getDueJobs, recordRun, loadJobs } from '../cron/scheduler.js';
import { startGateway, setBridge } from './gateway.js';
import { enqueue, getPending, markAttempt } from './delivery-queue.js';
import { auditEvent, readConfigAudited } from './audit-log.js';
import { readConfigCached, writeConfigAtomic, writeFileAtomic, readJSONSafe, ensureDir, appendFile, exists as asyncExists } from '../shared/async-fs.js';
import { createTrace, tracedLogger, stampMessage, extractTrace, newTraceId } from '../shared/trace.js';
import paths from '../shared/paths.js';

const CONFIG_PATH = paths.config;
const SHARED_DIR = paths.shared;
const CREDENTIALS_DIR = paths.credentials;

// ── State ──────────────────────────────────────────────────────────────────
const bots = new Map();           // agentId → TelegramBot instance
const sessions = new Map();       // `${agentId}:${chatId}` → { history, lastActivity }
const activeCalls = new Map();    // `${agentId}:${chatId}` → child process
const messageBuffers = new Map(); // `${agentId}:${chatId}` → { messages[], timer }
const agentChatIds = new Map();   // agentId → Set of known chatIds

// ── Config ─────────────────────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function loadConfigAsync() {
  return readConfigCached(CONFIG_PATH);
}

// ── Session Restore ───────────────────────────────────────────────────────
async function restoreSessionsFromDisk(config) {
  let restored = 0;
  for (const agentId of Object.keys(config.agents)) {
    const sessionDir = getSessionDir(agentId);
    try {
      const files = await fsp.readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const chatId = path.basename(file, '.json');
          const key = getSessionKey(agentId, chatId);
          if (!sessions.has(key)) {
            const data = JSON.parse(await fsp.readFile(path.join(sessionDir, file), 'utf-8'));
            sessions.set(key, data);
            restored++;
          }
        } catch {}
      }
    } catch {} // sessionDir may not exist
  }
  if (restored > 0) console.log(`[sessions] Restored ${restored} sessions from disk`);
}

// ── Credentials / Allowlists ───────────────────────────────────────────────
function ensureCredentialsDir() {
  if (!fs.existsSync(CREDENTIALS_DIR)) fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
}

function getAllowlist(agentId) {
  ensureCredentialsDir();
  const filePath = path.join(CREDENTIALS_DIR, `telegram-${agentId}-allowFrom.json`);
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { return { allowAll: true }; }
  }
  // Check default
  const defaultPath = path.join(CREDENTIALS_DIR, 'telegram-default-allowFrom.json');
  if (fs.existsSync(defaultPath)) {
    try { return JSON.parse(fs.readFileSync(defaultPath, 'utf-8')); }
    catch { return { allowAll: true }; }
  }
  return { allowAll: true };
}

function isUserAllowed(agentId, userId) {
  const allowlist = getAllowlist(agentId);
  if (allowlist.allowAll) return true;
  if (allowlist.users && Array.isArray(allowlist.users)) {
    return allowlist.users.includes(userId) || allowlist.users.includes(String(userId));
  }
  return true;
}

function savePairing(agentId, userId, username) {
  ensureCredentialsDir();
  const filePath = path.join(CREDENTIALS_DIR, `telegram-pairing.json`);
  let pairings = {};
  if (fs.existsSync(filePath)) {
    try { pairings = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { pairings = {}; }
  }
  pairings[`${agentId}:${userId}`] = {
    agentId, userId, username,
    pairedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(pairings, null, 2));
}

// ── Memory ─────────────────────────────────────────────────────────────────
function getMemoryDir(agentId) {
  return paths.memory(agentId);
}

function getTodayMemoryPath(agentId) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(getMemoryDir(agentId), `${today}.md`);
}

function appendToMemory(agentId, entry) {
  const memDir = getMemoryDir(agentId);
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
  const memPath = getTodayMemoryPath(agentId);
  const timestamp = new Date().toISOString().slice(11, 19);
  fs.appendFileSync(memPath, `\n[${timestamp}] ${entry}\n`);
}

async function appendToMemoryAsync(agentId, entry) {
  const memDir = getMemoryDir(agentId);
  await ensureDir(memDir);
  const memPath = getTodayMemoryPath(agentId);
  const timestamp = new Date().toISOString().slice(11, 19);
  await appendFile(memPath, `\n[${timestamp}] ${entry}\n`);
}

// ── Session Management ─────────────────────────────────────────────────────
function getSessionKey(agentId, chatId) {
  return `${agentId}:${chatId}`;
}

function getSessionDir(agentId) {
  return paths.sessions(agentId);
}

function saveSession(agentId, chatId, data) {
  const dir = getSessionDir(agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${chatId}.json`), JSON.stringify(data, null, 2));
}

async function saveSessionAsync(agentId, chatId, data) {
  const dir = getSessionDir(agentId);
  await ensureDir(dir);
  await writeFileAtomic(path.join(dir, `${chatId}.json`), JSON.stringify(data, null, 2));
}

function loadSession(agentId, chatId) {
  const filePath = path.join(getSessionDir(agentId), `${chatId}.json`);
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { return null; }
  }
  return null;
}

async function loadSessionAsync(agentId, chatId) {
  return readJSONSafe(path.join(getSessionDir(agentId), `${chatId}.json`));
}

// ── Model Resolution ───────────────────────────────────────────────────────

/**
 * Resolve full model configuration for an agent.
 * Returns { provider, modelId, cliFlag, api, baseUrl, envKey, maxTokens }
 *
 * Supports:
 *   - "claude-opus-4-6"           → provider "anthropic" (inferred)
 *   - "deepseek-chat"             → provider "deepseek" (inferred)
 *   - "deepseek/deepseek-coder"   → explicit provider/model
 */
function resolveModelConfig(agentId, config) {
  const rawModel = config.agents[agentId]?.model || config.defaults?.model || 'claude-sonnet-4-6';

  let provider = null;
  let modelId = rawModel;
  if (rawModel.includes('/')) {
    const parts = rawModel.split('/');
    provider = parts[0];
    modelId = parts.slice(1).join('/');
  }

  const providers = config.models?.providers || {};
  if (!provider) {
    for (const [pName, pConfig] of Object.entries(providers)) {
      if (pConfig.models && pConfig.models[modelId]) {
        provider = pName;
        break;
      }
    }
  }

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

// Legacy shim — returns raw model ID string
function resolveModel(agentId, config) {
  const agent = config.agents[agentId];
  if (agent?.model) return agent.model;
  return config.defaults?.model || 'claude-sonnet-4-6';
}

// ── System Prompt Builder ──────────────────────────────────────────────────
function buildSystemPrompt(agentId) {
  const config = loadConfig();
  const agent = config.agents[agentId];
  const parts = [];

  // Load IDENTITY
  if (agent?.identity && fs.existsSync(agent.identity)) {
    parts.push(fs.readFileSync(agent.identity, 'utf-8'));
  }

  // Load shared SOUL
  const soulPath = path.join(SHARED_DIR, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    parts.push(fs.readFileSync(soulPath, 'utf-8'));
  }

  // Load shared global policy
  const policyPath = path.join(SHARED_DIR, 'GLOBAL_POLICY.md');
  if (fs.existsSync(policyPath)) {
    parts.push(fs.readFileSync(policyPath, 'utf-8'));
  }

  // Load USER.md
  const userPath = paths.agentUser(agentId);
  if (fs.existsSync(userPath)) {
    parts.push(fs.readFileSync(userPath, 'utf-8'));
  }

  // Load TOOLS.md
  const toolsPath = paths.agentTools(agentId);
  if (fs.existsSync(toolsPath)) {
    parts.push(fs.readFileSync(toolsPath, 'utf-8'));
  }

  // Load MEMORY.md (long-term, cap at 3000 chars)
  const memoryMdPath = paths.agentMemoryMd(agentId);
  if (fs.existsSync(memoryMdPath)) {
    const content = fs.readFileSync(memoryMdPath, 'utf-8');
    parts.push('# Long-term Memory\n' + content.slice(0, 3000));
  }

  // Load today's memory
  const todayMem = getTodayMemoryPath(agentId);
  if (fs.existsSync(todayMem)) {
    const content = fs.readFileSync(todayMem, 'utf-8');
    parts.push(`# Today's Memory (${new Date().toISOString().slice(0, 10)})\n` + content.slice(-2000));
  }

  // Load yesterday's memory
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yestPath = path.join(getMemoryDir(agentId), `${yesterday}.md`);
  if (fs.existsSync(yestPath)) {
    const content = fs.readFileSync(yestPath, 'utf-8');
    parts.push(`# Yesterday's Memory (${yesterday})\n` + content.slice(-1000));
  }

  // Agent-to-agent capability notice
  if (config.tools?.agentToAgent?.enabled) {
    const agentList = Object.keys(config.agents).filter(id => id !== agentId).join(', ');
    parts.push(`# Inter-Agent Communication\nYou can request messages be sent to other agents. Available agents: ${agentList}`);
  }

  return parts.join('\n\n---\n\n');
}

async function buildSystemPromptAsync(agentId) {
  const config = await loadConfigAsync();
  const agent = config.agents[agentId];
  const parts = [];

  const tryRead = async (p) => {
    try { return await fsp.readFile(p, 'utf-8'); } catch { return null; }
  };

  if (agent?.identity) {
    const content = await tryRead(agent.identity);
    if (content) parts.push(content);
  }

  for (const name of ['SOUL.md', 'GLOBAL_POLICY.md']) {
    const content = await tryRead(path.join(SHARED_DIR, name));
    if (content) parts.push(content);
  }

  const userContent = await tryRead(paths.agentUser(agentId));
  if (userContent) parts.push(userContent);

  const toolsContent = await tryRead(paths.agentTools(agentId));
  if (toolsContent) parts.push(toolsContent);

  const memoryMd = await tryRead(paths.agentMemoryMd(agentId));
  if (memoryMd) parts.push('# Long-term Memory\n' + memoryMd.slice(0, 3000));

  const todayMem = await tryRead(getTodayMemoryPath(agentId));
  if (todayMem) parts.push(`# Today's Memory (${new Date().toISOString().slice(0, 10)})\n` + todayMem.slice(-2000));

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yestMem = await tryRead(path.join(getMemoryDir(agentId), `${yesterday}.md`));
  if (yestMem) parts.push(`# Yesterday's Memory (${yesterday})\n` + yestMem.slice(-1000));

  if (config.tools?.agentToAgent?.enabled) {
    const agentList = Object.keys(config.agents).filter(id => id !== agentId).join(', ');
    parts.push(`# Inter-Agent Communication\nYou can request messages be sent to other agents. Available agents: ${agentList}`);
  }

  return parts.join('\n\n---\n\n');
}

// ── Claude Code Execution (Full CLI — like talking to Claude Code) ─────────
async function callClaude(agentId, chatId, message, mediaPath = null, traceId = null) {
  const trace = createTrace('bridge', 'callClaude', traceId);
  const log = tracedLogger(trace);
  const config = await loadConfigAsync();
  const mc = resolveModelConfig(agentId, config);

  // Route to OpenAI-compatible provider (DeepSeek, Ollama, etc.)
  if (mc.api === 'openai-compatible') {
    return callOpenAICompatible(agentId, chatId, message, mc, config, mediaPath, trace);
  }

  // Default: Claude CLI path
  return callClaudeCLI(agentId, chatId, message, mc, config, mediaPath, trace);
}

/**
 * Call an OpenAI-compatible API (DeepSeek, Ollama, etc.)
 */
async function callOpenAICompatible(agentId, chatId, message, mc, config, mediaPath = null, trace = null) {
  const sessionKey = getSessionKey(agentId, chatId);
  const log = tracedLogger(trace || createTrace('bridge', 'openai-compat'));
  const systemPrompt = await buildSystemPromptAsync(agentId);

  let userMessage = message;
  if (mediaPath) {
    userMessage = `[Media file at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
  }

  const agent = config.agents[agentId];
  const cwd = agent?.legacyWorkspace || agent?.workspace || '/tmp/claude-sandbox';
  await ensureDir(cwd);

  log.log(`Calling ${mc.provider}/${mc.modelId} for chat ${chatId}...`);

  const payload = {
    model: mc.modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: mc.maxTokens,
    temperature: 0.7,
    stream: false
  };

  const payloadFile = `/tmp/claude-agent-${agentId}-openai-payload.json`;
  await fsp.writeFile(payloadFile, JSON.stringify(payload));

  return new Promise((resolve, reject) => {

    const apiKeyEnv = mc.envKey || `${mc.provider.toUpperCase()}_API_KEY`;
    const apiKey = process.env[apiKeyEnv] || '';

    if (!apiKey) {
      reject(new Error(`Missing API key: set ${apiKeyEnv} environment variable for ${mc.provider}`));
      return;
    }

    const baseUrl = (mc.baseUrl || '').replace(/\/$/, '');
    const endpoint = `${baseUrl}/v1/chat/completions`;

    const curlCmd = `curl -s -X POST "${endpoint}" -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d @${payloadFile}`;

    const env = { ...process.env };
    env.HOME = '/root';

    const proc = spawn('bash', ['-c', curlCmd], { cwd, env });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      console.error(`[${agentId}] ${mc.provider} API timeout after 300s — killing`);
      proc.kill('SIGTERM');
    }, 300000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeCalls.delete(sessionKey);

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(`${mc.provider} API error: ${result.error.message || JSON.stringify(result.error)}`));
          return;
        }
        const response = result.choices?.[0]?.message?.content;
        if (response) {
          log.log(`✅ ${mc.provider}/${mc.modelId}: ${response.length} chars`);
          appendToMemoryAsync(agentId, `Chat ${chatId}: ${message.slice(0, 100)}... → responded (${mc.provider})`).catch(() => {});
          resolve(response);
        } else {
          reject(new Error(`${mc.provider} returned empty response`));
        }
      } catch (e) {
        reject(new Error(`${mc.provider} response parse error: ${e.message}. Raw: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeCalls.delete(sessionKey);
      reject(err);
    });

    activeCalls.set(sessionKey, proc);
  });
}

/**
 * Call Claude via the Claude CLI (original path).
 */
async function callClaudeCLI(agentId, chatId, message, mc, config, mediaPath = null, trace = null) {
  const sessionKey = getSessionKey(agentId, chatId);
  const modelFlag = mc.cliFlag || 'sonnet';
  const log = tracedLogger(trace || createTrace('bridge', 'claude-cli'));

  // Build system prompt and write to temp file (avoids arg length issues)
  const systemPrompt = await buildSystemPromptAsync(agentId);
  const systemPromptFile = `/tmp/claude-agent-${agentId}-system.md`;
  await fsp.writeFile(systemPromptFile, systemPrompt);

  // Build the user message
  let userMessage = message;
  if (mediaPath) {
    userMessage = `[Media file at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
  }

  // Use agent's legacy workspace as cwd so Claude Code has project context
  const agent = config.agents[agentId];
  const cwd = agent?.legacyWorkspace || agent?.workspace || '/tmp/claude-sandbox';
  await ensureDir(cwd);

  log.log(`Calling claude code (model: ${modelFlag}) for chat ${chatId} in ${cwd}...`);

  // Write prompt to temp file to avoid shell escaping issues
  const promptFile = `/tmp/claude-agent-${agentId}-prompt.txt`;
  await fsp.writeFile(promptFile, userMessage);

  return new Promise((resolve, reject) => {

    const args = [
      '-p', userMessage,
      '--output-format', 'text',
      '--max-turns', '5',
      '--model', modelFlag,
      '--append-system-prompt', systemPrompt
    ];

    // Inherit full environment but remove CLAUDE* vars that cause nesting detection
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') {
        delete env[key];
      }
    }
    // Ensure HOME is set for OAuth credential lookup
    env.HOME = '/root';

    const proc = spawn('claude', args, { cwd, env });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      console.error(`[${agentId}] Timeout after 300s — killing`);
      proc.kill('SIGTERM');
    }, 300000); // 5 min timeout

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeCalls.delete(sessionKey);

      if (code === 0 && stdout.trim()) {
        const response = stdout.trim();
        log.log(`✅ Response: ${response.length} chars`);
        appendToMemoryAsync(agentId, `Chat ${chatId}: ${message.slice(0, 100)}... → responded`).catch(() => {});
        resolve(response);
      } else {
        const errMsg = stderr.trim() || `Claude exited with code ${code}`;
        console.error(`[${agentId}] Error (code ${code}): ${errMsg.slice(0, 500)}`);
        reject(new Error(errMsg.slice(0, 200)));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeCalls.delete(sessionKey);
      console.error(`[${agentId}] Spawn error:`, err.message);
      reject(err);
    });

    activeCalls.set(sessionKey, proc);
  });
}

// ── Agent-to-Agent Communication ───────────────────────────────────────────
async function sendAgentToAgent(fromAgent, toAgent, message) {
  const config = loadConfig();
  if (!config.tools?.agentToAgent?.enabled) {
    throw new Error('Agent-to-agent communication is disabled');
  }
  const taggedMessage = `[Message from agent "${fromAgent}"]: ${message}`;
  const chatId = `agent:${fromAgent}`;
  return callClaude(toAgent, chatId, taggedMessage);
}

async function sendAgentMessage(agentId, message, chatId = null) {
  chatId = chatId || `api:${Date.now()}`;
  return callClaude(agentId, chatId, message);
}

// ── Subagent Spawning ──────────────────────────────────────────────────────
const subagentRuns = new Map(); // runId → { parentAgent, childAgent, status, result }

async function spawnSubagent(parentAgentId, task, childModel = null) {
  const runId = crypto.randomUUID();
  const config = loadConfig();
  const model = childModel || resolveModel(parentAgentId, config);

  subagentRuns.set(runId, {
    parentAgent: parentAgentId,
    task,
    model,
    status: 'running',
    startedAt: new Date().toISOString(),
    result: null
  });

  console.log(`[${parentAgentId}] Spawning subagent (run: ${runId.slice(0, 8)})`);

  try {
    const response = await callClaude(parentAgentId, `subagent:${runId}`, task);
    subagentRuns.get(runId).status = 'completed';
    subagentRuns.get(runId).result = response;
    subagentRuns.get(runId).completedAt = new Date().toISOString();
    return { runId, response };
  } catch (err) {
    subagentRuns.get(runId).status = 'failed';
    subagentRuns.get(runId).error = err.message;
    throw err;
  }
}

// ── Message Debouncing ─────────────────────────────────────────────────────
function debounceMessage(agentId, chatId, message, bot, mediaPath = null, traceId = null) {
  const key = getSessionKey(agentId, chatId);
  const config = loadConfig();
  const debounceMs = config.telegram?.debounceMs || 2000;
  const msgTraceId = traceId || newTraceId();

  if (!messageBuffers.has(key)) {
    messageBuffers.set(key, { messages: [], timer: null, mediaPath: null });
  }

  const buffer = messageBuffers.get(key);
  buffer.messages.push(message);
  if (mediaPath) buffer.mediaPath = mediaPath;

  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(async () => {
    const combined = buffer.messages.join('\n');
    const media = buffer.mediaPath;
    messageBuffers.delete(key);

    try { await bot.sendChatAction(chatId, 'typing'); } catch {}

    try {
      const response = await callClaude(agentId, chatId, combined, media, msgTraceId);
      await sendLongMessage(bot, chatId, response);
    } catch (err) {
      console.error(`[${agentId}] Error:`, err.message);
      await bot.sendMessage(chatId, `⚠️ Error: ${err.message.slice(0, 200)}`);
    }
  }, debounceMs);
}

// ── Telegram Message Splitting ─────────────────────────────────────────────
async function sendLongMessage(bot, chatId, text) {
  // Extract and send MEDIA: tags as photos/documents before sending text
  const mediaRegex = /MEDIA:(\.\/[^\s\n]+|\/[^\s\n]+)/g;
  const mediaMatches = [...text.matchAll(mediaRegex)];

  if (mediaMatches.length > 0) {
    // Remove MEDIA: lines from text
    let cleanText = text;
    for (const match of mediaMatches) {
      cleanText = cleanText.replace(match[0], '').trim();
    }
    // Clean up empty lines left behind
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    // Send each media file
    for (const match of mediaMatches) {
      let filePath = match[1];
      // Resolve relative paths against agent workspace
      if (filePath.startsWith('./')) {
        // Try to find the agent workspace from context
        // The MEDIA: path is relative to the agent's root dir
        const agentDirs = [paths.agents];
        for (const dir of agentDirs) {
          try {
            const candidates = fs.readdirSync(dir).map(d => path.join(dir, d));
            for (const candidate of candidates) {
              const resolved = path.join(candidate, filePath.slice(2));
              if (fs.existsSync(resolved)) {
                filePath = resolved;
                break;
              }
            }
          } catch {}
          if (path.isAbsolute(filePath) && !filePath.startsWith('./')) break;
        }
      }

      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        try {
          if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
            await bot.sendPhoto(chatId, filePath);
          } else if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
            await bot.sendVideo(chatId, filePath);
          } else {
            await bot.sendDocument(chatId, filePath);
          }
          console.log(`[bridge] Sent media: ${filePath}`);
        } catch (err) {
          console.error(`[bridge] Failed to send media ${filePath}:`, err.message);
        }
        await new Promise(r => setTimeout(r, 300));
      } else {
        console.error(`[bridge] Media file not found: ${filePath}`);
      }
    }

    // If no text left after removing media tags, we're done
    if (!cleanText) return;
    text = cleanText;
  }

  const MAX_LEN = 4096;
  if (text.length <= MAX_LEN) {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(chatId, text)
    );
    return;
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.3) splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.3) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(chatId, chunk)
    );
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── Media Handling ─────────────────────────────────────────────────────────
async function downloadMedia(bot, fileId, agentId) {
  const mediaDir = paths.agentMedia(agentId);
  await ensureDir(mediaDir);

  const file = await bot.getFile(fileId);
  const ext = path.extname(file.file_path) || '.bin';
  const localPath = path.join(mediaDir, `${Date.now()}${ext}`);

  const fileStream = await bot.getFileStream(fileId);
  const writeStream = fs.createWriteStream(localPath);

  return new Promise((resolve, reject) => {
    fileStream.pipe(writeStream);
    writeStream.on('finish', () => resolve(localPath));
    writeStream.on('error', reject);
  });
}

// ── Bot Initialization ─────────────────────────────────────────────────────
function startBot(agentId, agentConfig, config) {
  // Use agent-specific token, or shared token for testing
  const token = agentConfig.botToken || config.telegram?.sharedBotToken;

  if (!token) {
    console.log(`[${agentId}] No bot token configured — skipping`);
    return null;
  }

  // If using shared token, only start one bot instance for it
  const isShared = !agentConfig.botToken && token === config.telegram?.sharedBotToken;
  if (isShared) {
    // Check if another agent already started a bot with this shared token
    for (const [existingId, existingBot] of bots) {
      if (existingBot._sharedToken === token) {
        console.log(`[${agentId}] Sharing bot with ${existingId} (shared token)`);
        // Register this agent to receive messages from the shared bot
        if (!existingBot._sharedAgents) existingBot._sharedAgents = new Set();
        existingBot._sharedAgents.add(agentId);
        return existingBot;
      }
    }
  }

  console.log(`[${agentId}] Starting Telegram bot${isShared ? ' (shared token)' : ''}...`);

  const bot = new TelegramBot(token, {
    polling: {
      interval: config.telegram?.pollingInterval || 1000,
      autoStart: true,
      params: { timeout: 10, allowed_updates: ['message', 'callback_query'] }
    }
  });

  if (isShared) {
    bot._sharedToken = token;
    bot._sharedAgents = new Set([agentId]);
    bot._primaryAgent = agentId;
  }

  // Text messages
  bot.on('message', async (msg) => {
    const targetAgent = isShared ? (bot._currentAgent || agentId) : agentId;
    console.log(`[${targetAgent}] 📩 message: chat=${msg.chat.id} text="${(msg.text || '[media]').slice(0, 50)}" from=${msg.from?.username || msg.from?.id}`);

    if (!msg.text && !msg.photo && !msg.document && !msg.voice && !msg.video) return;

    // Handle commands
    if (msg.text) {
      // /start command
      if (msg.text.startsWith('/start')) {
        const agentListStr = isShared
          ? `Available agents: ${[...bot._sharedAgents].join(', ')}\nUse /switch <agent> to change.`
          : '';
        await bot.sendMessage(msg.chat.id,
          `🤖 *${targetAgent}* agent online.\nPowered by Claude Code.\n\n${agentListStr}\nSend me anything and I'll help.`,
          { parse_mode: 'Markdown' }
        );
        savePairing(targetAgent, msg.from.id, msg.from.username);
        return;
      }

      // /switch command for shared token mode
      if (msg.text.startsWith('/switch') && isShared) {
        const requested = msg.text.split(/\s+/)[1];
        if (requested && bot._sharedAgents.has(requested)) {
          bot._currentAgent = requested;
          await bot.sendMessage(msg.chat.id, `Switched to *${requested}* agent.`, { parse_mode: 'Markdown' });
        } else {
          const available = [...bot._sharedAgents].join(', ');
          await bot.sendMessage(msg.chat.id, `Usage: /switch <agent>\nAvailable: ${available}`);
        }
        return;
      }

      // /agents command
      if (msg.text === '/agents') {
        const config2 = loadConfig();
        const list = Object.keys(config2.agents).join('\n• ');
        await bot.sendMessage(msg.chat.id, `Configured agents:\n• ${list}`);
        return;
      }

      // /status command
      if (msg.text === '/status') {
        const uptime = Math.floor(process.uptime());
        const botCount = bots.size;
        const sessionCount = sessions.size;
        await bot.sendMessage(msg.chat.id,
          `System status:\nUptime: ${uptime}s\nActive bots: ${botCount}\nSessions: ${sessionCount}`
        );
        return;
      }
    }

    // Check allowlist
    if (!isUserAllowed(targetAgent, msg.from.id)) {
      console.log(`[${targetAgent}] Blocked message from ${msg.from.id} (not in allowlist)`);
      return;
    }

    const chatId = msg.chat.id;
    let mediaPath = null;
    let text = msg.text || msg.caption || '';

    // Track chat IDs per agent
    if (!agentChatIds.has(targetAgent)) agentChatIds.set(targetAgent, new Set());
    agentChatIds.get(targetAgent).add(chatId);

    // Handle media
    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      try { mediaPath = await downloadMedia(bot, largest.file_id, targetAgent); }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    } else if (msg.document) {
      try { mediaPath = await downloadMedia(bot, msg.document.file_id, targetAgent); }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    } else if (msg.voice) {
      try { mediaPath = await downloadMedia(bot, msg.voice.file_id, targetAgent); }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    } else if (msg.video) {
      try { mediaPath = await downloadMedia(bot, msg.video.file_id, targetAgent); }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    }

    if (!text && !mediaPath) return;

    debounceMessage(targetAgent, chatId, text, bot, mediaPath);
  });

  // Callback queries (inline buttons)
  bot.on('callback_query', async (query) => {
    const targetAgent = isShared ? (bot._currentAgent || agentId) : agentId;
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);
    debounceMessage(targetAgent, chatId, `[Button pressed: ${query.data}]`, bot);
  });

  bot.on('polling_error', (err) => {
    console.error(`[${agentId}] Polling error:`, err.message);
  });

  console.log(`[${agentId}] ✅ Bot started`);
  return bot;
}

// ── Cron Tick ──────────────────────────────────────────────────────────────
async function cronTick() {
  const dueJobs = getDueJobs();
  if (dueJobs.length === 0) return;

  for (const job of dueJobs) {
    console.log(`[cron] Running job "${job.name}" for agent ${job.agentId}`);
    try {
      const message = job.payload?.message || job.name;
      const response = await callClaude(job.agentId, `cron:${job.id}`, message);

      // Deliver response via Telegram if agent has a known chat
      if (job.delivery?.mode === 'announce' || job.delivery?.mode === 'direct') {
        const chatIds = agentChatIds.get(job.agentId);
        if (chatIds?.size > 0) {
          const bot = bots.get(job.agentId);
          if (bot) {
            for (const chatId of chatIds) {
              await sendLongMessage(bot, chatId, response);
            }
          }
        }
      }

      recordRun(job, 'success', null, response);
    } catch (err) {
      console.error(`[cron] Job "${job.name}" failed:`, err.message);
      recordRun(job, 'error', err.message);
    }
  }
}

// ── Delivery Queue Processor ───────────────────────────────────────────────
async function processDeliveryQueue() {
  const pending = getPending();
  for (const item of pending) {
    try {
      if (item.type === 'agent-message') {
        await callClaude(item.agentId, item.chatId || `delivery:${item.id}`, item.message);
        markAttempt(item.id);
      } else if (item.type === 'telegram-message') {
        const bot = bots.get(item.agentId);
        if (bot && item.chatId) {
          await sendLongMessage(bot, item.chatId, item.message);
          markAttempt(item.id);
        } else {
          markAttempt(item.id, 'Bot or chatId not available');
        }
      } else {
        markAttempt(item.id, `Unknown delivery type: ${item.type}`);
      }
    } catch (err) {
      markAttempt(item.id, err.message);
    }
  }
}

// ── Bridge Interface (exposed to gateway) ──────────────────────────────────
const bridgeInterface = {
  sendAgentMessage,
  sendAgentToAgent,
  spawnSubagent,
  enqueueDelivery: enqueue,
  getDeliveryQueue: getPending,
  getActiveBotCount: () => bots.size,
  getBotStatuses: () => {
    const statuses = {};
    for (const [id] of bots) {
      statuses[id] = { active: true, sessions: agentChatIds.get(id)?.size || 0 };
    }
    return statuses;
  }
};

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Claude Agents Bridge v2.1              ║');
  console.log('║   Async I/O + Tracing + Session Restore  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  auditEvent('startup', { version: '2.1' });

  const config = loadConfig();

  // Restore sessions from disk (survives restarts)
  await restoreSessionsFromDisk(config);
  const singleAgent = process.argv.find(a => a.startsWith('--agent='));

  // Start gateway
  setBridge(bridgeInterface);
  startGateway(config);

  // Start bots
  let agentsToStart = Object.entries(config.agents);
  if (singleAgent) {
    const id = singleAgent.split('=')[1];
    agentsToStart = agentsToStart.filter(([k]) => k === id);
  }

  let started = 0;
  let skipped = 0;

  for (const [agentId, agentConfig] of agentsToStart) {
    const bot = startBot(agentId, agentConfig, config);
    if (bot) {
      bots.set(agentId, bot);
      started++;
    } else {
      skipped++;
    }
  }

  console.log('');
  console.log(`Started: ${started} bots | Skipped: ${skipped} (no token)`);

  // Start cron scheduler
  if (config.cron?.enabled) {
    const tickInterval = config.cron.tickIntervalMs || 30000;
    setInterval(cronTick, tickInterval);
    console.log(`[cron] ✅ Scheduler active (tick every ${tickInterval / 1000}s)`);
  }

  // Start delivery queue processor
  if (config.deliveryQueue?.enabled) {
    const retryInterval = config.deliveryQueue.retryIntervalMs || 60000;
    setInterval(processDeliveryQueue, retryInterval);
    console.log(`[delivery] ✅ Queue processor active (check every ${retryInterval / 1000}s)`);
  }

  console.log('');
  console.log('Waiting for messages...');

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    auditEvent('shutdown');
    for (const [id, bot] of bots) {
      console.log(`[${id}] Stopping...`);
      bot.stopPolling();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
