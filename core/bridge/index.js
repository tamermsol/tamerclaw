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
 *
 * v1.15.0 "Prometheus" — Claude Code architecture integration:
 * - Tool Registry (structured tool definitions with permissions)
 * - Command Registry (slash command framework)
 * - Hook System (lifecycle pre/post hooks)
 * - Smart Memory Recall (AI-powered context selection)
 * - Feature Flags (conditional feature loading)
 * - Echo Dedup (message deduplication)
 *
 * v1.16.0 "Titan" — All Claude models online + Mac Mini compute tools:
 * - Direct Anthropic SDK client (Opus/Sonnet/Haiku, streaming, tool use)
 * - Smart Model Router (complexity-based routing, fallback chain)
 * - Compute Tools (Mac Mini as registered tools: Whisper, FFmpeg, Flutter, etc.)
 * - Cost tracking, rate limit downshift, provider health monitoring
 * - Ollama fallback (local + Mac Mini M1)
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

// ── Claude Code Architecture Modules (v1.15.0) ───────────────────────────
import { getEngine } from '../shared/claude-engine.js';
import { feature } from '../shared/feature-flags.js';
import { HOOK_EVENTS } from '../shared/hooks.js';

const CONFIG_PATH = paths.config;
const SHARED_DIR = paths.shared;
const CREDENTIALS_DIR = paths.credentials;

// ── Claude Engine (v1.15.0) ────────────────────────────────────────────────
const engine = getEngine();

// ── State ──────────────────────────────────────────────────────────────────
const bots = new Map();           // agentId → TelegramBot instance
const sessions = new Map();       // `${agentId}:${chatId}` → { history, lastActivity }
const activeCalls = new Map();    // `${agentId}:${chatId}` → child process
const messageBuffers = new Map(); // `${agentId}:${chatId}` → { messages[], timer }
const agentChatIds = new Map();   // agentId → Set of known chatIds
const approvedTools = new Map();  // agentId → Set of approved tool names
const pendingPermissions = new Map(); // `perm:${agentId}:${chatId}:${nonce}` → { toolName, message, mediaPath, bot }

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
  if (!config.agents) return restored;
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

async function buildSystemPromptAsync(agentId, userMessage = null) {
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

  // v1.15.0: Smart Memory Recall — AI-powered context selection
  if (feature('SMART_MEMORY_RECALL') && userMessage) {
    try {
      const memorySection = await engine.buildMemoryPrompt(agentId, userMessage);
      if (memorySection) parts.push(memorySection);
    } catch (err) {
      console.error(`[${agentId}] Smart recall failed, falling back to flat memory:`, err.message);
      // Fallback to legacy memory loading below
      const memoryMd = await tryRead(paths.agentMemoryMd(agentId));
      if (memoryMd) parts.push('# Long-term Memory\n' + memoryMd.slice(0, 3000));

      const todayMem = await tryRead(getTodayMemoryPath(agentId));
      if (todayMem) parts.push(`# Today's Memory (${new Date().toISOString().slice(0, 10)})\n` + todayMem.slice(-2000));

      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yestMem = await tryRead(path.join(getMemoryDir(agentId), `${yesterday}.md`));
      if (yestMem) parts.push(`# Yesterday's Memory (${yesterday})\n` + yestMem.slice(-1000));
    }
  } else {
    // Legacy memory loading
    const memoryMd = await tryRead(paths.agentMemoryMd(agentId));
    if (memoryMd) parts.push('# Long-term Memory\n' + memoryMd.slice(0, 3000));

    const todayMem = await tryRead(getTodayMemoryPath(agentId));
    if (todayMem) parts.push(`# Today's Memory (${new Date().toISOString().slice(0, 10)})\n` + todayMem.slice(-2000));

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yestMem = await tryRead(path.join(getMemoryDir(agentId), `${yesterday}.md`));
    if (yestMem) parts.push(`# Yesterday's Memory (${yesterday})\n` + yestMem.slice(-1000));
  }

  // v1.15.0: Tool registry prompt section
  if (feature('TOOL_REGISTRY')) {
    parts.push(engine.tools.toPromptSection());
  }

  if (config.tools?.agentToAgent?.enabled) {
    const agentList = Object.keys(config.agents).filter(id => id !== agentId).join(', ');
    parts.push(`# Inter-Agent Communication\nYou can request messages be sent to other agents. Available agents: ${agentList}`);
  }

  return parts.join('\n\n---\n\n');
}

// ── Claude Code Execution (Full CLI — like talking to Claude Code) ─────────
async function callClaude(agentId, chatId, message, mediaPath = null, traceId = null, streamCtx = null) {
  const trace = createTrace('bridge', 'callClaude', traceId);
  const log = tracedLogger(trace);
  const config = await loadConfigAsync();
  const mc = resolveModelConfig(agentId, config, message);

  // Route to OpenAI-compatible provider (DeepSeek, Ollama, etc.)
  if (mc.api === 'openai-compatible') {
    return callOpenAICompatible(agentId, chatId, message, mc, config, mediaPath, trace);
  }

  // Default: Claude CLI path (with streaming support)
  return callClaudeCLI(agentId, chatId, message, mc, config, mediaPath, trace, streamCtx);
}

/**
 * Call an OpenAI-compatible API (DeepSeek, Ollama, etc.)
 */
async function callOpenAICompatible(agentId, chatId, message, mc, config, mediaPath = null, trace = null) {
  const sessionKey = getSessionKey(agentId, chatId);
  const log = tracedLogger(trace || createTrace('bridge', 'openai-compat'));
  const systemPrompt = await buildSystemPromptAsync(agentId, message);

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

  // Build messages array with conversation history for proper multi-turn context
  const messagesArray = [{ role: 'system', content: systemPrompt }];
  const session = sessions.get(sessionKey);
  if (session && session.history && session.history.length > 0) {
    const recent = session.history.slice(-20);
    for (const msg of recent) {
      const content = msg.content.length > 500
        ? msg.content.slice(0, 500) + '... [truncated]'
        : msg.content;
      messagesArray.push({ role: msg.role, content });
    }
  }
  messagesArray.push({ role: 'user', content: userMessage });

  const payload = {
    model: mc.modelId,
    messages: messagesArray,
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

    const proc = spawn('bash', ['-c', curlCmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

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

// ── Permission Management ──────────────────────────────────────────────────
const APPROVED_TOOLS_DIR = path.join(paths.shared, 'approved-tools');

function getApprovedTools(agentId) {
  if (!approvedTools.has(agentId)) {
    // Load from disk if persisted
    try {
      const filePath = path.join(APPROVED_TOOLS_DIR, `${agentId}.json`);
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        approvedTools.set(agentId, new Set(data.tools || []));
      } else {
        approvedTools.set(agentId, new Set());
      }
    } catch {
      approvedTools.set(agentId, new Set());
    }
  }
  return approvedTools.get(agentId);
}

async function approveToolForAgent(agentId, toolName) {
  const tools = getApprovedTools(agentId);
  tools.add(toolName);
  approvedTools.set(agentId, tools);
  // Persist to disk
  await ensureDir(APPROVED_TOOLS_DIR);
  const filePath = path.join(APPROVED_TOOLS_DIR, `${agentId}.json`);
  await fsp.writeFile(filePath, JSON.stringify({ tools: [...tools], updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * Parse permission error from stderr to extract the tool name.
 */
function parsePermissionError(stderr, stdout) {
  const combined = (stderr + '\n' + stdout).toLowerCase();
  const permPatterns = [
    /tool[:\s]+["`']?(\w+)["`']?\s+requires?\s+permission/i,
    /user denied tool[:\s]+["`']?(\w+)/i,
    /permission.*denied.*tool[:\s]+["`']?(\w+)/i,
    /blocked on\s+(\w+)\b.*permission/i,
    /need.*permission.*for\s+(\w+)/i,
  ];

  for (const pattern of permPatterns) {
    const match = (stderr + '\n' + stdout).match(pattern);
    if (match) return match[1];
  }

  const toolMentions = [
    /I'm blocked on (\w+)/i,
    /blocked.*?—.*?(\w+)\s+permission/i,
    /permission prompt.*?(\w+)\s/i,
    /waiting for.*?(\w+)\s+permission/i,
  ];
  for (const pattern of toolMentions) {
    const match = stdout.match(pattern);
    if (match) {
      const tool = match[1];
      const knownTools = ['WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'Agent', 'NotebookEdit'];
      const found = knownTools.find(t => t.toLowerCase() === tool.toLowerCase());
      if (found) return found;
    }
  }

  return null;
}

/**
 * Detect if a Claude response text indicates a permission block.
 */
function detectPermissionBlock(responseText) {
  if (!responseText) return null;
  const patterns = [
    /I'm blocked on (\w+)\b/i,
    /blocked on (\w+)\s*[—–-]/i,
    /permission prompt.*?for\s+(\w+)/i,
    /waiting for\s+(\w+)\s+permission/i,
    /can'?t\s+(?:use|access)\s+(\w+)\s+(?:without|until).*?permission/i,
    /(\w+)\s+(?:tool\s+)?(?:is\s+)?blocked/i,
    /need(?:s)?\s+permission\s+(?:for|to use)\s+(\w+)/i,
    /permission\s+(?:for|to use)\s+(\w+)\s+(?:is|was)\s+(?:denied|blocked|required)/i,
  ];

  const knownTools = ['WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'Agent', 'NotebookEdit', 'TodoWrite'];

  for (const pattern of patterns) {
    const match = responseText.match(pattern);
    if (match) {
      const toolCandidate = match[1];
      const found = knownTools.find(t => t.toLowerCase() === toolCandidate.toLowerCase());
      if (found) return found;
    }
  }
  return null;
}

/**
 * Translate raw API/CLI error messages into user-friendly Telegram messages.
 * Keeps the raw error in server logs but sends a clean message to users.
 */
function friendlyError(rawMsg) {
  const lower = rawMsg.toLowerCase();

  // Billing / usage limits
  if (lower.includes('out of extra usage') || lower.includes('out of credit') ||
      lower.includes('insufficient_quota') || lower.includes('billing') ||
      (lower.includes('usage') && lower.includes('add more'))) {
    return '⚠️ API credits exhausted — the Anthropic workspace is out of usage. Ask your admin to add more credits at console.anthropic.com → Billing.';
  }

  // Rate limiting
  if (lower.includes('rate_limit') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('429')) {
    return '⏳ Rate limited — too many requests. Try again in a minute.';
  }

  // Auth errors
  if (lower.includes('authentication') || lower.includes('invalid.*api.*key') || lower.includes('unauthorized') || lower.includes('401')) {
    return '🔑 Authentication error — API key may be invalid or expired. Check your credentials.';
  }

  // Overloaded
  if (lower.includes('overloaded') || lower.includes('503') || lower.includes('service unavailable')) {
    return '🔄 Claude API is temporarily overloaded. Try again in a moment.';
  }

  // Model not found
  if (lower.includes('model_not_found') || lower.includes('does not exist')) {
    return '❌ Model not available — the requested model may not be enabled for your account.';
  }

  // Context length
  if (lower.includes('context_length') || lower.includes('too long') || lower.includes('max.*token')) {
    return '📏 Message too long — exceeded the model\'s context window. Try a shorter message or start a new session.';
  }

  // Default: truncate but clean up raw JSON noise
  const cleaned = rawMsg.replace(/\{[^}]*"request_id"[^}]*\}/g, '').trim();
  return `⚠️ ${cleaned.slice(0, 180)}`;
}

/**
 * Call Claude via the Claude CLI (original path).
 */
async function callClaudeCLI(agentId, chatId, message, mc, config, mediaPath = null, trace = null, streamCtx = null) {
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
  // v1.15.0: Pass user message for smart memory recall context
  const systemPrompt = await buildSystemPromptAsync(agentId, message);
  const tmpDir = paths.tmp;
  await ensureDir(tmpDir);
  const systemPromptFile = path.join(tmpDir, `claude-agent-${agentId}-system.md`);
  await fsp.writeFile(systemPromptFile, systemPrompt);

  // Build the user message with conversation context
  const conversationContext = buildConversationContext(agentId, chatId);
  let userMessage = message;
  if (mediaPath) {
    userMessage = `[Media file at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
  }
  if (conversationContext) {
    userMessage = `${conversationContext}\n\n---\n\n# Current Message\n${userMessage}`;
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

  // Build allowed tools — v1.15.0: use Tool Registry when available
  const agentConf = config.agents[agentId] || {};
  let allAllowed;
  if (feature('TOOL_REGISTRY')) {
    // Tool Registry provides structured tool pool + config overrides + runtime approvals
    const registryTools = engine.getToolsForAgent(agentId);
    const runtimeApproved = [...getApprovedTools(agentId)];
    const configAllowed = agentConf.allowedTools || config.defaults?.allowedTools || [];
    allAllowed = [...new Set([...registryTools, ...configAllowed, ...runtimeApproved])];
  } else {
    // Legacy: flat string lists
    const configAllowed = agentConf.allowedTools || config.defaults?.allowedTools || [];
    const runtimeApproved = [...getApprovedTools(agentId)];
    allAllowed = [...new Set([...configAllowed, ...runtimeApproved])];
  }

  function spawnClaude(promptText, extraArgs = []) {
    const args = [
      '-p', promptText,
      '--verbose',
      '--output-format', 'stream-json',
      '--max-turns', '500',
      '--model', modelFlag,
      '--append-system-prompt', systemPrompt,
      ...extraArgs
    ];
    if (allAllowed.length > 0) {
      args.push('--allowedTools', ...allAllowed);
    }

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
    }
    env.HOME = process.env.HOME || os.homedir();

    return spawn('claude', args, { cwd, env });
  }

  // ── Stream event handler for live Telegram updates ──
  function handleStreamEvent(event) {
    if (!streamCtx) return;
    try {
      // Tool use events → show progress
      if (event.type === 'tool_use') {
        const toolName = event.tool || event.name || (event.tool_use?.name) || 'tool';
        const toolInput = event.input || (event.tool_use?.input) || {};
        streamCtx.onTool(toolName, toolInput);
      }
      // Assistant text blocks
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            streamCtx.onTool(block.name, block.input);
          }
          if (block.type === 'text' && block.text) {
            streamCtx.onText(block.text);
          }
        }
      }
      // Content block deltas (streaming text chunks)
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
        streamCtx.onText(event.delta.text);
      }
    } catch (e) {
      console.error(`[${agentId}] Stream event handler error:`, e.message);
    }
  }

  function runClaude(promptText, extraArgs = []) {
    return new Promise((resolveRun, rejectRun) => {
      const proc = spawnClaude(promptText, extraArgs);
      let rawStdout = '';
      let stderr = '';
      const parsedEvents = [];
      let lineBuffer = '';

      const BRIDGE_TIMEOUT_MS = 1800000; // 30 min (match standalone agents)
      const timer = setTimeout(() => {
        console.error(`[${agentId}] Timeout after ${BRIDGE_TIMEOUT_MS / 1000}s — killing`);
        proc.kill('SIGTERM');
      }, BRIDGE_TIMEOUT_MS);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        rawStdout += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            parsedEvents.push(event);
            handleStreamEvent(event);
          } catch {}
        }
      });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer);
            parsedEvents.push(event);
            handleStreamEvent(event);
          } catch {}
        }
        if (streamCtx) streamCtx.onDone();
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

    // Detect max_turns — either from stream-json stop_reason or from error text (regardless of exit code)
    const stopReason = extractStopReason(result.parsedEvents);
    const hitMaxTurns = stopReason === 'max_turns' ||
      (result.rawStdout || '').includes('Reached max turns') ||
      (result.rawStdout || '').includes('max_turns') ||
      (result.stderr || '').includes('Reached max turns') ||
      (result.stderr || '').match(/Reached max turns\s*\(\d+\)/);

    if (hitMaxTurns) {
      const sessionId = extractSessionId(result.parsedEvents);
      if (sessionId) {
        log.log(`[${agentId}] Hit max_turns — auto-continuing session ${sessionId.slice(0, 8)}...`);
        const contResult = await runClaude('Continue where you left off. Complete the task.', ['--resume', sessionId]);
        const contResponse = extractText(contResult.parsedEvents);
        if (contResponse) {
          log.log(`✅ Continuation: ${contResponse.length} chars`);
          appendToMemoryAsync(agentId, `Chat ${chatId}: ${message.slice(0, 100)}... → responded (continued)`).catch(() => {});
          activeCalls.delete(sessionKey);
          return contResponse;
        }
        if (contResponse) response = contResponse;
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

// ── Live Streaming Helpers for Telegram ──────────────────────────────────
const STREAM_MAX_MSG_LEN = 3800;
const STREAM_MIN_UPDATE_INTERVAL = 1500; // ms between Telegram edits

async function telegramEditSafe(bot, chatId, messageId, text) {
  let safeText = text;
  if (text.length > 4096) {
    let cutAt = text.lastIndexOf('\n', 4066);
    if (cutAt < 2000) cutAt = 4066;
    safeText = text.slice(0, cutAt) + '\n\n…';
  }
  try {
    await bot.editMessageText(safeText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    return true;
  } catch (err) {
    if (err.message?.includes('parse') || err.message?.includes("Can't parse")) {
      try {
        await bot.editMessageText(safeText, { chat_id: chatId, message_id: messageId });
        return true;
      } catch { return false; }
    } else if (err.message?.includes('message is not modified')) {
      return true;
    } else if (err.response?.statusCode === 429) {
      const wait = (err.response.body?.parameters?.retry_after || 2) * 1000;
      if (wait > 10000) return false;
      await new Promise(r => setTimeout(r, wait + 200));
      try {
        await bot.editMessageText(safeText, { chat_id: chatId, message_id: messageId });
        return true;
      } catch { return false; }
    }
    return false;
  }
}

function createStreamContext(bot, chatId, agentId) {
  const ctx = {
    streamText: '',
    streamMessageId: null,
    sentMessages: [],
    lastStreamUpdate: 0,
    lastStreamedLength: 0,
    streamUpdatePending: false,
    inToolPhase: false,
    toolCount: 0,
    lastActivity: '',
    progressMessageId: null,
    lastProgressSent: 0,
    done: false,

    onTool(toolName, toolInput) {
      const desc = {
        'Read': `Reading ${toolInput?.file_path?.split('/').pop() || 'file'}`,
        'Write': `Writing ${toolInput?.file_path?.split('/').pop() || 'file'}`,
        'Edit': `Editing ${toolInput?.file_path?.split('/').pop() || 'file'}`,
        'Bash': `Running command`,
        'Glob': `Searching files`,
        'Grep': `Searching content`,
        'Agent': `Launching sub-agent`,
        'WebSearch': `Searching web`,
        'WebFetch': `Fetching URL`,
      };
      ctx.lastActivity = desc[toolName] || `${toolName}`;
      ctx.toolCount++;
      ctx.inToolPhase = true;
      ctx._maybeSendToolProgress();
    },

    onText(text) {
      if (ctx.inToolPhase && ctx.streamText.length > 0) ctx.streamText += '\n\n';
      ctx.inToolPhase = false;
      ctx.streamText += text;
      ctx._scheduleStreamUpdate();
    },

    onDone() {
      ctx.done = true;
      // Final update with complete text
      ctx._doStreamUpdate();
    },

    async _maybeSendToolProgress() {
      const now = Date.now();
      if (now - ctx.lastProgressSent < 3000) return; // Rate limit tool progress
      ctx.lastProgressSent = now;

      const statusText = `${ctx.lastActivity} (${ctx.toolCount} tools used)`;
      try {
        if (ctx.progressMessageId && !ctx.streamMessageId) {
          await telegramEditSafe(bot, chatId, ctx.progressMessageId, statusText);
        } else if (!ctx.streamMessageId && !ctx.progressMessageId) {
          const sent = await bot.sendMessage(chatId, statusText);
          if (sent?.message_id) ctx.progressMessageId = sent.message_id;
        }
      } catch {}
    },

    _scheduleStreamUpdate() {
      if (ctx.streamUpdatePending) return;
      const now = Date.now();
      const timeSince = now - ctx.lastStreamUpdate;
      const newChars = ctx.streamText.length - ctx.lastStreamedLength;
      const delay = !ctx.streamMessageId ? (newChars >= 30 ? 0 : 500) :
                    (timeSince >= STREAM_MIN_UPDATE_INTERVAL && newChars > 0) ? 0 :
                    Math.max(0, STREAM_MIN_UPDATE_INTERVAL - timeSince);
      if (delay === 0) {
        ctx._doStreamUpdate();
      } else {
        ctx.streamUpdatePending = true;
        setTimeout(() => { ctx.streamUpdatePending = false; ctx._doStreamUpdate(); }, delay);
      }
    },

    async _doStreamUpdate() {
      if (!ctx.streamText || ctx.streamText.length === ctx.lastStreamedLength) return;
      try {
        // Delete progress message when we start streaming actual text
        if (ctx.progressMessageId && !ctx.streamMessageId) {
          try { await bot.deleteMessage(chatId, ctx.progressMessageId); } catch {}
          ctx.progressMessageId = null;
        }

        if (!ctx.streamMessageId) {
          const displayText = ctx.streamText.slice(0, STREAM_MAX_MSG_LEN) + (ctx.done ? '' : ' ...');
          const sent = await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
            bot.sendMessage(chatId, displayText)
          );
          if (sent?.message_id) {
            ctx.streamMessageId = sent.message_id;
            ctx.sentMessages.push(sent.message_id);
          }
        } else if (ctx.streamText.length > STREAM_MAX_MSG_LEN) {
          // Split: finalize current message, start a new one for overflow
          let splitAt = ctx.streamText.lastIndexOf('\n\n', STREAM_MAX_MSG_LEN);
          if (splitAt < STREAM_MAX_MSG_LEN * 0.3) splitAt = ctx.streamText.lastIndexOf('\n', STREAM_MAX_MSG_LEN);
          if (splitAt < STREAM_MAX_MSG_LEN * 0.3) splitAt = STREAM_MAX_MSG_LEN;
          const finalizedText = ctx.streamText.slice(0, splitAt);
          const remainingText = ctx.streamText.slice(splitAt).trimStart();
          await telegramEditSafe(bot, chatId, ctx.streamMessageId, finalizedText);
          ctx.streamText = remainingText;
          if (remainingText.length > 0) {
            const displayText = remainingText + (ctx.done ? '' : ' ...');
            const sent = await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
              bot.sendMessage(chatId, displayText)
            );
            if (sent?.message_id) {
              ctx.streamMessageId = sent.message_id;
              ctx.sentMessages.push(sent.message_id);
            }
          }
        } else {
          const displayText = ctx.streamText + (ctx.done ? '' : ' ...');
          await telegramEditSafe(bot, chatId, ctx.streamMessageId, displayText);
        }
        ctx.lastStreamedLength = ctx.streamText.length;
        ctx.lastStreamUpdate = Date.now();
      } catch (e) {
        console.error(`[${agentId}] Stream update error:`, e.message);
      }
    }
  };
  return ctx;
}

// ── Message Debouncing ─────────────────────────────────────────────────────
function debounceMessage(agentId, chatId, message, bot, mediaPath = null, traceId = null) {
  const key = getSessionKey(agentId, chatId);
  const config = loadConfig();
  const debounceMs = config.telegram?.debounceMs || 2000;
  const msgTraceId = traceId || newTraceId();

  // v1.15.0: Echo dedup check — skip duplicate content in same chat
  if (feature('ECHO_DEDUP') && engine.dedup.isDuplicate(message, key)) {
    console.log(`[${agentId}] Echo dedup: skipping duplicate message in chat ${chatId}`);
    return;
  }

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

    // v1.15.0: Fire before-message hook
    if (feature('HOOK_SYSTEM')) {
      const hookResult = await engine.hooks.emit(HOOK_EVENTS.BEFORE_MESSAGE, {
        agentId, chatId, text: combined, mediaPath: media,
      });
      if (hookResult.blocked) {
        console.log(`[${agentId}] Hook blocked message: ${hookResult.reason}`);
        await bot.sendMessage(chatId, `⚠️ Message blocked: ${hookResult.reason}`);
        return;
      }
    }

    try { await bot.sendChatAction(chatId, 'typing'); } catch {}

    // Create streaming context for live Telegram updates
    const streamCtx = createStreamContext(bot, chatId, agentId);

    try {
      const response = await callClaude(agentId, chatId, combined, media, msgTraceId, streamCtx);

      // Check if the response indicates a permission block
      const blockedTool = detectPermissionBlock(response);
      if (blockedTool) {
        // Send response with approve/deny inline keyboard
        const nonce = crypto.randomBytes(4).toString('hex');
        const permKey = `perm:${agentId}:${chatId}:${nonce}`;
        pendingPermissions.set(permKey, {
          toolName: blockedTool,
          message: combined,
          mediaPath: media,
          agentId,
          chatId,
          createdAt: Date.now()
        });

        // If streaming already sent the response, don't duplicate
        if (!streamCtx.streamMessageId) {
          await sendLongMessage(bot, chatId, response);
        }

        // Then send the permission prompt with buttons
        await bot.sendMessage(chatId,
          `*${agentId}* needs permission for \`${blockedTool}\`\n\nApprove to allow this tool and retry the task.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Approve', callback_data: `perm_approve:${nonce}` },
                  { text: 'Always Allow', callback_data: `perm_always:${nonce}` },
                  { text: 'Deny', callback_data: `perm_deny:${nonce}` }
                ]
              ]
            }
          }
        );
      } else if (!streamCtx.streamMessageId) {
        // Streaming didn't send anything (e.g. OpenAI path) — send normally
        await sendLongMessage(bot, chatId, response);
      }
      // If streaming already sent messages, the final onDone() edit handles the complete text

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
      // Clean up any progress messages on error
      if (streamCtx.progressMessageId) {
        try { await bot.deleteMessage(chatId, streamCtx.progressMessageId); } catch {}
      }

      // Check if error itself is a permission issue
      const blockedTool = parsePermissionError(err.message, '');
      if (blockedTool) {
        const nonce = crypto.randomBytes(4).toString('hex');
        const permKey = `perm:${agentId}:${chatId}:${nonce}`;
        pendingPermissions.set(permKey, {
          toolName: blockedTool,
          message: combined,
          mediaPath: media,
          agentId,
          chatId,
          createdAt: Date.now()
        });

        await bot.sendMessage(chatId,
          `*${agentId}* needs permission for \`${blockedTool}\`\n\nThe tool was blocked. Approve to retry with this tool allowed.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Approve', callback_data: `perm_approve:${nonce}` },
                  { text: 'Always Allow', callback_data: `perm_always:${nonce}` },
                  { text: 'Deny', callback_data: `perm_deny:${nonce}` }
                ]
              ]
            }
          }
        );
      } else {
        console.error(`[${agentId}] Error:`, err.message);
        await bot.sendMessage(chatId, friendlyError(err.message));
      }
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
  if (standaloneAgents.includes(agentId) || agentConfig.standalone === true) {
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

    // Handle commands — v1.15.0: Command Registry + legacy fallbacks
    if (msg.text) {
      // Engine-based command processing (when COMMAND_REGISTRY feature is enabled)
      if (feature('COMMAND_REGISTRY') && engine.commands.isCommand(msg.text)) {
        try {
          const cmdResult = await engine.commands.execute(msg.text, {
            agentId: targetAgent,
            chatId: msg.chat.id,
            bot,
            config: loadConfig(),
            session: sessions.get(getSessionKey(targetAgent, msg.chat.id)),
          });

          if (cmdResult.handled) {
            const result = cmdResult.result || {};
            const error = cmdResult.error;

            // Handle action-based results from commands
            if (result.action === 'clear_session') {
              const sk = getSessionKey(targetAgent, msg.chat.id);
              sessions.delete(sk);
            } else if (result.action === 'stop_active_call') {
              const sk = getSessionKey(targetAgent, msg.chat.id);
              const proc = activeCalls.get(sk);
              if (proc) {
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
                activeCalls.delete(sk);
                result.text = `Stopped *${targetAgent}*.`;
              } else {
                result.text = `No active task for *${targetAgent}*.`;
              }
            } else if (result.action === 'set_model') {
              // Model switching handled via config update
              result.text = result.text || `Model set to ${result.model}`;
            }

            // Send response
            const responseText = error || result.text;
            if (responseText) {
              await bot.sendMessage(msg.chat.id, responseText, { parse_mode: 'Markdown' });
            }
            return;
          }
        } catch (cmdErr) {
          console.error(`[${targetAgent}] Command error:`, cmdErr.message);
        }
      }

      // ── Legacy commands (not in registry, kept for backwards compat) ──

      // /start command (custom per-agent, needs shared bot logic)
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
    const data = query.data || '';

    // Handle permission approve/deny callbacks
    if (data.startsWith('perm_')) {
      const [action, nonce] = data.split(':');

      // Find the pending permission by nonce (search all keys)
      let permEntry = null;
      let permKey = null;
      for (const [key, val] of pendingPermissions.entries()) {
        if (key.endsWith(`:${nonce}`)) {
          permEntry = val;
          permKey = key;
          break;
        }
      }

      if (!permEntry) {
        await bot.answerCallbackQuery(query.id, { text: 'Permission request expired.' });
        return;
      }

      const { toolName, message: origMessage, mediaPath: origMedia, agentId: origAgent, chatId: origChat } = permEntry;
      pendingPermissions.delete(permKey);

      if (action === 'perm_approve') {
        await bot.answerCallbackQuery(query.id, { text: `${toolName} approved for this session` });
        try {
          await bot.editMessageText(`\`${toolName}\` approved for *${origAgent}* (this session)`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
          });
        } catch {}
        // Temporarily add the tool and re-run
        const tools = getApprovedTools(origAgent);
        tools.add(toolName);
        try { await bot.sendChatAction(origChat, 'typing'); } catch {}
        try {
          const response = await callClaude(origAgent, origChat, origMessage, origMedia);
          await sendLongMessage(bot, origChat, response);
        } catch (retryErr) {
          await bot.sendMessage(origChat, `Retry failed: ${retryErr.message.slice(0, 200)}`);
        }

      } else if (action === 'perm_always') {
        await bot.answerCallbackQuery(query.id, { text: `${toolName} always allowed for ${origAgent}` });
        await approveToolForAgent(origAgent, toolName);
        try {
          await bot.editMessageText(`\`${toolName}\` permanently approved for *${origAgent}*`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
          });
        } catch {}
        try { await bot.sendChatAction(origChat, 'typing'); } catch {}
        try {
          const response = await callClaude(origAgent, origChat, origMessage, origMedia);
          await sendLongMessage(bot, origChat, response);
        } catch (retryErr) {
          await bot.sendMessage(origChat, `Retry failed: ${retryErr.message.slice(0, 200)}`);
        }

      } else if (action === 'perm_deny') {
        await bot.answerCallbackQuery(query.id, { text: `${toolName} denied` });
        try {
          await bot.editMessageText(`\`${toolName}\` denied for *${origAgent}*`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
          });
        } catch {}
      }
      return;
    }

    // Regular callback queries (non-permission)
    await bot.answerCallbackQuery(query.id);
    debounceMessage(targetAgent, chatId, `[Button pressed: ${data}]`, bot);
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
  console.log('║   Claude Agents Bridge v2.1 Prometheus   ║');
  console.log('║   Claude Code Architecture Integration   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  auditEvent('startup', { version: '2.1-prometheus' });

  const config = loadConfig();

  // v1.15.0: Initialize Claude Engine (tool registry, commands, hooks, features, dedup)
  try {
    await engine.initialize(config);
    console.log('[engine] ✅ Claude Engine v1.15.0 "Prometheus" active');
    console.log(`[engine]    Features: ${Object.entries(engine.features.getAll()).filter(([,v]) => v.enabled).length}/${Object.keys(engine.features.getAll()).length} enabled`);
  } catch (err) {
    console.error('[engine] ⚠️ Engine init failed, running in legacy mode:', err.message);
  }

  // Restore sessions from disk (survives restarts)
  await restoreSessionsFromDisk(config);
  const singleAgent = process.argv.find(a => a.startsWith('--agent='));

  // Start gateway
  setBridge(bridgeInterface);
  startGateway(config);

  // Start bots
  let agentsToStart = Object.entries(config.agents || {});
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
