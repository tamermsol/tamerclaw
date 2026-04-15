/**
 * Shared Bot Template v1.0 — Reusable Telegram Bot for All Agents
 *
 * Eliminates 1000+ line duplicate bot.js files across agents.
 * Each agent's bot.js becomes ~20-40 lines by calling createBot(config).
 *
 * Provides: Telegram polling, singleton lock, health heartbeat, processing guard,
 * Claude CLI streaming (stream-json), live edit-in-place, session persistence
 * with --resume, audio transcription, photo/document handling, message queue,
 * debounce, /start /new /status /sessions /resume /model /stop commands,
 * message deduplication, graceful shutdown, error recovery, auto-continue on
 * max_turns, and text-mode fallback retry.
 *
 * Usage:
 *   import { createBot } from '../../shared/bot-template.js';
 *   createBot({ agentId: 'myagent', token: process.env.MY_TOKEN, cwd: '...' });
 *
 * Flow: Telegram message -> claude CLI (stream-json, --resume) -> live edit-in-place -> Telegram
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import TelegramBot from 'node-telegram-bot-api';
import paths from './paths.js';
import { transcribeAudio } from './transcribe.js';
import { archiveSession, formatSessionsList, getSessionByIndex, getSessionById } from './session-history.js';
import { MeetingCommandHandler } from '../meetings/meeting-commands.js';
import { createTeamCommands, getTeamLeaderPrompt, getTeamMemberPrompt, isTeamLeader } from './team-leader.js';

// v1.15.0: Claude Code architecture modules
import { feature } from './feature-flags.js';
import { EchoDedup } from './echo-dedup.js';

// ── Friendly Error Formatter ──────────────────────────────────────────────────
function friendlyError(rawMsg) {
  const lower = (rawMsg || '').toLowerCase();
  if (lower.includes('out of extra usage') || lower.includes('out of credit') ||
      lower.includes('insufficient_quota') || (lower.includes('usage') && lower.includes('add more'))) {
    return '⚠️ API credits exhausted — the Anthropic workspace is out of usage. Add more credits at console.anthropic.com → Billing.';
  }
  if (lower.includes('rate_limit') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('429')) {
    return '⏳ Rate limited — too many requests. Try again in a minute.';
  }
  if (lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('401')) {
    return '🔑 Authentication error — API key may be invalid or expired.';
  }
  if (lower.includes('overloaded') || lower.includes('503') || lower.includes('service unavailable')) {
    return '🔄 Claude API is temporarily overloaded. Try again in a moment.';
  }
  const cleaned = (rawMsg || '').replace(/\{[^}]*"request_id"[^}]*\}/g, '').trim();
  return `⚠️ ${cleaned.slice(0, 180)}`;
}

// ── Plugin Loader ──────────────────────────────────────────────────────────────
const __shared_dir = path.dirname(new URL(import.meta.url).pathname);

function loadPlugins(agentDir) {
  const pluginsDir = path.join(__shared_dir, 'plugins');
  const configPath = path.join(agentDir, 'config.json');
  let pluginNames = ['code-review', 'security-guidance', 'code-simplifier']; // defaults

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.plugins) pluginNames = config.plugins;
  } catch {}

  const pluginContents = [];
  for (const name of pluginNames) {
    try {
      const content = fs.readFileSync(path.join(pluginsDir, `${name}.md`), 'utf-8');
      pluginContents.push(content);
    } catch {}
  }
  return pluginContents.length > 0 ? '\n\n# Quality Guidelines\n\n' + pluginContents.join('\n\n---\n\n') : '';
}

// ── Constants ──────────────────────────────────────────────────────────────────
const TELEGRAM_MAX_LEN = 4096;
const STREAM_MAX_MSG_LEN = 3800;
const CLAUDE_BIN = '/root/.local/bin/claude';
const SUBPROCESS_TIMEOUT_MS = 600000; // 10 min timeout for continuation/retry/fresh subprocesses
const STUCK_WATCHDOG_MS = 1200000;    // 20 min — if processing exceeds this, force-kill and reset

// ── Default Model Router ────────────────────────────────────────────────────
function defaultModelRouter(messageText, defaultModel) {
  if (!messageText) return defaultModel || 'sonnet';
  const text = messageText.toLowerCase();
  const len = messageText.length;

  // Short status/help queries -> haiku
  const simplePatterns = ['status', 'help', '/start', 'hi', 'hello', 'hey', 'thanks', 'ok', 'ping'];
  if (len < 30 && simplePatterns.some(p => text.includes(p))) return 'haiku';

  // Planning/architecture/research -> opus
  const planningPatterns = [
    'plan', 'architect', 'design', 'research', 'evaluate', 'compare',
    'strategy', 'approach', 'how should', 'what stack', 'tech stack',
    'recommend', 'best way', 'tradeoff', 'trade-off', 'pros and cons',
    'system design', 'architecture', 'roadmap', 'milestone',
    'review', 'audit', 'analyze', 'refactor strategy',
    'protocol design', 'api design', 'data model',
    'debug complex', 'root cause', 'investigate'
  ];
  if (planningPatterns.some(p => text.includes(p))) return 'opus';

  // Execution tasks -> sonnet
  const executionPatterns = [
    'implement', 'build', 'code', 'write', 'create', 'fix', 'debug',
    'flash', 'compile', 'upload', 'deploy', 'configure', 'setup',
    'add', 'modify', 'update', 'change', 'edit', 'refactor'
  ];
  if (executionPatterns.some(p => text.includes(p))) return 'sonnet';

  // Medium queries
  const mediumPatterns = ['explain', 'show', 'list', 'what is', 'how does', 'read', 'check'];
  if (len < 100 && mediumPatterns.some(p => text.includes(p))) return 'sonnet';

  // Only very long messages need deeper thinking (raised from 300)
  if (len > 800) return 'opus';

  return defaultModel || 'sonnet';
}

// ── Tool Activity Descriptions ──────────────────────────────────────────────
function formatToolActivity(toolName, input) {
  const desc = {
    'Read': `Reading ${input?.file_path?.split('/').pop() || 'file'}`,
    'Write': `Writing ${input?.file_path?.split('/').pop() || 'file'}`,
    'Edit': `Editing ${input?.file_path?.split('/').pop() || 'file'}`,
    'Bash': `Running command`,
    'Glob': `Searching files`,
    'Grep': `Searching content`,
    'Agent': `Launching sub-agent`,
    'WebSearch': `Searching web`,
    'WebFetch': `Fetching URL`,
  };
  return desc[toolName] || toolName;
}

// ── Extract Result from Stream Events ───────────────────────────────────────
function extractResultFromEvents(events) {
  const texts = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'result' && ev.result) {
      if (typeof ev.result === 'string') return ev.result;
      if (Array.isArray(ev.result)) {
        for (const block of ev.result) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
        if (texts.length) return texts.join('\n\n');
      }
    }
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) texts.push(block.text);
      }
    }
  }
  if (texts.length) return texts.join('\n\n');
  return null;
}

/**
 * Create and start a Telegram bot for an agent.
 *
 * @param {object} config
 * @param {string} config.agentId - Agent identifier (e.g. 'smarty', 'trading')
 * @param {string} config.token - Telegram bot token
 * @param {string} [config.cwd] - Working directory for Claude CLI (default: agent workspace/)
 * @param {string} [config.defaultModel='sonnet'] - Default Claude model
 * @param {function} [config.modelRouter] - Custom model routing: (messageText) => 'opus'|'sonnet'|'haiku'
 * @param {number} [config.maxTurns=200] - Max turns for Claude CLI
 * @param {number} [config.timeoutMs=1800000] - Claude process timeout (30 min default)
 * @param {string[]} [config.allowedUsers=[]] - User IDs to allow (empty = use credentials file)
 * @param {string[]} [config.systemPromptFiles] - Files to load for system prompt (relative to agent dir)
 * @param {function} [config.buildSystemPrompt] - Custom system prompt builder: () => string
 * @param {function} [config.onMessage] - Hook before processing: async (msg, bot) => {}
 * @param {function} [config.onResponse] - Hook after response: async (response, msg, bot) => {}
 * @param {object} [config.customCommands={}] - Extra /commands: { '/cmd': async (msg, bot, ctx) => {} }
 * @param {string} [config.greeting] - Custom /start message
 * @param {string} [config.statusEmoji='🤖'] - Emoji for status/progress messages
 * @param {string[]} [config.allowedTools] - Tools to allow Claude to use
 * @param {string[]} [config.memoryDirs] - Extra memory directories to scan
 * @param {boolean} [config.trackUserId=true] - Track userId in sessions for ownership validation
 * @param {boolean} [config.sessionExpiry=true] - Auto-expire sessions after 24h
 * @param {boolean} [config.failSecure=true] - Deny access when allowlist is missing/broken
 * @param {number} [config.debounceMs=2500] - Message debounce delay
 * @param {function} [config.onStartup] - Hook after bot starts: async (bot) => cleanup_fn|undefined
 * @returns {object} { bot, shutdown, getState }
 */
export function createBot(config) {
  // ── Merge with per-agent config.json if it exists ─────────────────────────
  const agentDir = paths.agentDir(config.agentId);
  const agentConfigPath = path.join(agentDir, 'config.json');
  let fileConfig = {};
  try {
    if (fs.existsSync(agentConfigPath)) {
      fileConfig = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'));
      console.log(`[${config.agentId}] Loaded config.json`);
    }
  } catch (e) {
    console.error(`[${config.agentId}] Failed to load config.json:`, e.message);
  }

  // v1.15.0: Per-bot echo dedup instance
  const botDedup = new EchoDedup(500);

  // File config is lowest priority, then passed config overrides
  const cfg = {
    defaultModel: 'sonnet',
    maxTurns: 200,
    timeoutMs: 7200000,  // 2 hours (was 30 min — too aggressive)
    allowedUsers: [],
    systemPromptFiles: ['IDENTITY.md', 'MEMORY.md', 'USER.md'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch'],
    statusEmoji: '🤖',
    trackUserId: true,
    sessionExpiry: true,
    failSecure: true,
    debounceMs: 2500,
    ...fileConfig,
    ...config,
  };

  // ── Auto-inject team leader commands ──────────────────────────────────────
  if (isTeamLeader(cfg.agentId)) {
    const teamCmds = createTeamCommands(cfg.agentId);
    cfg.customCommands = { ...teamCmds, ...(cfg.customCommands || {}) };
    console.log(`[${cfg.agentId}] Team leader commands injected`);
  }

  // ── Validate required fields ──────────────────────────────────────────────
  if (!cfg.token) {
    console.error(`FATAL: No token provided for ${cfg.agentId}`);
    process.exit(1);
  }

  // ── Paths ─────────────────────────────────────────────────────────────────
  const BOT_DIR = agentDir;
  const AGENT_DIR = agentDir;
  const CWD = cfg.cwd || path.join(agentDir, 'workspace');
  const LOCK_FILE = path.join(BOT_DIR, 'bot.lock');
  const SESSIONS_FILE = path.join(BOT_DIR, 'sessions.json');
  const PROCESSED = path.join(BOT_DIR, 'processed.txt');
  const PROCESSING_FILE = path.join(BOT_DIR, 'processing.json');
  const HEALTH_FILE = path.join(BOT_DIR, 'health.json');

  const AGENT_ID = cfg.agentId;
  const TIMEOUT_MS = cfg.timeoutMs;
  const TIMEOUT_WARNING_MS = TIMEOUT_MS * 0.8;

  // ── Singleton Guard ───────────────────────────────────────────────────────
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
      if (oldPid && oldPid !== String(process.pid)) {
        try {
          const cwd = fs.readlinkSync(`/proc/${oldPid}/cwd`);
          if (cwd.includes(AGENT_ID)) {
            console.log(`[startup] Killing old ${AGENT_ID} bot (PID ${oldPid})`);
            process.kill(Number(oldPid), 'SIGKILL');
            execSync('sleep 3');
          }
        } catch {
          // Process doesn't exist or no permission — stale lock
        }
      }
    }
    // Atomic write via temp file + rename
    const tmpFile = LOCK_FILE + '.tmp';
    fs.writeFileSync(tmpFile, String(process.pid));
    fs.renameSync(tmpFile, LOCK_FILE);
  } catch (e) {
    console.error('[WARN] Lock setup:', e.message);
  }

  // ── Bot Init ──────────────────────────────────────────────────────────────
  const bot = new TelegramBot(cfg.token, { polling: true });
  console.log(`${cfg.statusEmoji} ${AGENT_ID} Bot (bot-template v1.0) started`);
  console.log(`Token: ...${cfg.token.slice(-8)} | PID: ${process.pid}`);

  // ── Meeting Command Handler ────────────────────────────────────────────────
  const meetingHandler = new MeetingCommandHandler(bot, AGENT_ID);

  // ── State ─────────────────────────────────────────────────────────────────
  let activeProcess = null;
  let stopRequested = false;
  let callCount = 0;
  let errorCount = 0;
  let processing = false;
  let currentModel = cfg.defaultModel;
  let modelOverride = null; // Set by /model command

  // Startup hook (e.g. alert watchers)
  let startupCleanup = null;
  if (cfg.onStartup) {
    Promise.resolve(cfg.onStartup(bot)).then(cleanup => {
      if (typeof cleanup === 'function') startupCleanup = cleanup;
    }).catch(e => console.error(`[${AGENT_ID}] onStartup error:`, e.message));
  }

  // ── Allowlist ─────────────────────────────────────────────────────────────
  function isUserAllowed(userId) {
    // Hardcoded allowedUsers takes priority
    if (cfg.allowedUsers && cfg.allowedUsers.length > 0) {
      return cfg.allowedUsers.includes(userId) || cfg.allowedUsers.includes(String(userId));
    }
    try {
      let filePath = path.join(paths.credentials, `telegram-${AGENT_ID}-allowFrom.json`);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(paths.credentials, 'telegram-default-allowFrom.json');
      }
      if (!fs.existsSync(filePath)) {
        if (cfg.failSecure) {
          console.error('[SECURITY] Allowlist file missing at:', filePath);
          return false;
        }
        return true;
      }
      const allowlist = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (allowlist.allowAll) return true;
      if (allowlist.users && Array.isArray(allowlist.users)) {
        return allowlist.users.includes(userId) || allowlist.users.includes(String(userId));
      }
      return cfg.failSecure ? false : true;
    } catch (err) {
      console.error('[SECURITY] Allowlist check failed:', err.message);
      return cfg.failSecure ? false : true;
    }
  }

  // ── Session Persistence ───────────────────────────────────────────────────
  function loadSessions() {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); }
    catch { return {}; }
  }

  function saveSessions(sessions) {
    try {
      const tmpPath = SESSIONS_FILE + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(sessions, (k, v) => v instanceof Set ? [...v] : v, 2));
      fs.renameSync(tmpPath, SESSIONS_FILE);
    } catch (e) {
      console.error('[sessions] Save failed:', e.message);
    }
  }

  const chatSessions = loadSessions();

  function getSessionId(chatId, userId) {
    const session = chatSessions[chatId];
    if (!session) return null;

    // User ownership validation
    if (cfg.trackUserId && session.userId && session.userId !== userId) {
      console.warn(`[SECURITY] User ${userId} tried to access session from user ${session.userId}`);
      return null;
    }

    // Auto-expire sessions older than 24 hours
    if (cfg.sessionExpiry) {
      const sessionAge = Date.now() - new Date(session.startedAt).getTime();
      if (sessionAge > 24 * 60 * 60 * 1000) {
        console.log(`[sessions] Session ${chatId} expired (24h old), clearing`);
        clearSession(chatId);
        return null;
      }
    }

    return session.sessionId;
  }

  function createSession(chatId, userId, reason = 'new_session') {
    const existing = chatSessions[chatId];
    if (existing?.sessionId && existing.messageCount > 0) {
      try { archiveSession(AGENT_ID, existing, reason); }
      catch (e) { console.error(`[sessions] Archive failed:`, e.message); }
    }

    const sessionId = randomUUID();
    chatSessions[chatId] = {
      sessionId,
      ...(cfg.trackUserId ? { userId } : {}),
      startedAt: new Date().toISOString(),
      messageCount: 0,
      processedMessages: new Set()
    };
    saveSessions(chatSessions);
    console.log(`[sessions] New session for chat ${chatId}: ${sessionId.slice(0, 8)}...`);
    return sessionId;
  }

  function incrementSession(chatId) {
    if (chatSessions[chatId]) {
      chatSessions[chatId].messageCount = (chatSessions[chatId].messageCount || 0) + 1;
      saveSessions(chatSessions);
    }
  }

  function recordProcessedMessage(chatId, messageText) {
    if (chatSessions[chatId]) {
      const hash = createHash('sha256').update(messageText).digest('hex').slice(0, 8);
      if (!(chatSessions[chatId].processedMessages instanceof Set)) {
        chatSessions[chatId].processedMessages = new Set(
          Array.isArray(chatSessions[chatId].processedMessages) ? chatSessions[chatId].processedMessages : []
        );
      }
      chatSessions[chatId].processedMessages.add(hash);
      chatSessions[chatId].lastMessageHash = hash;
      saveSessions(chatSessions);
      return hash;
    }
    return null;
  }

  function clearSession(chatId, reason = 'reset') {
    const sessionData = chatSessions[chatId];
    if (sessionData?.sessionId && sessionData.messageCount > 0) {
      try { archiveSession(AGENT_ID, sessionData, reason); }
      catch (e) { console.error(`[sessions] Archive failed:`, e.message); }
    }
    delete chatSessions[chatId];
    saveSessions(chatSessions);
    console.log(`[sessions] Cleared session for chat ${chatId}`);
  }

  // ── Processed Tracking (deduplication) ────────────────────────────────────
  function getProcessed() {
    try { return new Set(fs.readFileSync(PROCESSED, 'utf-8').trim().split('\n').filter(Boolean)); }
    catch { return new Set(); }
  }

  function markProcessed(id) {
    fs.appendFileSync(PROCESSED, id + '\n');
  }

  // ── Memory ────────────────────────────────────────────────────────────────
  function loadRecentMemory() {
    const parts = [];
    const memDirs = [
      path.join(AGENT_DIR, 'memory'),
      ...(cfg.memoryDirs || [])
    ];

    for (const memDir of memDirs) {
      try {
        const memFiles = fs.readdirSync(memDir)
          .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .sort().reverse();
        const today = new Date().toISOString().slice(0, 10);
        let loadedChars = 0;
        const MAX = 15000;
        for (const file of memFiles.slice(0, 5)) {
          const date = file.replace('.md', '');
          const content = fs.readFileSync(path.join(memDir, file), 'utf-8');
          const budget = MAX - loadedChars;
          if (budget <= 200) break;
          const label = date === today ? `Today (${date})` : `Session ${date}`;
          const slice = content.slice(-Math.min(budget, content.length));
          parts.push(`# ${label}\n${slice}`);
          loadedChars += slice.length;
        }
      } catch {}
    }
    return parts;
  }

  function appendDailyMemory(userMessage, responseLength) {
    const memDir = path.join(AGENT_DIR, 'memory');
    try {
      if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const memPath = path.join(memDir, `${today}.md`);
      const time = new Date().toISOString().slice(11, 19);
      const summary = userMessage.slice(0, 200).replace(/\n/g, ' ');
      const entry = `\n[${time}] User: ${summary}${userMessage.length > 200 ? '...' : ''} -> responded (${responseLength} chars)\n`;
      if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, `# ${today} — ${AGENT_ID}\n\n## Conversation Log\n`);
      }
      fs.appendFileSync(memPath, entry);
    } catch (e) {
      console.error('[memory] Write failed:', e.message);
    }
  }

  // ── System Prompt Builder ─────────────────────────────────────────────────
  function buildSystemPrompt() {
    // If agent provides a custom builder, use it
    if (cfg.buildSystemPrompt) {
      return cfg.buildSystemPrompt({
        agentDir: AGENT_DIR,
        sharedDir: paths.shared,
        cwd: CWD,
        agentId: AGENT_ID,
        pid: process.pid,
        loadRecentMemory,
      });
    }

    const parts = [];

    // Load system prompt files from agent dir
    for (const file of (cfg.systemPromptFiles || [])) {
      try {
        const content = fs.readFileSync(path.join(AGENT_DIR, file), 'utf-8');
        if (content.trim()) {
          if (file === 'MEMORY.md') {
            parts.push('# Long-term Memory\n' + content.slice(0, 5000));
          } else {
            parts.push(content);
          }
        }
      } catch {}
    }

    // Shared files: SOUL.md, GLOBAL_POLICY.md, env-awareness.md
    try { parts.push(fs.readFileSync(path.join(paths.shared, 'SOUL.md'), 'utf-8')); } catch {}
    try { parts.push(fs.readFileSync(path.join(paths.shared, 'GLOBAL_POLICY.md'), 'utf-8')); } catch {}
    try { parts.push(fs.readFileSync(path.join(paths.shared, 'env-awareness.md'), 'utf-8')); } catch {}

    // Load quality guideline plugins
    const pluginContent = loadPlugins(AGENT_DIR);
    if (pluginContent) parts.push(pluginContent);

    // Team context (leader or member)
    const teamLeaderCtx = getTeamLeaderPrompt(AGENT_ID);
    const teamMemberCtx = getTeamMemberPrompt(AGENT_ID);
    if (teamLeaderCtx) parts.push(teamLeaderCtx);
    else if (teamMemberCtx) parts.push(teamMemberCtx);

    // Recent daily memory
    parts.push(...loadRecentMemory());

    // Runtime context
    parts.push(`
# Runtime Context
## Current Date
${new Date().toISOString().slice(0, 10)}

## Working Directory
${CWD}

## CRITICAL: Self-Protection Rules
- NEVER run: systemctl restart ${AGENT_ID}-agent, systemctl stop ${AGENT_ID}-agent, or kill commands targeting your own PID (${process.pid}) or bot.js processes
- NEVER edit ${path.join(AGENT_DIR, 'bot.js')} — that is YOUR running code
- NEVER modify /etc/systemd/system/${AGENT_ID}-agent.service

## Telegram Formatting
- No markdown tables (use bullet lists)
- Keep messages concise for mobile

## Session Persistence
- You have session persistence — you remember previous messages in this conversation
- When the user asks about earlier tasks, check your conversation context AND memory above`);

    return parts.join('\n\n---\n\n');
  }

  // ── Telegram Stream Helpers ───────────────────────────────────────────────

  async function telegramEditSafe(chatId, messageId, text) {
    let safeText = text;
    if (text.length > TELEGRAM_MAX_LEN) {
      let cutAt = text.lastIndexOf('\n', TELEGRAM_MAX_LEN - 30);
      if (cutAt < TELEGRAM_MAX_LEN * 0.5) cutAt = TELEGRAM_MAX_LEN - 30;
      safeText = text.slice(0, cutAt) + '\n\n...';
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
      console.error(`[${AGENT_ID}] editSafe error:`, err.message?.slice(0, 100));
      return false;
    }
  }

  // ── Long Message Splitting ────────────────────────────────────────────────
  function sendLongMessage(chatId, text) {
    // Safety: never send raw JSON data to the user
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 500) {
      try {
        JSON.parse(trimmed);
        console.warn(`[${AGENT_ID}] Blocked sending raw JSON (${trimmed.length} chars) to user`);
        bot.sendMessage(chatId, 'Task complete. The result was processed internally.').catch(() => {});
        return;
      } catch {} // not valid JSON, safe to send
    }
    const MAX = 4096;
    if (text.length <= MAX) {
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(chatId, text).catch(e => console.error('Send error:', e.message))
      );
      return;
    }
    let remaining = text;
    const chunks = [];
    while (remaining.length > 0) {
      if (remaining.length <= MAX) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n\n', MAX);
      if (splitAt < MAX * 0.3) splitAt = remaining.lastIndexOf('\n', MAX);
      if (splitAt < MAX * 0.3) splitAt = MAX;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    chunks.reduce((promise, chunk, i) => {
      return promise.then(() => new Promise(resolve => {
        setTimeout(() => {
          bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() =>
            bot.sendMessage(chatId, chunk).catch(e => console.error('Send error:', e.message))
          );
          resolve();
        }, i === 0 ? 0 : 300);
      }));
    }, Promise.resolve());
  }

  // ── Media Download (with timeout) ─────────────────────────────────────────
  async function downloadMedia(fileId, timeoutMs = 30000) {
    const mediaDir = paths.agentMedia(AGENT_ID);
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    try {
      const downloadWithTimeout = Promise.race([
        (async () => {
          const file = await bot.getFile(fileId);
          const ext = path.extname(file.file_path || '') || '.bin';
          const localPath = path.join(mediaDir, `${Date.now()}${ext}`);
          const fileStream = await bot.getFileStream(fileId);
          const writeStream = fs.createWriteStream(localPath);
          return new Promise((resolve, reject) => {
            fileStream.pipe(writeStream);
            writeStream.on('finish', () => { console.log(`Media: ${localPath}`); resolve(localPath); });
            writeStream.on('error', reject);
          });
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Media download timeout')), timeoutMs)
        )
      ]);
      return await downloadWithTimeout;
    } catch (err) {
      console.error('Media download error:', err.message);
      return null;
    }
  }

  // ── Claude CLI Execution (streaming with live Telegram updates) ───────────

  function callClaude(message, chatId, userId, mediaPath = null) {
    return new Promise((resolve, reject) => {
      const systemPrompt = buildSystemPrompt();
      const model = modelOverride || (cfg.modelRouter ? cfg.modelRouter(message) : defaultModelRouter(message, cfg.defaultModel));

      let userMessage = message;
      if (mediaPath) {
        const safePath = mediaPath.replace(/"/g, '\\"').replace(/\$/g, '\\$');
        userMessage = `[Media file at: "${safePath}"]\n\n${message || 'User sent a media file.'}`;
      }

      // Prevent messages starting with "-" from being interpreted as CLI flags
      if (userMessage.startsWith('-')) {
        userMessage = 'User says:\n' + userMessage;
      }

      console.log(`[${AGENT_ID}] Processing (${model}): "${userMessage.slice(0, 100)}..."`);

      const toolsStr = cfg.allowedTools.join(' ');

      const existingSessionId = getSessionId(chatId, userId);
      const isResume = !!existingSessionId;

      const baseArgs = [
        '-p', userMessage,
        '--verbose',
        '--output-format', 'stream-json',
        '--max-turns', String(cfg.maxTurns),
        '--model', model,
        '--allowedTools', toolsStr
      ];

      let args;
      if (isResume) {
        args = [...baseArgs, '--resume', existingSessionId, '--append-system-prompt', systemPrompt];
        console.log(`[${AGENT_ID}] Resuming session ${existingSessionId.slice(0, 8)}...`);
      } else {
        const newSessionId = createSession(chatId, userId);
        args = [...baseArgs, '--session-id', newSessionId, '--system-prompt', systemPrompt];
        console.log(`[${AGENT_ID}] New session ${newSessionId.slice(0, 8)}...`);
      }

      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
      }
      env.HOME = '/root';

      const proc = spawn(CLAUDE_BIN, args, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
      activeProcess = proc;
      stopRequested = false;

      let rawStdout = '';
      let stderr = '';
      const startTime = Date.now();

      const parsedEvents = [];
      let lineBuffer = '';
      let hasStreamData = false;

      let streamText = '';
      let streamMessageId = null;
      let lastStreamUpdate = 0;
      let lastStreamedLength = 0;
      let streamedAnyText = false;
      let streamUpdatePending = false;
      let sentMessages = [];
      let inToolPhase = false;

      let lastActivity = '';
      let toolCount = 0;
      let lastProgressSent = 0;
      let progressMessageId = null;
      let recentTools = [];
      const MAX_RECENT_TOOLS = 5;

      function processChunk(chunk) {
        rawStdout += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            hasStreamData = true;
            parsedEvents.push(event);
            processStreamEvent(event);
          } catch {}
        }
      }

      function processStreamEvent(event) {
        if (event.type === 'tool_use') {
          const toolName = event.tool || event.name || (event.tool_use?.name) || 'tool';
          const toolInput = event.input || (event.tool_use?.input) || {};
          lastActivity = formatToolActivity(toolName, toolInput);
          toolCount++;
          inToolPhase = true;
          maybeSendToolProgress();
        }
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              lastActivity = formatToolActivity(block.name, block.input);
              toolCount++;
              inToolPhase = true;
              maybeSendToolProgress();
            }
            if (block.type === 'text' && block.text) {
              if (inToolPhase && streamText.length > 0) streamText += '\n\n';
              inToolPhase = false;
              streamText += block.text;
              scheduleStreamUpdate();
            }
          }
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
          if (inToolPhase && streamText.length > 0) streamText += '\n\n';
          inToolPhase = false;
          streamText += event.delta.text;
          scheduleStreamUpdate();
        }
      }

      function scheduleStreamUpdate() {
        if (streamUpdatePending) return;
        const now = Date.now();
        const timeSince = now - lastStreamUpdate;
        const newChars = streamText.length - lastStreamedLength;
        const delay = !streamMessageId ? (newChars >= 30 ? 0 : 500) :
                      (timeSince >= 1500 && newChars > 0) ? 0 : Math.max(0, 1500 - timeSince);
        if (delay === 0) {
          doStreamUpdate();
        } else {
          streamUpdatePending = true;
          setTimeout(() => { streamUpdatePending = false; doStreamUpdate(); }, delay);
        }
      }

      async function doStreamUpdate() {
        if (!streamText || streamText.length === lastStreamedLength) return;
        try {
          if (!streamMessageId) {
            const displayText = streamText.slice(0, STREAM_MAX_MSG_LEN) + ' ...';
            const sent = await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
              bot.sendMessage(chatId, displayText)
            );
            if (sent?.message_id) {
              streamMessageId = sent.message_id;
              sentMessages.push(sent.message_id);
              streamedAnyText = true;
            }
          } else if (streamText.length > STREAM_MAX_MSG_LEN) {
            let splitAt = streamText.lastIndexOf('\n\n', STREAM_MAX_MSG_LEN);
            if (splitAt < STREAM_MAX_MSG_LEN * 0.3) splitAt = streamText.lastIndexOf('\n', STREAM_MAX_MSG_LEN);
            if (splitAt < STREAM_MAX_MSG_LEN * 0.3) splitAt = STREAM_MAX_MSG_LEN;
            const finalizedText = streamText.slice(0, splitAt);
            const remainingText = streamText.slice(splitAt).trimStart();
            await telegramEditSafe(chatId, streamMessageId, finalizedText);
            streamText = remainingText;
            if (remainingText.length > 0) {
              const displayText = remainingText + ' ...';
              const sent = await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
                bot.sendMessage(chatId, displayText)
              );
              if (sent?.message_id) {
                streamMessageId = sent.message_id;
                sentMessages.push(sent.message_id);
              }
            } else {
              streamMessageId = null;
            }
          } else {
            const displayText = streamText + ' ...';
            await telegramEditSafe(chatId, streamMessageId, displayText);
            streamedAnyText = true;
          }
          lastStreamUpdate = Date.now();
          lastStreamedLength = streamText.length;
        } catch (err) {
          console.error(`[${AGENT_ID}] Stream update error:`, err.message?.slice(0, 100));
        }
      }

      function maybeSendToolProgress() {
        const now = Date.now();
        if (now - lastProgressSent < 5000) return;
        if (!chatId || stopRequested) return;
        recentTools.push(lastActivity);
        if (recentTools.length > MAX_RECENT_TOOLS) recentTools.shift();
        lastProgressSent = now;
        const elapsed = Math.floor((now - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${secs}s`;

        if (streamedAnyText && streamMessageId) {
          const toolIndicator = `\n\n${lastActivity} (${timeStr})`;
          const displayText = streamText + toolIndicator;
          if (displayText.length < 3900) telegramEditSafe(chatId, streamMessageId, displayText);
        } else if (!progressMessageId) {
          const statusMsg = `${cfg.statusEmoji} ${AGENT_ID} (${model} | ${timeStr})\n${lastActivity}`;
          bot.sendMessage(chatId, statusMsg).then(sent => {
            if (sent?.message_id) progressMessageId = sent.message_id;
          }).catch(() => {});
        } else {
          let statusMsg = `${cfg.statusEmoji} ${AGENT_ID} (${model} | ${timeStr})`;
          for (const activity of recentTools.slice(-3)) statusMsg += `\n${activity}`;
          if (toolCount > 3) statusMsg += `\n${toolCount} operations total`;
          telegramEditSafe(chatId, progressMessageId, statusMsg);
        }
      }

      // Periodic progress timer
      const progressTimer = setInterval(() => {
        if (stopRequested) return;
        const now = Date.now();
        const elapsed = Math.floor((now - startTime) / 1000);
        if (elapsed < 20) return;
        if (now - lastProgressSent < 12000) return;
        lastProgressSent = now;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${secs}s`;

        // Time limit warning
        const timeRemaining = Math.floor((TIMEOUT_MS - elapsed * 1000) / 1000);
        if (timeRemaining <= 300 && timeRemaining > 0) {
          if (streamMessageId) {
            const warningText = `${streamText}\n\n⚠️ Time limit approaching (${Math.floor(timeRemaining / 60)}m remaining).`;
            if (warningText.length < 3900) telegramEditSafe(chatId, streamMessageId, warningText);
          }
        }

        if (streamedAnyText && streamMessageId) {
          const toolIndicator = `\n\n${lastActivity || 'Working...'} (${timeStr})`;
          const displayText = streamText + toolIndicator;
          if (displayText.length < 3900) telegramEditSafe(chatId, streamMessageId, displayText);
        } else if (!progressMessageId) {
          const statusMsg = `${cfg.statusEmoji} ${AGENT_ID} (${model} | ${timeStr})\n${lastActivity || 'Processing...'}`;
          bot.sendMessage(chatId, statusMsg).then(sent => {
            if (sent?.message_id) progressMessageId = sent.message_id;
          }).catch(() => {});
        } else {
          let statusMsg = `${cfg.statusEmoji} ${AGENT_ID} (${model} | ${timeStr})`;
          if (lastActivity) statusMsg += `\n${lastActivity}`;
          if (toolCount > 0) statusMsg += `\n${toolCount} operations`;
          statusMsg += '\n\n/stop to cancel';
          telegramEditSafe(chatId, progressMessageId, statusMsg);
        }
      }, 10000);

      // Hard timeout
      const timeoutTimer = setTimeout(() => {
        const timeoutSec = Math.floor(TIMEOUT_MS / 1000);
        console.error(`[${AGENT_ID}] Timeout after ${timeoutSec}s — killing`);
        if (chatId && streamMessageId) {
          bot.sendMessage(chatId, `⏱️ Task timeout after ${Math.floor(timeoutSec / 60)} minutes. Use /newsession to restart.`).catch(() => {});
        }
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      }, TIMEOUT_MS);

      proc.stdout.on('data', (data) => { processChunk(data.toString()); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', async (code) => {
        clearInterval(progressTimer);
        clearTimeout(timeoutTimer);
        activeProcess = null;

        // Process remaining buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer);
            hasStreamData = true;
            parsedEvents.push(event);
            processStreamEvent(event);
          } catch {}
        }

        if (stopRequested) {
          if (streamMessageId && streamText) {
            await telegramEditSafe(chatId, streamMessageId, streamText + '\n\nStopped by user.');
          }
          resolve({ text: '[Stopped by user.]', streamed: streamedAnyText });
          return;
        }

        // Extract response
        let response;
        if (streamedAnyText && streamText && streamText.trim().length > 0) {
          response = streamText.trim();
        } else if (hasStreamData) {
          response = extractResultFromEvents(parsedEvents);
        }
        if (!response && rawStdout.trim()) {
          try {
            const parsed = JSON.parse(rawStdout.trim());
            if (parsed.result && typeof parsed.result === 'string') {
              response = parsed.result;
            } else if (parsed.result && Array.isArray(parsed.result)) {
              response = parsed.result.filter(b => b.type === 'text').map(b => b.text).join('');
            }
          } catch {
            const lines = rawStdout.trim().split('\n').filter(l => l.trim());
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === 'result' && ev.result && typeof ev.result === 'string') {
                  response = ev.result;
                  break;
                }
              } catch {}
            }
            // Only use raw stdout as response if it's clearly NOT JSON data
            if (!response) {
              const trimmedOut = rawStdout.trim();
              const looksLikeJson = trimmedOut.startsWith('{') || trimmedOut.startsWith('[') ||
                trimmedOut.includes('"type":') || trimmedOut.includes('"result"') ||
                trimmedOut.includes('"total_cost_usd"') || trimmedOut.includes('"content_block"');
              if (!looksLikeJson && trimmedOut.length > 0 && trimmedOut.length < 10000) {
                response = trimmedOut;
              }
            }
          }
        }

        // Final safety: strip any response that's clearly raw JSON dumps
        if (response) {
          const trimResp = response.trim();
          if ((trimResp.startsWith('{') || trimResp.startsWith('[')) && trimResp.length > 2000) {
            try { JSON.parse(trimResp); response = null; } catch {}
          }
          if (response && response.split('\n').filter(l => { try { JSON.parse(l); return true; } catch { return false; } }).length > 5) {
            console.warn(`[${AGENT_ID}] Caught leaked JSON stream data, discarding raw output`);
            response = null;
          }
        }

        // ── Auto-continue on max_turns ──
        const stopReason = hasStreamData ? (parsedEvents.find(e => e.type === 'result')?.stop_reason) : null;
        const hitMaxTurns = stopReason === 'max_turns' ||
          rawStdout.includes('Reached max turns') || stderr.includes('Reached max turns') ||
          rawStdout.includes('max_turns') || (stderr || '').match(/Reached max turns\s*\(\d+\)/);

        if (hitMaxTurns) {
          const sessionId = existingSessionId || chatSessions[chatId]?.sessionId || parsedEvents.find(e => e.session_id)?.session_id || '';
          if (sessionId) {
            console.log(`[${AGENT_ID}] Hit max_turns — auto-continuing session ${sessionId.slice(0, 8)}...`);
            if (chatId) bot.sendMessage(chatId, `${cfg.statusEmoji} Hit turn limit — auto-continuing...`).catch(() => {});
            const contArgs = [
              '-p', 'Continue where you left off. Complete the task.',
              '--verbose', '--output-format', 'stream-json',
              '--max-turns', String(cfg.maxTurns), '--model', model,
              '--allowedTools', toolsStr,
              '--resume', sessionId,
              '--append-system-prompt', systemPrompt
            ];
            const contProc = spawn(CLAUDE_BIN, contArgs, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
            activeProcess = contProc;
            const contTimeout = setTimeout(() => {
              console.error(`[${AGENT_ID}] Continuation subprocess timeout (${SUBPROCESS_TIMEOUT_MS / 1000}s) — killing`);
              if (chatId) bot.sendMessage(chatId, `⏱️ Continuation timed out. Returning what we have so far.`).catch(() => {});
              contProc.kill('SIGTERM');
              setTimeout(() => { try { contProc.kill('SIGKILL'); } catch {} }, 5000);
            }, SUBPROCESS_TIMEOUT_MS);
            let contRaw = '', contErr = '';
            contProc.stdout.on('data', (d) => { contRaw += d.toString(); });
            contProc.stderr.on('data', (d) => { contErr += d.toString(); });
            contProc.on('close', (rc) => {
              clearTimeout(contTimeout);
              activeProcess = null;
              let contResponse = null;
              try {
                const events = contRaw.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
                contResponse = extractResultFromEvents(events);
              } catch {}
              if (!contResponse && contRaw.trim()) {
                try {
                  const parsed = JSON.parse(contRaw.trim());
                  if (parsed.result && typeof parsed.result === 'string') {
                    contResponse = parsed.result;
                  } else if (parsed.result && Array.isArray(parsed.result)) {
                    contResponse = parsed.result.filter(b => b.type === 'text').map(b => b.text).join('');
                  }
                } catch {
                  if (!contRaw.includes('"type":"result"') && !contRaw.includes('"sessionid"')) {
                    contResponse = contRaw.trim();
                  }
                }
              }
              const finalResp = contResponse || response;
              if (finalResp) {
                incrementSession(chatId);
                console.log(`[${AGENT_ID}] Continuation: ${finalResp.length} chars`);
                appendDailyMemory(userMessage, finalResp.length);
                sendLongMessage(chatId, finalResp);
                resolve({ text: finalResp, streamed: false });
              } else {
                if (response) {
                  resolve({ text: response, streamed: streamedAnyText });
                } else {
                  reject(new Error(`Continuation failed: ${contErr.slice(0, 200)}`));
                }
              }
            });
            return;
          }
        }

        if (code === 0 && response) {
          incrementSession(chatId);
          const sid = (existingSessionId || chatSessions[chatId]?.sessionId || '?').slice(0, 8);
          console.log(`[${AGENT_ID}] Done: ${response.length} chars (${model}, ${toolCount} tool ops, streamed: ${streamedAnyText}, session: ${sid})`);
          appendDailyMemory(userMessage, response.length);

          if (progressMessageId) {
            try { await bot.deleteMessage(chatId, progressMessageId); } catch {}
          }

          if (streamMessageId && streamedAnyText) {
            let editSuccess = false;
            if (response.length <= 4000) {
              try { await telegramEditSafe(chatId, streamMessageId, response); editSuccess = true; } catch {}
            } else {
              const MAX = 4000;
              let remaining = response;
              let firstChunk = true;
              while (remaining.length > 0) {
                let splitAt = remaining.length;
                if (remaining.length > MAX) {
                  splitAt = remaining.lastIndexOf('\n\n', MAX);
                  if (splitAt < MAX * 0.3) splitAt = remaining.lastIndexOf('\n', MAX);
                  if (splitAt < MAX * 0.3) splitAt = MAX;
                }
                const chunk = remaining.slice(0, splitAt);
                remaining = remaining.slice(splitAt).trimStart();
                if (firstChunk && streamMessageId) {
                  await telegramEditSafe(chatId, streamMessageId, chunk);
                  firstChunk = false;
                } else {
                  await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() =>
                    bot.sendMessage(chatId, chunk).catch(() => {})
                  );
                  await new Promise(r => setTimeout(r, 300));
                }
              }
              editSuccess = true;
            }
            if (!editSuccess) {
              sendLongMessage(chatId, response);
            }
          }

          resolve({ text: response, streamed: streamedAnyText });
        } else {
          // Failure path: retry
          if (isResume) {
            console.warn(`[${AGENT_ID}] Resume failed (code ${code}), clearing session. Retrying fresh...`);
            clearSession(chatId);
            if (chatId) bot.sendMessage(chatId, 'Previous session failed. Starting fresh...').catch(() => {});
            const freshSessionId = createSession(chatId, userId);
            const freshArgs = [...baseArgs, '--session-id', freshSessionId, '--system-prompt', systemPrompt];
            console.log(`[${AGENT_ID}] Fresh session ${freshSessionId.slice(0, 8)}...`);
            const freshProc = spawn(CLAUDE_BIN, freshArgs, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
            activeProcess = freshProc;
            const freshTimeout = setTimeout(() => {
              console.error(`[${AGENT_ID}] Fresh subprocess timeout (${SUBPROCESS_TIMEOUT_MS / 1000}s) — killing`);
              if (chatId) bot.sendMessage(chatId, `⏱️ Fresh session timed out. Please try again.`).catch(() => {});
              freshProc.kill('SIGTERM');
              setTimeout(() => { try { freshProc.kill('SIGKILL'); } catch {} }, 5000);
            }, SUBPROCESS_TIMEOUT_MS);
            let freshOut = '';
            let freshErr = '';
            freshProc.stdout.on('data', (d) => { freshOut += d.toString(); });
            freshProc.stderr.on('data', (d) => { freshErr += d.toString(); });
            freshProc.on('close', (rc) => {
              clearTimeout(freshTimeout);
              activeProcess = null;
              if (rc === 0 && freshOut.trim()) {
                let freshResponse = null;
                try {
                  const events = freshOut.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
                  freshResponse = extractResultFromEvents(events);
                } catch {}
                if (!freshResponse) freshResponse = freshOut.trim();
                incrementSession(chatId);
                console.log(`[${AGENT_ID}] Fresh session OK: ${freshResponse.length} chars`);
                appendDailyMemory(userMessage, freshResponse.length);
                sendLongMessage(chatId, freshResponse);
                resolve({ text: freshResponse, streamed: false });
              } else {
                reject(new Error(`Claude exited (${code}): ${stderr.slice(0, 300)}${freshErr ? ' | fresh: ' + freshErr.slice(0, 200) : ''}`));
              }
            });
          } else {
            console.log(`[${AGENT_ID}] stream-json failed (code ${code}), retrying text mode...`);
            clearSession(chatId);
            if (chatId) bot.sendMessage(chatId, 'Retrying with fallback mode...').catch(() => {});
            const retryArgs = baseArgs.map(a => a === 'stream-json' ? 'text' : a);
            retryArgs.push('--system-prompt', systemPrompt);
            const retryProc = spawn(CLAUDE_BIN, retryArgs, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
            activeProcess = retryProc;
            const retryTimeout = setTimeout(() => {
              console.error(`[${AGENT_ID}] Retry subprocess timeout (${SUBPROCESS_TIMEOUT_MS / 1000}s) — killing`);
              if (chatId) bot.sendMessage(chatId, `⏱️ Retry timed out. Please try again.`).catch(() => {});
              retryProc.kill('SIGTERM');
              setTimeout(() => { try { retryProc.kill('SIGKILL'); } catch {} }, 5000);
            }, SUBPROCESS_TIMEOUT_MS);
            let retryOut = '';
            let retryErr = '';
            retryProc.stdout.on('data', (d) => { retryOut += d.toString(); });
            retryProc.stderr.on('data', (d) => { retryErr += d.toString(); });
            retryProc.on('close', (rc) => {
              clearTimeout(retryTimeout);
              activeProcess = null;
              if (rc === 0 && retryOut.trim()) {
                incrementSession(chatId);
                console.log(`[${AGENT_ID}] text-mode retry OK: ${retryOut.trim().length} chars`);
                appendDailyMemory(userMessage, retryOut.trim().length);
                resolve({ text: retryOut.trim(), streamed: false });
              } else {
                reject(new Error(`Claude exited (${code}): ${stderr.slice(0, 300)}${retryErr ? ' | retry: ' + retryErr.slice(0, 200) : ''}`));
              }
            });
          }
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

  // ── Message Queue & Processor ─────────────────────────────────────────────
  const pendingQueue = [];
  const messageBuffer = new Map();
  const DEBOUNCE_MS = cfg.debounceMs;

  async function processMessage(chatId, combined, media, userId) {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    processing = true;
    try {
      const msgHash = recordProcessedMessage(chatId, combined);
      console.log(`[${AGENT_ID}] Processing message (hash: ${msgHash})`);
      fs.writeFileSync(PROCESSING_FILE, JSON.stringify({ chatId, startedAt: new Date().toISOString(), messageHash: msgHash }));

      // Pre-processing hook
      if (cfg.onMessage) {
        await cfg.onMessage({ text: combined, chatId, userId, mediaPath: media }, bot);
      }

      const result = await callClaude(combined, chatId, userId, media);

      // Post-processing hook
      if (cfg.onResponse) {
        await cfg.onResponse(result, { text: combined, chatId, userId }, bot);
      }

      if (typeof result === 'object' && result.streamed) {
        console.log(`[${AGENT_ID}] Response delivered via streaming (${result.text.length} chars)`);
      } else if (typeof result === 'object' && result.text) {
        sendLongMessage(chatId, result.text);
      } else if (typeof result === 'string') {
        sendLongMessage(chatId, result);
      } else {
        bot.sendMessage(chatId, 'Task completed but response was empty.').catch(() => {});
      }
      callCount++;
    } catch (err) {
      console.error(`[${AGENT_ID}] Error:`, err.message?.slice(0, 300));
      errorCount++;
      bot.sendMessage(chatId, friendlyError(err.message)).catch(() => {});
    } finally {
      try { fs.unlinkSync(PROCESSING_FILE); } catch {}
      processing = false;
      // Process next queued message
      if (pendingQueue.length > 0) {
        const next = pendingQueue.shift();
        console.log(`[${AGENT_ID}] Processing queued message (${pendingQueue.length} remaining)`);
        processMessage(next.chatId, next.text, next.media, next.userId);
      }
    }
  }

  // ── Incoming Messages ─────────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const username = msg.from?.username || String(userId);

    console.log(`[${AGENT_ID}] ${username}: ${(msg.text || '[media]').slice(0, 80)}`);

    if (!isUserAllowed(userId)) {
      console.log(`Blocked message from ${userId} (not in allowlist)`);
      return;
    }

    // ── /meeting commands ────────────────────────────────────────────────
    if (msg.text?.startsWith('/meeting')) {
      try {
        const handled = await meetingHandler.handle(msg);
        if (handled) return;
      } catch (err) {
        console.error(`[${AGENT_ID}] Meeting command error:`, err.message);
        bot.sendMessage(chatId, `Meeting error: ${err.message}`);
      }
      return;
    }

    // ── /stop command ─────────────────────────────────────────────────────
    if (msg.text === '/stop') {
      if (activeProcess) {
        stopRequested = true;
        activeProcess.kill('SIGTERM');
        setTimeout(() => { try { if (activeProcess) activeProcess.kill('SIGKILL'); } catch {} }, 3000);
        bot.sendMessage(chatId, 'Stopping...');
      } else {
        bot.sendMessage(chatId, 'No active task running.');
      }
      return;
    }

    // ── /newsession command ──────────────────────────────────────────────
    if (msg.text === '/newsession' || msg.text === '/new') {
      clearSession(chatId, 'reset');
      bot.sendMessage(chatId, '🔄 Session cleared. Next message starts a fresh conversation.');
      return;
    }

    // ── /sessions command ────────────────────────────────────────────────
    if (msg.text === '/sessions') {
      const formatted = formatSessionsList(AGENT_ID, 10);
      bot.sendMessage(chatId, formatted, { parse_mode: 'Markdown' });
      return;
    }

    // ── /resume command ──────────────────────────────────────────────────
    if (msg.text?.startsWith('/resume')) {
      const arg = msg.text.split(/\s+/)[1];
      if (!arg) {
        bot.sendMessage(chatId, 'Usage: /resume <number> or /resume <session-id>\nUse /sessions to see available sessions.');
        return;
      }
      let targetSession;
      if (/^\d+$/.test(arg)) {
        targetSession = getSessionByIndex(AGENT_ID, parseInt(arg, 10));
      } else {
        targetSession = getSessionById(AGENT_ID, arg);
      }
      if (!targetSession) {
        bot.sendMessage(chatId, 'Session not found. Use /sessions to see available sessions.');
        return;
      }
      // Archive current session first
      const currentSessionData = chatSessions[chatId];
      if (currentSessionData?.sessionId && currentSessionData.messageCount > 0) {
        try { archiveSession(AGENT_ID, currentSessionData, 'new_session'); }
        catch (e) { console.error(`[sessions] Archive failed:`, e.message); }
      }
      chatSessions[chatId] = {
        sessionId: targetSession.sessionId,
        ...(cfg.trackUserId ? { userId } : {}),
        startedAt: targetSession.startedAt,
        messageCount: targetSession.messageCount || 0,
        resumed: true,
        resumedAt: new Date().toISOString()
      };
      saveSessions(chatSessions);
      const topicsStr = targetSession.topics?.length ? `\nTopics: ${targetSession.topics.join(', ')}` : '';
      bot.sendMessage(chatId, `📎 Resumed session from *${new Date(targetSession.startedAt).toLocaleDateString()}* (${targetSession.messageCount} msgs)${topicsStr}\n\n_${targetSession.summary || 'No summary'}_`, { parse_mode: 'Markdown' });
      return;
    }

    // ── /model command ───────────────────────────────────────────────────
    if (msg.text?.startsWith('/model')) {
      const arg = msg.text.split(/\s+/)[1]?.toLowerCase();
      const validModels = ['opus', 'sonnet', 'haiku'];
      if (!arg) {
        const current = modelOverride || cfg.defaultModel;
        bot.sendMessage(chatId, `Current model: *${current}*${modelOverride ? ' (override)' : ' (default)'}\n\nUsage: /model [opus|sonnet|haiku]\n/model auto — reset to auto-routing`, { parse_mode: 'Markdown' });
        return;
      }
      if (arg === 'auto' || arg === 'reset') {
        modelOverride = null;
        bot.sendMessage(chatId, `Model reset to auto-routing (default: ${cfg.defaultModel})`);
        return;
      }
      if (!validModels.includes(arg)) {
        bot.sendMessage(chatId, `Invalid model. Choose: opus, sonnet, haiku, or auto`);
        return;
      }
      modelOverride = arg;
      bot.sendMessage(chatId, `Model set to *${arg}* for this session.`, { parse_mode: 'Markdown' });
      return;
    }

    // ── /status command ──────────────────────────────────────────────────
    if (msg.text === '/status') {
      const uptime = Math.floor(process.uptime());
      const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      const session = chatSessions[chatId];
      const currentModelStr = modelOverride || cfg.defaultModel;
      let statusMsg = `${cfg.statusEmoji} *${AGENT_ID}*\nUptime: ${uptime}s\nMemory: ${memMB}MB\nCalls: ${callCount}\nErrors: ${errorCount}\nModel: ${currentModelStr}`;
      if (session) statusMsg += `\nSession: ${session.sessionId.slice(0, 8)}... (${session.messageCount} msgs)`;
      bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
      return;
    }

    // ── /start command ───────────────────────────────────────────────────
    if (msg.text?.startsWith('/start')) {
      const teamLine = isTeamLeader(AGENT_ID) ? '\n• /team — Team leader commands (status, assign, meeting)' : '';
      const greeting = cfg.greeting || `${cfg.statusEmoji} *${AGENT_ID} Online*\n\nCommands:\n• /status — Agent status\n• /stop — Stop current task\n• /newsession — Reset conversation context\n• /sessions — View session history\n• /resume <n> — Resume a previous session\n• /model [opus|sonnet|haiku] — Switch model\n• /whatsnew — Latest features & commands\n• /changelog — Version history${teamLine}\n\nSend me a message to get started.`;
      bot.sendMessage(chatId, greeting, { parse_mode: 'Markdown' });
      return;
    }

    // ── Custom Commands ──────────────────────────────────────────────────
    if (cfg.customCommands && msg.text) {
      for (const [cmd, handler] of Object.entries(cfg.customCommands)) {
        if (msg.text === cmd || msg.text.startsWith(cmd + ' ')) {
          try {
            await handler(msg, bot, {
              chatId, userId, username,
              chatSessions, clearSession, createSession,
              sendLongMessage, callClaude, processMessage,
              processing, activeProcess,
            });
          } catch (e) {
            console.error(`[${AGENT_ID}] Custom command ${cmd} error:`, e.message);
            bot.sendMessage(chatId, `Error in ${cmd}: ${e.message?.slice(0, 200)}`).catch(() => {});
          }
          return;
        }
      }
    }

    // ── Media & Text Extraction ──────────────────────────────────────────
    let text = msg.text || msg.caption || '';
    let mediaPath = null;

    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      mediaPath = await downloadMedia(largest.file_id);
    } else if (msg.document) {
      mediaPath = await downloadMedia(msg.document.file_id);
      if (msg.document.file_name) text = `[File: ${msg.document.file_name}]\n${text}`;
    } else if (msg.voice) {
      mediaPath = await downloadMedia(msg.voice.file_id);
      try {
        const transcription = await transcribeAudio(mediaPath);
        text = `[Voice message transcription]: ${transcription}\n${text}`;
      } catch (err) {
        console.error('[voice] Transcription failed:', err.message);
        text = `[Voice message — transcription failed]\n${text}`;
      }
    } else if (msg.video) {
      mediaPath = await downloadMedia(msg.video.file_id);
    } else if (msg.audio) {
      mediaPath = await downloadMedia(msg.audio.file_id);
      if (msg.audio.title) text = `[Audio: ${msg.audio.title}]\n${text}`;
    }

    if (!text && !mediaPath) return;

    // ── Message Debounce & Buffering ─────────────────────────────────────
    if (!messageBuffer.has(chatId)) {
      messageBuffer.set(chatId, { messages: [], timer: null, mediaPath: null, userId });
    }
    const buffer = messageBuffer.get(chatId);
    if (text) buffer.messages.push(text);
    if (mediaPath) buffer.mediaPath = mediaPath;
    if (buffer.timer) clearTimeout(buffer.timer);

    buffer.timer = setTimeout(async () => {
      const combined = buffer.messages.join('\n');
      const media = buffer.mediaPath;
      const bufUserId = buffer.userId;
      messageBuffer.delete(chatId);
      if (!combined && !media) return;

      // Queue message if already processing
      if (processing) {
        pendingQueue.push({ chatId, text: combined, media, userId: bufUserId });
        bot.sendMessage(chatId, '📥 Queued — will process right after the current task.').catch(() => {});
        console.log(`[${AGENT_ID}] Message queued (queue size: ${pendingQueue.length})`);
        return;
      }

      await processMessage(chatId, combined, media, bufUserId);
    }, DEBOUNCE_MS);
  });

  // ── Typing indicator while processing (with stuck watchdog) ──────────────
  const typingInterval = setInterval(() => {
    try {
      if (!fs.existsSync(PROCESSING_FILE)) return;
      const data = JSON.parse(fs.readFileSync(PROCESSING_FILE, 'utf-8'));
      if (!data.chatId) return;

      // Watchdog: if processing.json is older than STUCK_WATCHDOG_MS, force-reset
      const startedAt = data.startedAt ? new Date(data.startedAt).getTime() : 0;
      const elapsed = startedAt ? (Date.now() - startedAt) : 0;
      if (startedAt && elapsed > STUCK_WATCHDOG_MS) {
        console.error(`[${AGENT_ID}] WATCHDOG: Processing stuck for ${Math.floor(elapsed / 60000)}m — force-resetting`);
        bot.sendMessage(data.chatId, `⚠️ Task exceeded ${Math.floor(STUCK_WATCHDOG_MS / 60000)} minutes and appears stuck. Resetting — please resend your message.`).catch(() => {});
        if (activeProcess) {
          try { activeProcess.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { if (activeProcess) activeProcess.kill('SIGKILL'); } catch {} }, 3000);
        }
        try { fs.unlinkSync(PROCESSING_FILE); } catch {}
        processing = false;
        return;
      }

      bot.sendChatAction(data.chatId, 'typing').catch(() => {});
    } catch {}
  }, 4000);

  // ── Health Heartbeat ──────────────────────────────────────────────────────
  function writeHealth() {
    try {
      fs.writeFileSync(HEALTH_FILE, JSON.stringify({
        alive: true,
        agent: AGENT_ID,
        version: 'template-1.0',
        uptime: Math.floor(process.uptime()),
        calls: callCount,
        errors: errorCount,
        model: modelOverride || cfg.defaultModel,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        ts: new Date().toISOString()
      }, null, 2));
    } catch {}
  }
  const healthInterval = setInterval(writeHealth, 60000);
  writeHealth();

  // ── Graceful Shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${AGENT_ID}] ${signal} — shutting down`);
    writeHealth();
    clearInterval(typingInterval);
    clearInterval(healthInterval);
    try { fs.unlinkSync(PROCESSING_FILE); } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (startupCleanup) {
      try { startupCleanup(); } catch {}
    }
    if (activeProcess) {
      try { activeProcess.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (activeProcess) activeProcess.kill('SIGKILL'); } catch {} }, 2000);
    }
    try { await bot.stopPolling({ cancel: true }); } catch {}
    setTimeout(() => process.exit(0), 1500);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[FATAL]', err.message);
    errorCount++;
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    errorCount++;
  });

  console.log(`${cfg.statusEmoji} ${AGENT_ID} ready. Waiting for messages...`);

  // ── Return control handles ────────────────────────────────────────────────
  return {
    bot,
    shutdown,
    getState: () => ({
      callCount,
      errorCount,
      processing,
      activeProcess: !!activeProcess,
      modelOverride,
      sessions: { ...chatSessions },
      pendingQueue: pendingQueue.length,
    }),
    sendMessage: (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
    sendLongMessage,
  };
}

export default createBot;
