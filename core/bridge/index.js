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
import { auditEvent } from './audit-log.js';
import { readConfigCached, writeFileAtomic, readJSONSafe, ensureDir, appendFile } from '../shared/async-fs.js';
import { createTrace, tracedLogger, newTraceId } from '../shared/trace.js';
import { getProxyMode, setProxyMode, resolveProxyModel, getProxiedAgents } from '../shared/proxy.js';
import os from 'os';
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
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[FATAL] Config not found: ${CONFIG_PATH}`);
    console.error('Run: tamerclaw init');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function loadConfigAsync() {
  return readConfigCached(CONFIG_PATH);
}

// ── Session Restore ───────────────────────────────────────────────────────
async function restoreSessionsFromDisk(config) {
  let restored = 0;
  for (const agentId of Object.keys(config.agents)) {
    // Check multiple directories for session files
    const sessionDirs = [
      getSessionDir(agentId),                                              // tamerclaw user dir
    ];
    for (const sessionDir of sessionDirs) {
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
              // Populate agentChatIds so session counts are accurate after restore
              if (!agentChatIds.has(agentId)) agentChatIds.set(agentId, new Set());
              agentChatIds.get(agentId).add(chatId);
            }
          } catch {}
        }
      } catch {} // sessionDir may not exist
    }
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
  // Check multiple session directories
  const candidates = [
    path.join(getSessionDir(agentId), `${chatId}.json`),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch { continue; }
    }
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
function resolveModelConfig(agentId, config, messageText) {
  const agent = config.agents[agentId] || {};
  let rawModel = agent.model || config.defaults?.model || 'claude-sonnet-4-6';

  // Dynamic model routing: pick model based on message complexity
  if (rawModel === 'dynamic' && agent.modelRouting) {
    const routing = agent.modelRouting;
    const msg = (messageText || '').toLowerCase();
    const patterns = routing.complexPatterns || [];
    const isComplex = patterns.some(p => msg.includes(p)) || msg.length > 500;
    rawModel = isComplex ? routing.complex : (routing.default || routing.simple);
  }

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
function resolveModel(agentId, config, messageText) {
  const mc = resolveModelConfig(agentId, config, messageText);
  return mc.modelId;
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
  const mc = resolveModelConfig(agentId, config, message);

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
  const tmpDir = paths.tmp;
  await ensureDir(tmpDir);
  const cwd = agent?.legacyWorkspace || agent?.workspace || path.join(tmpDir, 'claude-sandbox');
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

  const payloadFile = path.join(tmpDir, `claude-agent-${agentId}-openai-payload.json`);
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
    env.HOME = process.env.HOME || os.homedir();

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
  let modelFlag = mc.cliFlag || 'sonnet';
  const log = tracedLogger(trace || createTrace('bridge', 'claude-cli'));

  // Check proxy mode — dynamic routing overrides the model
  const proxyResult = resolveProxyModel(agentId, modelFlag, message);
  if (proxyResult.proxied) {
    modelFlag = proxyResult.model;
    log.log(`Proxy mode 2: ${proxyResult.complexity} → ${modelFlag}`);
  }

  // Build system prompt and write to temp file (avoids arg length issues)
  const systemPrompt = await buildSystemPromptAsync(agentId);
  const tmpDir = paths.tmp;
  await ensureDir(tmpDir);
  const systemPromptFile = path.join(tmpDir, `claude-agent-${agentId}-system.md`);
  await fsp.writeFile(systemPromptFile, systemPrompt);

  // Build the user message
  let userMessage = message;
  if (mediaPath) {
    userMessage = `[Media file at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
  }

  // Use agent's legacy workspace as cwd so Claude Code has project context
  const agent = config.agents[agentId];
  const cwd = agent?.legacyWorkspace || agent?.workspace || path.join(tmpDir, 'claude-sandbox');
  await ensureDir(cwd);

  log.log(`Calling claude code (model: ${modelFlag}) for chat ${chatId} in ${cwd}...`);

  // Write prompt to temp file to avoid shell escaping issues
  const promptFile = path.join(tmpDir, `claude-agent-${agentId}-prompt.txt`);
  await fsp.writeFile(promptFile, userMessage);

  // ── Helper: extract text from stream-json events ──
  function extractText(events) {
    const texts = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'result' && ev.result) {
        // result event contains the final assistant message
        const content = Array.isArray(ev.result) ? ev.result : (ev.result.content || []);
        for (const block of content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
        if (texts.length) return texts.join('\n\n');
      }
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
      }
    }
    return texts.length ? texts.join('\n\n') : null;
  }

  function extractStopReason(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'result' && events[i].stop_reason) return events[i].stop_reason;
    }
    return null;
  }

  function extractSessionId(events) {
    for (const ev of events) {
      if (ev.session_id) return ev.session_id;
    }
    return null;
  }

  // ── Spawn Claude CLI with stream-json for proper stop_reason detection ──
  function spawnClaude(promptText, extraArgs = []) {
    const tools = 'Read Write Edit Bash Glob Grep Agent WebSearch WebFetch';
    const args = [
      '-p', promptText,
      '--output-format', 'stream-json',
      '--max-turns', '500',
      '--model', modelFlag,
      '--allowedTools', tools,
      '--append-system-prompt', systemPrompt,
      ...extraArgs
    ];

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
    }
    env.HOME = process.env.HOME || os.homedir();

    return spawn('claude', args, { cwd, env });
  }

  // ── Run a single Claude call and parse stream-json ──
  function runClaude(promptText, extraArgs = []) {
    return new Promise((resolveRun, rejectRun) => {
      const proc = spawnClaude(promptText, extraArgs);
      let rawStdout = '';
      let stderr = '';
      const parsedEvents = [];
      let lineBuffer = '';

      const timer = setTimeout(() => {
        console.error(`[${agentId}] Timeout after 600s — killing`);
        proc.kill('SIGTERM');
      }, 600000); // 10 min timeout

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        rawStdout += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { parsedEvents.push(JSON.parse(line)); } catch {}
        }
      });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        // Parse any remaining buffered line
        if (lineBuffer.trim()) {
          try { parsedEvents.push(JSON.parse(lineBuffer)); } catch {}
        }
        resolveRun({ code, rawStdout, stderr, parsedEvents });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        rejectRun(err);
      });

      activeCalls.set(sessionKey, proc);
    });
  }

  // ── Main execution with auto-continue on max_turns ──
  try {
    let result = await runClaude(userMessage);
    let response = extractText(result.parsedEvents);
    if (!response && result.rawStdout.trim()) response = result.rawStdout.trim();

    // Detect max_turns — either from stream-json stop_reason or from error text
    const stopReason = extractStopReason(result.parsedEvents);
    const hitMaxTurns = stopReason === 'max_turns' ||
      (result.rawStdout || '').includes('Reached max turns') ||
      (result.stderr || '').includes('Reached max turns');

    if (result.code === 0 && hitMaxTurns) {
      const sessionId = extractSessionId(result.parsedEvents);
      if (sessionId) {
        log.log(`[${agentId}] Hit max_turns — auto-continuing session ${sessionId.slice(0, 8)}...`);
        const contResult = await runClaude('Continue where you left off. Complete the task.', ['--resume', sessionId]);
        const contResponse = extractText(contResult.parsedEvents);
        if (contResult.code === 0 && contResponse) {
          log.log(`✅ Continuation: ${contResponse.length} chars`);
          appendToMemoryAsync(agentId, `Chat ${chatId}: ${message.slice(0, 100)}... → responded (continued)`).catch(() => {});
          activeCalls.delete(sessionKey);
          return contResponse;
        }
        // Fall through to original response if continuation failed
        if (contResponse) response = contResponse;
      } else {
        log.log(`[${agentId}] Hit max_turns but no session_id — returning partial response`);
      }
    }

    activeCalls.delete(sessionKey);

    if (result.code === 0 && response) {
      log.log(`✅ Response: ${response.length} chars`);
      appendToMemoryAsync(agentId, `Chat ${chatId}: ${message.slice(0, 100)}... → responded`).catch(() => {});
      return response;
    } else {
      const errMsg = result.stderr.trim() || `Claude exited with code ${result.code}`;
      console.error(`[${agentId}] Error (code ${result.code}): ${errMsg.slice(0, 500)}`);
      throw new Error(errMsg.slice(0, 200));
    }
  } catch (err) {
    activeCalls.delete(sessionKey);
    console.error(`[${agentId}] Spawn error:`, err.message);
    throw err;
  }
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

async function sendAgentMessage(agentId, message, chatId = null, mediaPath = null) {
  chatId = chatId || `api:${Date.now()}`;
  const response = await callClaude(agentId, chatId, message, mediaPath);

  // ── Track session history & persist to disk (same as Telegram path) ──
  try {
    const key = getSessionKey(agentId, chatId);
    if (!sessions.has(key)) {
      sessions.set(key, { history: [], lastActivity: new Date().toISOString() });
    }
    // Track this chatId for the agent (so getAgentSessions finds it)
    if (!agentChatIds.has(agentId)) agentChatIds.set(agentId, new Set());
    agentChatIds.get(agentId).add(chatId);

    const sess = sessions.get(key);
    const now = new Date().toISOString();
    sess.history.push({ role: 'user', content: message, timestamp: now });
    sess.history.push({ role: 'assistant', content: response, timestamp: now });
    sess.lastActivity = now;
    if (sess.history.length > 100) {
      sess.history = sess.history.slice(-100);
    }
    saveSessionAsync(agentId, chatId, sess).catch(e =>
      console.error(`[${agentId}] API session save failed:`, e.message)
    );
  } catch (sessErr) {
    console.error(`[${agentId}] API session tracking error:`, sessErr.message);
  }

  // ── Relay MEDIA: tags to Telegram (so images arrive even when sent via API/app) ──
  try {
    const mediaRegex = /MEDIA:(\.\/[^\s\n]+|\/[^\s\n]+)/g;
    const mediaMatches = [...(response || '').matchAll(mediaRegex)];
    if (mediaMatches.length > 0) {
      // Find a bot to send with: prefer the agent's own bot, fall back to any bot
      const bot = bots.get(agentId) || bots.values().next().value;
      const config = loadConfig();
      const ownerChatId = config.owner?.telegramChatId || '5270157750';
      if (bot) {
        for (const match of mediaMatches) {
          let filePath = match[1];
          if (fs.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            try {
              if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                await bot.sendPhoto(ownerChatId, filePath, {
                  caption: `📎 From ${agentId}: ${path.basename(filePath)}`
                });
              } else if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
                await bot.sendVideo(ownerChatId, filePath);
              } else {
                await bot.sendDocument(ownerChatId, filePath);
              }
              console.log(`[${agentId}] Relayed media to Telegram: ${filePath}`);
            } catch (err) {
              console.error(`[${agentId}] Failed to relay media to Telegram: ${err.message}`);
            }
          } else {
            console.error(`[${agentId}] Media relay: file not found: ${filePath}`);
          }
        }
      }
    }
  } catch (relayErr) {
    console.error(`[${agentId}] Media relay error:`, relayErr.message);
  }

  return response;
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

      // ── Track session history & persist to disk ──
      try {
        if (!sessions.has(key)) {
          sessions.set(key, { history: [], lastActivity: new Date().toISOString() });
        }
        const sess = sessions.get(key);
        const now = new Date().toISOString();
        sess.history.push({ role: 'user', content: combined, timestamp: now });
        sess.history.push({ role: 'assistant', content: response, timestamp: now });
        sess.lastActivity = now;
        // Keep max 100 messages per session to avoid unbounded growth
        if (sess.history.length > 100) {
          sess.history = sess.history.slice(-100);
        }
        saveSessionAsync(agentId, chatId, sess).catch(e =>
          console.error(`[${agentId}] Session save failed:`, e.message)
        );
      } catch (sessErr) {
        console.error(`[${agentId}] Session tracking error:`, sessErr.message);
      }
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
        // Try to resolve relative path against agent directories
        let resolved = false;
        try {
          const agentNames = fs.readdirSync(paths.agents);
          for (const agentName of agentNames) {
            const candidate = path.join(paths.agents, agentName, filePath.slice(2));
            if (fs.existsSync(candidate)) {
              filePath = candidate;
              resolved = true;
              break;
            }
          }
        } catch {}
        if (!resolved) {
          // Try CWD as fallback
          const cwdResolved = path.resolve(filePath);
          if (fs.existsSync(cwdResolved)) filePath = cwdResolved;
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
  // Skip agents that have standalone bot services (they poll their own token)
  const standaloneAgents = config.standaloneAgents || [];
  if (standaloneAgents.includes(agentId)) {
    console.log(`[${agentId}] Standalone service — skipping (has own systemd service)`);
    return null;
  }

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

    if (!msg.text && !msg.photo && !msg.document && !msg.voice && !msg.video && !msg.audio && !msg.video_note) return;

    // Handle commands
    if (msg.text) {
      // /start command
      if (msg.text.startsWith('/start')) {
        const agentListStr = isShared
          ? `Available agents: ${[...bot._sharedAgents].join(', ')}\nUse /switch <agent> to change.`
          : '';
        await bot.sendMessage(msg.chat.id,
          `🤖 *${targetAgent}* agent online.\nPowered by Claude Code.\n\n${agentListStr}\nSend me anything and I'll help.\n\nType /help for commands.`,
          { parse_mode: 'Markdown' }
        );
        savePairing(targetAgent, msg.from.id, msg.from.username);
        return;
      }

      // /help command
      if (msg.text === '/help') {
        await bot.sendMessage(msg.chat.id,
          `*${targetAgent}* — Commands\n\n` +
          `/help — Show this help\n` +
          `/status — System status\n` +
          `/agents — List all agents\n\n` +
          `Just send a message to talk to me. I can handle text, photos, voice notes, documents, and video.`,
          { parse_mode: 'Markdown' }
        );
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
        const proxyMode = getProxyMode(targetAgent);
        const proxyInfo = proxyMode === 2 ? 'Dynamic (haiku/opus)' : 'Original';
        await bot.sendMessage(msg.chat.id,
          `Agent: *${targetAgent}*\nProxy: ${proxyInfo}\nUptime: ${uptime}s\nActive bots: ${botCount}\nSessions: ${sessionCount}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // /proxy command — switch between original model and dynamic routing
      if (msg.text.startsWith('/proxy')) {
        const arg = msg.text.split(/\s+/)[1];
        if (arg === '1') {
          setProxyMode(targetAgent, 1);
          const config2 = loadConfig();
          const origModel = config2.agents[targetAgent]?.model || config2.defaults?.model || 'sonnet';
          await bot.sendMessage(msg.chat.id,
            `*${targetAgent}* → original model (${origModel})\n\nRate limit: agent's own config.`,
            { parse_mode: 'Markdown' }
          );
        } else if (arg === '2') {
          setProxyMode(targetAgent, 2);
          await bot.sendMessage(msg.chat.id,
            `*${targetAgent}* → dynamic routing active\n\n- Simple messages → haiku (saves rate limit)\n- Complex messages → opus\n\nUse /proxy 1 to switch back.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          const mode = getProxyMode(targetAgent);
          const proxied = getProxiedAgents();
          let statusMsg = `*${targetAgent}* proxy mode: ${mode === 2 ? 'Dynamic (mode 2)' : 'Original (mode 1)'}`;
          if (proxied.length > 0) {
            statusMsg += `\n\nAgents on dynamic routing: ${proxied.join(', ')}`;
          }
          statusMsg += `\n\nCommands:\n- /proxy 1 — original model\n- /proxy 2 — dynamic (haiku/opus)`;
          await bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'Markdown' });
        }
        return;
      }

      // /stop command — kill active Claude CLI process for this chat
      if (msg.text === '/stop') {
        const sessionKey = getSessionKey(targetAgent, msg.chat.id);
        const proc = activeCalls.get(sessionKey);
        if (proc) {
          proc.kill('SIGTERM');
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
          activeCalls.delete(sessionKey);
          await bot.sendMessage(msg.chat.id, `Stopped *${targetAgent}*.`, { parse_mode: 'Markdown' });
        } else {
          await bot.sendMessage(msg.chat.id, `No active task for *${targetAgent}*.`, { parse_mode: 'Markdown' });
        }
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
      try {
        mediaPath = await downloadMedia(bot, msg.voice.file_id, targetAgent);
        if (!text) text = '[Voice message]';
      }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    } else if (msg.video) {
      try { mediaPath = await downloadMedia(bot, msg.video.file_id, targetAgent); }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    } else if (msg.audio) {
      try { mediaPath = await downloadMedia(bot, msg.audio.file_id, targetAgent); }
      catch (e) { console.error(`[${targetAgent}] Media download failed:`, e.message); }
    } else if (msg.video_note) {
      try { mediaPath = await downloadMedia(bot, msg.video_note.file_id, targetAgent); }
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
  stopAgent: (agentId, chatId) => {
    // Stop active Claude CLI process for this agent+chat
    if (chatId) {
      const sessionKey = getSessionKey(agentId, chatId);
      const proc = activeCalls.get(sessionKey);
      if (proc) {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
        activeCalls.delete(sessionKey);
        return { stopped: true, chatId };
      }
    }
    // If no chatId, stop ALL active calls for this agent
    let stopped = 0;
    for (const [key, proc] of activeCalls.entries()) {
      if (key.startsWith(`${agentId}:`)) {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
        activeCalls.delete(key);
        stopped++;
      }
    }
    return { stopped: stopped > 0, count: stopped };
  },
  enqueueDelivery: enqueue,
  getDeliveryQueue: getPending,
  getActiveBotCount: () => bots.size,
  getBotStatuses: () => {
    const statuses = {};
    for (const [id] of bots) {
      statuses[id] = { active: true, sessions: agentChatIds.get(id)?.size || 0 };
    }
    return statuses;
  },
  getAgentSessions: (agentId) => {
    const result = [];
    const chatIds = agentChatIds.get(agentId) || new Set();
    for (const chatId of chatIds) {
      const key = getSessionKey(agentId, chatId);
      const sess = sessions.get(key);
      if (sess) {
        const history = sess.history || [];
        const lastMsg = history.length > 0 ? history[history.length - 1] : null;
        const firstMsg = history.length > 0 ? history[0] : null;
        result.push({
          chatId: String(chatId),
          messageCount: history.length,
          lastActivity: sess.lastActivity || null,
          startedAt: firstMsg?.timestamp || sess.lastActivity || null,
          summary: lastMsg ? (lastMsg.content || lastMsg.text || '').substring(0, 120) : '',
          preview: firstMsg ? (firstMsg.content || firstMsg.text || '').substring(0, 80) : '',
        });
      }
    }
    // Also check disk sessions not in memory — scan multiple directories
    const seenChatIds = new Set([...chatIds].map(String));
    const sessionDirs = [
      getSessionDir(agentId),                                              // tamerclaw user dir
    ];
    for (const sessionDir of sessionDirs) {
      try {
        if (!fs.existsSync(sessionDir)) continue;
        const files = fs.readdirSync(sessionDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const chatId = path.basename(file, '.json');
          if (seenChatIds.has(String(chatId))) continue;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf-8'));
            const history = data.history || [];
            const lastMsg = history.length > 0 ? history[history.length - 1] : null;
            const firstMsg = history.length > 0 ? history[0] : null;
            result.push({
              chatId: String(chatId),
              messageCount: history.length,
              lastActivity: data.lastActivity || null,
              startedAt: firstMsg?.timestamp || data.lastActivity || null,
              summary: lastMsg ? (lastMsg.content || lastMsg.text || '').substring(0, 120) : '',
              preview: firstMsg ? (firstMsg.content || firstMsg.text || '').substring(0, 80) : '',
            });
            seenChatIds.add(String(chatId));
          } catch {}
        }
      } catch {}
    }
    // Sort by lastActivity descending
    result.sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    });
    return result;
  },
  getSessionHistory: (agentId, chatId) => {
    const key = getSessionKey(agentId, chatId);
    let sess = sessions.get(key);
    if (!sess) {
      // Try loading from disk
      sess = loadSession(agentId, chatId);
    }
    if (!sess) return null;
    const history = (sess.history || []).map(msg => ({
      role: msg.role || (msg.isUser ? 'user' : 'assistant'),
      content: msg.content || msg.text || '',
      timestamp: msg.timestamp || null,
    }));
    return {
      chatId: String(chatId),
      agentId,
      messageCount: history.length,
      lastActivity: sess.lastActivity || null,
      messages: history,
    };
  },
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
