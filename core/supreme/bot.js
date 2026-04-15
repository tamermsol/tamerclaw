/**
 * Supreme Agent Bot v3.0 — Live Streaming + Robust Singleton
 *
 * Standalone Telegram bot for the Supreme meta-agent.
 * Runs on its own token, independent from the relay system.
 *
 * Flow: Telegram message → claude CLI (stream-json) → live edit-in-place → Telegram
 * Streams text to Telegram as it's generated, editing the message in real-time.
 *
 * Singleton: Uses flock() on a lock file to guarantee only one instance polls Telegram.
 * Self-protection: Claude CLI is forbidden from restarting this service or editing bot.js.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import TelegramBot from 'node-telegram-bot-api';
import paths from '../shared/paths.js';
import { UpdateAnnouncer } from '../shared/update-announcer.js';

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

// ── Config ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(paths.config)) {
  console.error(`[FATAL] Config not found: ${paths.config}`);
  console.error('Run: tamerclaw init');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
const TOKEN = config.agents?.supreme?.botToken || '';
const AGENT_ID = 'supreme';
const SUPREME_DIR = paths.supreme;          // core/supreme (code only)
const AGENT_DIR = paths.agentDir(AGENT_ID); // user/agents/supreme (runtime data)
const AGENTS_DIR = paths.agents;            // user/agents/
const SHARED_DIR = paths.shared;            // core/shared/
const CONFIG_PATH = paths.config;
const CWD = paths.home;                     // Supreme works from the TAMERCLAW_HOME root

const CREDENTIALS_DIR = paths.credentials;
const INBOX = path.join(SUPREME_DIR, 'inbox.jsonl');
const OUTBOX_DIR = path.join(SUPREME_DIR, 'outbox');
const PROCESSED = path.join(SUPREME_DIR, 'processed.txt');
const PROCESSING_FILE = path.join(SUPREME_DIR, 'processing.json');
const HEALTH_FILE = path.join(SUPREME_DIR, 'health.json');

// Ensure dirs
for (const dir of [OUTBOX_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Singleton Guard ──────────────────────────────────────────────────────────
// Kill any OTHER supreme bot.js processes (not relay, not us) to prevent 409.
const LOCK_FILE = path.join(SUPREME_DIR, 'bot.lock');
try {
  // Check if a previous supreme bot.js is still running via lock file
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    if (oldPid && oldPid !== String(process.pid)) {
      try {
        // Verify it's actually a supreme bot.js (check cwd)
        const cwd = fs.readlinkSync(`/proc/${oldPid}/cwd`);
        if (cwd.includes('supreme')) {
          console.log(`[startup] Killing old supreme bot (PID ${oldPid})`);
          process.kill(Number(oldPid), 'SIGKILL');
          execSync('sleep 3'); // Let Telegram release polling session
        }
      } catch {
        // Process doesn't exist or no permission — stale lock
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {
  console.error('[WARN] Lock setup:', e.message);
}

// ── Bot Init ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log('👑 Supreme Agent Bot v3.0 (streaming + singleton guard) started');
console.log(`Token: ...${TOKEN.slice(-8)} | PID: ${process.pid}`);

// ── Update Announcer ─────────────────────────────────────────────────────────
const announcer = new UpdateAnnouncer(AGENT_DIR, CWD);
const pendingUpdate = announcer.checkPendingUpdate();
if (pendingUpdate) {
  console.log(`[supreme] Post-update announcement queued: v${pendingUpdate.oldVersion} → v${pendingUpdate.newVersion}`);
}

// ── State ─────────────────────────────────────────────────────────────────────
let activeProcess = null;
let stopRequested = false;
let callCount = 0;
let errorCount = 0;
let processing = false;

// ── Usage Tracking ──────────────────────────────────────────────────────────
const USAGE_FILE = path.join(SUPREME_DIR, 'usage.json');
let sessionUsage = {
  totalInputTokens: 0, totalOutputTokens: 0,
  totalCacheRead: 0, totalCacheCreation: 0,
  totalCalls: 0, sessionStart: Date.now(), lastCallTime: null
};
try {
  if (fs.existsSync(USAGE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    const today = new Date().toISOString().slice(0, 10);
    if (saved.date === today) Object.assign(sessionUsage, saved);
  }
} catch {}
function saveUsage() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(USAGE_FILE, JSON.stringify({ ...sessionUsage, date: today }, null, 2));
  } catch {}
}

// ── Allowlist ─────────────────────────────────────────────────────────────────
function isUserAllowed(userId) {
  try {
    // Try per-agent allowlist first, fall back to default
    let filePath = path.join(CREDENTIALS_DIR, `telegram-supreme-allowFrom.json`);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(CREDENTIALS_DIR, 'telegram-default-allowFrom.json');
    }
    if (!fs.existsSync(filePath)) return true;
    const allowlist = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (allowlist.allowAll) return true;
    if (allowlist.users && Array.isArray(allowlist.users)) {
      return allowlist.users.includes(userId) || allowlist.users.includes(String(userId));
    }
    return true;
  } catch { return true; }
}

// ── Processed Tracking ────────────────────────────────────────────────────────
function getProcessed() {
  try { return new Set(fs.readFileSync(PROCESSED, 'utf-8').trim().split('\n').filter(Boolean)); }
  catch { return new Set(); }
}

function markProcessed(id) {
  fs.appendFileSync(PROCESSED, id + '\n');
}

// ── Memory ────────────────────────────────────────────────────────────────────
function loadRecentMemory() {
  const memDir = path.join(AGENT_DIR, 'memory');
  const parts = [];
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
    const entry = `\n[${time}] User: ${summary}${userMessage.length > 200 ? '...' : ''} → responded (${responseLength} chars)\n`;
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath, `# ${today} — Supreme Agent\n\n## Conversation Log\n`);
    }
    fs.appendFileSync(memPath, entry);
  } catch (e) {
    console.error('[memory] Write failed:', e.message);
  }
}

// ── System Prompt Builder ─────────────────────────────────────────────────────
function buildSystemPrompt() {
  const parts = [];

  // 1. Identity
  try { parts.push(fs.readFileSync(path.join(AGENT_DIR, 'IDENTITY.md'), 'utf-8')); } catch {}

  // 2. SOUL
  try { parts.push(fs.readFileSync(path.join(SHARED_DIR, 'SOUL.md'), 'utf-8')); } catch {}

  // 3. Global Policy
  try { parts.push(fs.readFileSync(path.join(SHARED_DIR, 'GLOBAL_POLICY.md'), 'utf-8')); } catch {}

  // 4. User
  try { parts.push(fs.readFileSync(path.join(AGENT_DIR, 'USER.md'), 'utf-8')); } catch {}

  // 5. Tools (comprehensive system knowledge)
  try { parts.push(fs.readFileSync(path.join(AGENT_DIR, 'TOOLS.md'), 'utf-8')); } catch {}

  // 6. Long-term memory
  try {
    const memMd = fs.readFileSync(path.join(AGENT_DIR, 'MEMORY.md'), 'utf-8');
    if (memMd.trim()) parts.push('# Long-term Memory\n' + memMd.slice(0, 5000));
  } catch {}

  // 7. Recent daily memory
  parts.push(...loadRecentMemory());

  // 8. Live system state snapshot
  let agentList = '';
  try {
    const dirs = fs.readdirSync(AGENTS_DIR).filter(f =>
      fs.statSync(path.join(AGENTS_DIR, f)).isDirectory() && f !== 'supreme'
    );
    agentList = dirs.join(', ');
  } catch {}

  parts.push(`
# Supreme Agent Instructions
You are the **Supreme Agent** managing the TamerClaw ecosystem via Telegram.
Your working directory is ${CWD} — you have FULL access to everything.

## Available Agents
${agentList}

## Current Date
${new Date().toISOString().slice(0, 10)}

## Important
- You can read, edit, create, and delete ANY file in ${CWD}/
- You can run shell commands to check processes, restart services, view logs
- You can modify config.json (ALWAYS backup first: cp config.json config.json.bak)
- You can create new agents by following the directory structure pattern
- You can fix bugs in any agent's code, identity, or configuration
- For Telegram responses: no markdown tables, keep concise, use bullet lists
- Write significant actions to your daily memory file
- When creating/modifying agents, always ensure IDENTITY.md follows the standard format
- Proceed with full implementation by default — don't ask for step-by-step approval

## CRITICAL: Self-Protection Rules
- NEVER run: systemctl restart supreme-agent, systemctl stop supreme-agent, or kill commands targeting your own PID (${process.pid}) or bot.js processes
- NEVER edit ${SUPREME_DIR}/bot.js — that is YOUR running code. Editing it triggers a restart loop.
- NEVER modify /etc/systemd/system/supreme-agent.service
- If you need to fix the supreme agent itself, write the fix plan to ${SUPREME_DIR}/outbox/ and tell the user to apply it manually
- You CAN safely restart OTHER services (like claude-agents.service for the bridge)

## Telegram Formatting
- No markdown tables (use bullet lists)
- Keep messages concise for mobile
- Use emoji sparingly`);

  return parts.join('\n\n---\n\n');
}

// ── Telegram Stream Helpers ───────────────────────────────────────────────────

const TELEGRAM_MAX_LEN = 4096;

async function telegramEditSafe(chatId, messageId, text) {
  // Truncate if needed — keep it under limit with clean cut
  let safeText = text;
  if (text.length > TELEGRAM_MAX_LEN) {
    let cutAt = text.lastIndexOf('\n', TELEGRAM_MAX_LEN - 30);
    if (cutAt < TELEGRAM_MAX_LEN * 0.5) cutAt = TELEGRAM_MAX_LEN - 30;
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
      return true; // Harmless — same text
    } else if (err.response?.statusCode === 429) {
      const wait = (err.response.body?.parameters?.retry_after || 2) * 1000;
      if (wait > 10000) return false; // Don't wait too long
      await new Promise(r => setTimeout(r, wait + 200));
      try {
        await bot.editMessageText(safeText, { chat_id: chatId, message_id: messageId });
        return true;
      } catch { return false; }
    }
    console.error('[supreme] editSafe error:', err.message?.slice(0, 100));
    return false;
  }
}

// Extract final assistant text from stream-json events
function extractResultFromEvents(events) {
  const texts = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'result' && ev.result) {
      // Result event with direct text
      if (typeof ev.result === 'string') return ev.result;
      // Result event with content blocks
      if (Array.isArray(ev.result)) {
        for (const block of ev.result) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
        if (texts.length) return texts.join('\n\n');
      }
    }
    // Also check for assistant messages
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) texts.push(block.text);
      }
    }
  }
  // If we got texts from the last assistant message, return them
  if (texts.length) return texts.join('\n\n');
  return null;
}

// ── Claude CLI Execution (streaming with live Telegram updates) ───────────────

function callClaude(message, chatId, mediaPath = null) {
  return new Promise((resolve, reject) => {
    const systemPrompt = buildSystemPrompt();

    let userMessage = message;
    if (mediaPath) {
      userMessage = `[Media file at: ${mediaPath}]\n\n${message || 'User sent a media file.'}`;
    }

    console.log(`[supreme] Processing: "${userMessage.slice(0, 100)}..."`);

    const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
    const tools = 'Read Write Edit Bash Glob Grep Agent WebSearch WebFetch';

    // Build args array directly — avoids shell expansion that broke --max-turns
    // when system prompt contained backticks, $, or " characters
    const args = [
      '-p', userMessage,
      '--verbose',
      '--output-format', 'stream-json',
      '--max-turns', '500',
      '--model', 'opus',
      '--allowedTools', tools,
      '--system-prompt', systemPrompt
    ];

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
    }
    env.HOME = process.env.HOME || os.homedir();

    const proc = spawn(CLAUDE_BIN, args, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;
    stopRequested = false;

    let rawStdout = '';
    let stderr = '';
    const startTime = Date.now();

    // ── Stream-json parsing state ──
    const parsedEvents = [];
    let lineBuffer = '';
    let hasStreamData = false;

    // ── Live Telegram streaming state ──
    let streamText = '';           // Accumulated assistant text
    let streamMessageId = null;    // Telegram message ID we're editing in-place
    let lastStreamUpdate = 0;      // Timestamp of last edit
    let lastStreamedLength = 0;    // Text length at last edit
    let streamedAnyText = false;
    let streamUpdatePending = false;
    let sentMessages = [];         // All sent message IDs (for multi-message responses)
    let lastTextBlockEnd = 0;      // Track end of last text block to add separators
    let inToolPhase = false;       // True when we're between text blocks (doing tool calls)
    let streamSendInFlight = null; // Track pending doStreamUpdate promise to prevent race condition

    // ── Tool activity tracking ──
    let lastActivity = '';
    let toolCount = 0;
    let lastProgressSent = 0;
    let progressMessageId = null;  // Editable progress message during tool phases

    function formatToolActivity(toolName, input) {
      const desc = {
        'Read': `📖 Reading ${input?.file_path?.split('/').pop() || 'file'}`,
        'Write': `✍️ Writing ${input?.file_path?.split('/').pop() || 'file'}`,
        'Edit': `✏️ Editing ${input?.file_path?.split('/').pop() || 'file'}`,
        'Bash': `💻 Running command`,
        'Glob': `🔍 Searching files`,
        'Grep': `🔎 Searching content`,
        'Agent': `🤖 Launching sub-agent`,
        'WebSearch': `🌐 Searching web`,
        'WebFetch': `🌐 Fetching URL`,
      };
      return desc[toolName] || `🔧 ${toolName}`;
    }

    // Parse stream-json lines
    function processChunk(chunk) {
      rawStdout += chunk;
      lineBuffer += chunk;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          hasStreamData = true;
          parsedEvents.push(event);
          processStreamEvent(event);
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    function processStreamEvent(event) {
      // Track tool usage
      if (event.type === 'tool_use') {
        const toolName = event.tool || event.name || (event.tool_use?.name) || 'tool';
        const toolInput = event.input || (event.tool_use?.input) || {};
        lastActivity = formatToolActivity(toolName, toolInput);
        toolCount++;
        inToolPhase = true;
        maybeSendToolProgress();
      }

      // Track token usage from events
      if (event.type === 'result' && event.usage) {
        sessionUsage.totalInputTokens += event.usage.input_tokens || 0;
        sessionUsage.totalOutputTokens += event.usage.output_tokens || 0;
        sessionUsage.totalCacheRead += event.usage.cache_read_input_tokens || 0;
        sessionUsage.totalCacheCreation += event.usage.cache_creation_input_tokens || 0;
        sessionUsage.lastCallTime = Date.now();
        saveUsage();
      }

      // Assistant message content blocks
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            lastActivity = formatToolActivity(block.name, block.input);
            toolCount++;
            inToolPhase = true;
            maybeSendToolProgress();
          }
          if (block.type === 'text' && block.text) {
            // Add separator if we're coming back from a tool phase
            if (inToolPhase && streamText.length > 0) {
              streamText += '\n\n';
            }
            inToolPhase = false;
            streamText += block.text;
            lastTextBlockEnd = streamText.length;
            scheduleStreamUpdate();
          }
        }
      }

      // Incremental text deltas
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
        // Add separator if first text after tool phase
        if (inToolPhase && streamText.length > 0) {
          streamText += '\n\n';
        }
        inToolPhase = false;
        streamText += event.delta.text;
        lastTextBlockEnd = streamText.length;
        scheduleStreamUpdate();
      }
    }

    // Debounced stream update — edit Telegram message with accumulated text
    function scheduleStreamUpdate() {
      if (streamUpdatePending) return;
      const now = Date.now();
      const timeSince = now - lastStreamUpdate;
      const newChars = streamText.length - lastStreamedLength;

      // First chunk: send immediately after 30+ chars
      // Subsequent: every 1.5s with new content
      const delay = !streamMessageId ? (newChars >= 30 ? 0 : 500) :
                    (timeSince >= 1500 && newChars > 0) ? 0 : Math.max(0, 1500 - timeSince);

      if (delay === 0) {
        streamSendInFlight = doStreamUpdate();
      } else {
        streamUpdatePending = true;
        setTimeout(() => {
          streamUpdatePending = false;
          streamSendInFlight = doStreamUpdate();
        }, delay);
      }
    }

    async function doStreamUpdate() {
      if (!streamText || streamText.length === lastStreamedLength) return;

      // Determine what text goes in the current message
      // If total text exceeds 3800 chars (leaving room for cursor), finalize current msg and start new one
      const MAX_MSG_LEN = 3800;

      try {
        if (!streamMessageId) {
          // First message — send new
          const displayText = streamText.slice(0, MAX_MSG_LEN) + ' ▌';
          const sent = await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
            bot.sendMessage(chatId, displayText)
          );
          if (sent?.message_id) {
            streamMessageId = sent.message_id;
            sentMessages.push(sent.message_id);
            streamedAnyText = true;
          }
        } else if (streamText.length > MAX_MSG_LEN) {
          // Text exceeds current message limit — finalize current, start new message
          // Find a good split point (paragraph or line boundary)
          let splitAt = streamText.lastIndexOf('\n\n', MAX_MSG_LEN);
          if (splitAt < MAX_MSG_LEN * 0.3) splitAt = streamText.lastIndexOf('\n', MAX_MSG_LEN);
          if (splitAt < MAX_MSG_LEN * 0.3) splitAt = MAX_MSG_LEN;

          const finalizedText = streamText.slice(0, splitAt);
          const remainingText = streamText.slice(splitAt).trimStart();

          // Finalize current message (remove cursor)
          await telegramEditSafe(chatId, streamMessageId, finalizedText);

          // Update streamText to only contain the overflow
          streamText = remainingText;
          lastTextBlockEnd = streamText.length;

          // Send new message for the overflow
          if (remainingText.length > 0) {
            const displayText = remainingText + ' ▌';
            const sent = await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
              bot.sendMessage(chatId, displayText)
            );
            if (sent?.message_id) {
              streamMessageId = sent.message_id;
              sentMessages.push(sent.message_id);
            }
          } else {
            streamMessageId = null; // Will create new message on next text
          }
        } else {
          // Normal edit — update in-place with cursor
          const displayText = streamText + ' ▌';
          await telegramEditSafe(chatId, streamMessageId, displayText);
          streamedAnyText = true;
        }
        lastStreamUpdate = Date.now();
        lastStreamedLength = streamText.length;
      } catch (err) {
        console.error('[supreme] Stream update error:', err.message?.slice(0, 100));
      }
    }

    // Track recent tool activities for progress display
    let recentTools = [];  // Last N tool activities
    const MAX_RECENT_TOOLS = 5;

    // Tool progress — show activity both before and during text streaming
    function maybeSendToolProgress() {
      const now = Date.now();
      if (now - lastProgressSent < 5000) return; // Throttle to 5s
      if (!chatId || stopRequested) return;

      // Track recent activities
      recentTools.push(lastActivity);
      if (recentTools.length > MAX_RECENT_TOOLS) recentTools.shift();

      lastProgressSent = now;
      const elapsed = Math.floor((now - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${secs}s`;

      if (streamedAnyText && streamMessageId) {
        // During text streaming: append tool activity to the streamed message
        const toolIndicator = `\n\n⏳ ${lastActivity} (${timeStr})`;
        const displayText = streamText + toolIndicator;
        if (displayText.length < 3900) {
          telegramEditSafe(chatId, streamMessageId, displayText);
        }
      } else if (!progressMessageId) {
        // First progress message — send new, we'll edit it in place
        const statusMsg = `👑 Supreme (${timeStr})\n${lastActivity}`;
        bot.sendMessage(chatId, statusMsg).then(sent => {
          if (sent?.message_id) progressMessageId = sent.message_id;
        }).catch(() => {});
      } else {
        // Edit existing progress message with latest activity
        let statusMsg = `👑 Supreme (${timeStr})`;
        for (const activity of recentTools.slice(-3)) {
          statusMsg += `\n${activity}`;
        }
        if (toolCount > 3) statusMsg += `\n📊 ${toolCount} operations total`;
        telegramEditSafe(chatId, progressMessageId, statusMsg);
      }
    }

    // Fallback progress — keeps user informed during long silences
    const progressTimer = setInterval(() => {
      if (stopRequested) return;
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      if (elapsed < 20) return; // Silent for first 20s
      if (now - lastProgressSent < 12000) return; // 12s since any update

      lastProgressSent = now;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${secs}s`;

      if (streamedAnyText && streamMessageId) {
        // Append status to existing stream message
        const toolIndicator = `\n\n⏳ ${lastActivity || 'Working...'} (${timeStr})`;
        const displayText = streamText + toolIndicator;
        if (displayText.length < 3900) {
          telegramEditSafe(chatId, streamMessageId, displayText);
        }
      } else if (!progressMessageId) {
        // Create initial progress message
        const statusMsg = `👑 Supreme (${timeStr})\n${lastActivity || 'Processing...'}`;
        bot.sendMessage(chatId, statusMsg).then(sent => {
          if (sent?.message_id) progressMessageId = sent.message_id;
        }).catch(() => {});
      } else {
        // Edit existing progress message
        let statusMsg = `👑 Supreme (${timeStr})`;
        if (lastActivity) statusMsg += `\n${lastActivity}`;
        if (toolCount > 0) statusMsg += `\n📊 ${toolCount} operations`;
        statusMsg += '\n\n/stop to cancel';
        telegramEditSafe(chatId, progressMessageId, statusMsg);
      }
    }, 10000);

    // 30 min timeout
    const timeoutTimer = setTimeout(() => {
      console.error('[supreme] Timeout after 1800s — killing');
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    }, 1800000);

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

      // Wait for any in-flight stream send to complete before checking streamedAnyText
      // This prevents the race condition where fast responses cause double messages
      if (streamSendInFlight) {
        try { await streamSendInFlight; } catch {}
        await new Promise(r => setTimeout(r, 100));
      }

      if (stopRequested) {
        if (streamMessageId && streamText) {
          await telegramEditSafe(chatId, streamMessageId, streamText + '\n\n🛑 _Stopped by user._');
        }
        resolve({ text: '[Stopped by user.]', streamed: streamedAnyText });
        return;
      }

      // Extract final response
      // Prefer streamText (preserves formatting from live streaming) over re-extraction
      let response;
      if (streamedAnyText && streamText && streamText.trim().length > 0) {
        response = streamText.trim();
      } else if (hasStreamData) {
        response = extractResultFromEvents(parsedEvents);
      }
      if (!response && rawStdout.trim()) {
        response = rawStdout.trim();
      }

      // ── Auto-continue on max_turns (regardless of exit code) ──
      const stopReason = hasStreamData ? (parsedEvents.find(e => e.type === 'result')?.stop_reason) : null;
      const hitMaxTurns = stopReason === 'max_turns' ||
        rawStdout.includes('Reached max turns') || stderr.includes('Reached max turns') ||
        rawStdout.includes('max_turns') || (stderr || '').match(/Reached max turns\s*\(\d+\)/);

      if (hitMaxTurns) {
        const sessionId = parsedEvents.find(e => e.session_id)?.session_id || '';
        if (sessionId) {
          console.log(`[supreme] Hit max_turns — auto-continuing session ${sessionId.slice(0, 8)}...`);
          if (chatId) bot.sendMessage(chatId, '👑 Supreme hit turn limit — auto-continuing...').catch(() => {});
          const contArgs = [
            '-p', 'Continue where you left off. Complete the task.',
            '--verbose', '--output-format', 'stream-json',
            '--max-turns', '500', '--model', 'opus',
            '--allowedTools', tools,
            '--resume', sessionId,
            '--append-system-prompt', args.find((a, i) => args[i - 1] === '--system-prompt' || args[i - 1] === '--append-system-prompt') || ''
          ];
          const contProc = spawn(CLAUDE_BIN, contArgs, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
          activeProcess = contProc;
          let contRaw = '', contErr = '';
          let contStreamText = '';
          let contStreamMsgId = null;
          let contLastUpdate = 0;
          let contLineBuffer = '';

          function processContLine(line) {
            if (!line.trim()) return;
            try {
              const event = JSON.parse(line);
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text' && block.text) contStreamText += block.text;
                }
              }
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
                contStreamText += event.delta.text;
              }
            } catch {}
          }

          function processContChunk(chunk) {
            contRaw += chunk;
            contLineBuffer += chunk;
            const lines = contLineBuffer.split('\n');
            contLineBuffer = lines.pop();
            for (const line of lines) processContLine(line);

            // Live stream to Telegram (throttled to 1.5s)
            const now = Date.now();
            if (contStreamText.length > 0 && (now - contLastUpdate > 1500)) {
              contLastUpdate = now;
              const displayText = contStreamText.length > 3800
                ? contStreamText.slice(0, 3800) + ' ▌'
                : contStreamText + ' ▌';
              if (!contStreamMsgId) {
                bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' }).catch(() =>
                  bot.sendMessage(chatId, displayText)
                ).then(sent => {
                  if (sent?.message_id) contStreamMsgId = sent.message_id;
                }).catch(() => {});
              } else {
                telegramEditSafe(chatId, contStreamMsgId, displayText);
              }
            }
          }

          contProc.stdout.on('data', (d) => { processContChunk(d.toString()); });
          contProc.stderr.on('data', (d) => { contErr += d.toString(); });
          contProc.on('close', async (rc) => {
            activeProcess = null;
            // Process remaining buffer
            if (contLineBuffer.trim()) processContLine(contLineBuffer);

            // Try structured extraction as backup
            let contResponse = null;
            try {
              const events = contRaw.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
              contResponse = events.filter(e => e.type === 'result').map(e =>
                (e.result || []).filter(b => b.type === 'text').map(b => b.text).join('')
              ).join('') || events.filter(e => e.type === 'assistant').map(e =>
                (e.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
              ).join('\n\n');
            } catch {}

            // NEVER fall back to raw JSON — use streamed text, parsed result, or original response
            const finalResp = contStreamText.trim() || contResponse || response;
            if (finalResp) {
              console.log(`[supreme] ✅ Continuation: ${finalResp.length} chars`);
              appendDailyMemory(userMessage, finalResp.length);
              if (contStreamMsgId) {
                const chunks = [];
                let rem = finalResp;
                while (rem.length > 0) {
                  let splitAt = rem.length > 4000 ? (rem.lastIndexOf('\n\n', 4000) > 1200 ? rem.lastIndexOf('\n\n', 4000) : 4000) : rem.length;
                  chunks.push(rem.slice(0, splitAt));
                  rem = rem.slice(splitAt).trimStart();
                }
                await telegramEditSafe(chatId, contStreamMsgId, chunks[0]);
                for (let i = 1; i < chunks.length; i++) {
                  await bot.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown' }).catch(() =>
                    bot.sendMessage(chatId, chunks[i]).catch(() => {})
                  );
                }
              } else {
                sendLongMessage(chatId, finalResp);
              }
              resolve({ text: finalResp, streamed: !!contStreamMsgId });
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
        console.log(`[supreme] ✅ ${response.length} chars (${toolCount} tool ops, streamed: ${streamedAnyText})`);
        appendDailyMemory(userMessage, response.length);

        // Delete the progress message if we had one
        if (progressMessageId) {
          try { await bot.deleteMessage(chatId, progressMessageId); } catch {}
        }

        // Final edit — remove cursor, show clean response
        if (streamMessageId && streamedAnyText) {
          let editSuccess = false;
          // If response fits in current message, just edit it
          if (response.length <= 4000) {
            try {
              await telegramEditSafe(chatId, streamMessageId, response);
              editSuccess = true;
            } catch {}
          } else {
            // Long response — split and send as multiple messages
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

          // If streaming edit failed, fall back to sending as new message
          if (!editSuccess) {
            console.log('[supreme] Stream final edit failed, falling back to regular send');
            sendLongMessage(chatId, response);
          }
        }

        resolve({ text: response, streamed: streamedAnyText });
      } else {
        // Stream-json failed — notify user and retry
        console.log(`[supreme] ⚠️ stream-json failed (code ${code}), retrying with text mode...`);
        if (chatId) {
          bot.sendMessage(chatId, '⏳ Retrying with fallback mode...').catch(() => {});
        }
        const retryArgs = args.map(a => a === 'stream-json' ? 'text' : a);
        const retryProc = spawn(CLAUDE_BIN, retryArgs, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
        activeProcess = retryProc;

        let retryOut = '';
        let retryErr = '';
        retryProc.stdout.on('data', (d) => { retryOut += d.toString(); });
        retryProc.stderr.on('data', (d) => { retryErr += d.toString(); });
        retryProc.on('close', (rc) => {
          activeProcess = null;
          if (rc === 0 && retryOut.trim()) {
            console.log(`[supreme] ✅ text-mode retry OK: ${retryOut.trim().length} chars`);
            appendDailyMemory(userMessage, retryOut.trim().length);
            resolve({ text: retryOut.trim(), streamed: false });
          } else {
            reject(new Error(`Claude exited (${code}): ${stderr.slice(0, 300)}${retryErr ? ' | retry: ' + retryErr.slice(0, 200) : ''}`));
          }
        });
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

// ── Outbox ────────────────────────────────────────────────────────────────────
function writeOutbox(chatId, text) {
  const id = Date.now().toString();
  fs.writeFileSync(path.join(OUTBOX_DIR, `${id}.json`), JSON.stringify({ chatId, text }));
}

// ── Long Message Splitting ────────────────────────────────────────────────────
function sendLongMessage(chatId, text) {
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

// ── Media Download ────────────────────────────────────────────────────────────
async function downloadMedia(fileId) {
  const mediaDir = path.join(AGENT_DIR, 'media');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  try {
    const file = await bot.getFile(fileId);
    const ext = path.extname(file.file_path || '') || '.bin';
    const localPath = path.join(mediaDir, `${Date.now()}${ext}`);
    const fileStream = await bot.getFileStream(fileId);
    const writeStream = fs.createWriteStream(localPath);
    return new Promise((resolve, reject) => {
      fileStream.pipe(writeStream);
      writeStream.on('finish', () => { console.log(`📎 Media: ${localPath}`); resolve(localPath); });
      writeStream.on('error', reject);
    });
  } catch (err) {
    console.error('Media download error:', err.message);
    return null;
  }
}

// ── Incoming Messages ─────────────────────────────────────────────────────────
const messageBuffer = new Map();  // chatId → { messages[], timer, mediaPath }
const DEBOUNCE_MS = 2500;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const username = msg.from?.username || String(userId);

  console.log(`📩 ${username}: ${(msg.text || '[media]').slice(0, 80)}`);

  // Allowlist check
  if (!isUserAllowed(userId)) {
    console.log(`🚫 Blocked message from ${userId} (not in supreme allowlist)`);
    return;
  }

  // ── Post-Update Announcement (fires once after ./tamerclaw update) ──────
  if (announcer.hasPendingAnnouncement()) {
    try {
      const announcement = announcer.getAnnouncement();
      if (announcement) {
        await bot.sendMessage(chatId, announcement, { parse_mode: 'Markdown' });
        announcer.markAnnounced();
        console.log(`[supreme] Update announcement sent to ${username}`);
      }
    } catch (err) {
      console.error('[supreme] Failed to send update announcement:', err.message);
      // Try without markdown in case of formatting issues
      try {
        const announcement = announcer.getAnnouncement();
        await bot.sendMessage(chatId, announcement);
        announcer.markAnnounced();
      } catch {}
    }
  }

  // Handle /stop
  if (msg.text === '/stop') {
    if (activeProcess) {
      stopRequested = true;
      activeProcess.kill('SIGTERM');
      setTimeout(() => { try { if (activeProcess) activeProcess.kill('SIGKILL'); } catch {} }, 3000);
      bot.sendMessage(chatId, '🛑 Stopping Supreme Agent...');
    } else {
      bot.sendMessage(chatId, 'No active task running.');
    }
    return;
  }

  // Handle /status
  if (msg.text === '/status') {
    const uptime = Math.floor(process.uptime());
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    let agentCount = 0;
    try { agentCount = fs.readdirSync(AGENTS_DIR).filter(f => fs.statSync(path.join(AGENTS_DIR, f)).isDirectory()).length; } catch {}
    bot.sendMessage(chatId, `👑 *Supreme Agent*\nUptime: ${uptime}s\nMemory: ${memMB}MB\nCalls: ${callCount}\nErrors: ${errorCount}\nManaged agents: ${agentCount}`, { parse_mode: 'Markdown' });
    return;
  }

  // Handle /agents
  if (msg.text === '/agents') {
    try {
      const agents = fs.readdirSync(AGENTS_DIR).filter(f => fs.statSync(path.join(AGENTS_DIR, f)).isDirectory());
      bot.sendMessage(chatId, `👑 *Managed Agents (${agents.length}):*\n${agents.map(a => `• ${a}`).join('\n')}`, { parse_mode: 'Markdown' });
    } catch { bot.sendMessage(chatId, 'Error listing agents.'); }
    return;
  }

  // Handle /switch <account>
  if (msg.text?.startsWith('/switch')) {
    const target = msg.text.split(/\s+/)[1]; // meetings or design
    if (!target || !['meetings', 'design', 'tony', 'hadeel', 'resume'].includes(target)) {
      bot.sendMessage(chatId, '⚡ *Account Switch*\n\nUsage:\n`/switch meetings` — Meetings account\n`/switch design` — Design account\n`/switch tony` — Tony account\n`/switch hadeel` — Hadeel account\n`/switch resume` — Cascade restart all agents', { parse_mode: 'Markdown' });
      return;
    }
    if (target === 'resume') {
      bot.sendMessage(chatId, '🔄 Resuming all agents (cascade: C-Level → Teams)...', { parse_mode: 'Markdown' });
      try {
        const result = execSync(`${CWD}/account-switcher.sh resume 2>&1`, { timeout: 120000 }).toString();
        bot.sendMessage(chatId, `✅ *All agents resumed*\n\n\`\`\`\n${result}\n\`\`\``, { parse_mode: 'Markdown' });
      } catch (err) {
        bot.sendMessage(chatId, `❌ Resume failed: ${err.message?.slice(0, 300)}`);
      }
      return;
    }
    bot.sendMessage(chatId, `🔄 Switching to *${target}@msol.dev*...`, { parse_mode: 'Markdown' });
    try {
      const result = execSync(`${CWD}/account-switcher.sh ${target} 2>&1`, { timeout: 60000 }).toString();
      bot.sendMessage(chatId, `✅ *Switched to ${target}@msol.dev*\n\n\`\`\`\n${result}\n\`\`\`\n\n⚠️ Supreme Agent will restart momentarily.`, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Switch failed: ${err.message?.slice(0, 200)}`);
    }
    return;
  }

  // Handle /account — show current active account
  if (msg.text === '/account') {
    try {
      const result = execSync(`${CWD}/account-switcher.sh status 2>&1`).toString();
      bot.sendMessage(chatId, `👑 *Account Status*\n\n\`\`\`\n${result}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message?.slice(0, 200)}`);
    }
    return;
  }

  // Handle /usage — show rate limit and consumption info (reads real CLI session data)
  if (msg.text === '/usage') {
    try {
      let cliData = '';
      try {
        cliData = execSync(`node ${SHARED_DIR}/cli-usage-report.js --format text`, {
          timeout: 15000, encoding: 'utf-8'
        }).trim();
      } catch (e) {
        cliData = '⚠️ CLI usage data unavailable';
      }

      // Append bot-specific session info
      const uptimeSecs = Math.floor((Date.now() - sessionUsage.sessionStart) / 1000);
      const h = Math.floor(uptimeSecs / 3600), m = Math.floor((uptimeSecs % 3600) / 60);
      const uptimeStr = h > 0 ? h + 'h ' + m + 'm' : m + 'm';

      const extra = `\n\n*Supreme Bot Session:*\n` +
        `• Calls: ${callCount}\n` +
        `• Uptime: ${uptimeStr}` +
        (sessionUsage.lastCallTime ? `\n• Last call: ${new Date(sessionUsage.lastCallTime).toLocaleTimeString()}` : '');

      bot.sendMessage(chatId, cliData + extra, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, '❌ Usage check failed: ' + (err.message || '').slice(0, 200));
    }
    return;
  }


  // Handle /changelog — version history
  if (msg.text === '/changelog') {
    try {
      const changelog = announcer.getChangelog(5);
      bot.sendMessage(chatId, changelog, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, '❌ Failed to load changelog: ' + err.message);
    }
    return;
  }

  // Handle /whatsnew — current version features + command cheat sheet
  if (msg.text === '/whatsnew') {
    try {
      const whatsNew = announcer.getWhatsNew();
      bot.sendMessage(chatId, whatsNew, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, '❌ Failed to load what\'s new: ' + err.message);
    }
    return;
  }

  // Handle /start
  if (msg.text?.startsWith('/start')) {
    bot.sendMessage(chatId,
      '👑 *Supreme Agent Online*\n\nI am the master controller of the claude-agents ecosystem.\n\nCommands:\n• /status — System status\n• /agents — List all agents\n• /account — Current Claude account\n• /switch — Switch Claude account\n• /usage — Token usage & rate limits\n• /changelog — Version history\n• /whatsnew — Features & command cheat sheet\n• /stop — Stop current task\n\nOr just tell me what you need.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Skip empty
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
  } else if (msg.video) {
    mediaPath = await downloadMedia(msg.video.file_id);
  }

  if (!text && !mediaPath) return;

  // Debounce: batch rapid messages
  if (!messageBuffer.has(chatId)) {
    messageBuffer.set(chatId, { messages: [], timer: null, mediaPath: null });
  }
  const buffer = messageBuffer.get(chatId);
  if (text) buffer.messages.push(text);
  if (mediaPath) buffer.mediaPath = mediaPath;

  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(async () => {
    const combined = buffer.messages.join('\n');
    const media = buffer.mediaPath;
    messageBuffer.delete(chatId);

    if (!combined && !media) return;

    // Send typing indicator
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    processing = true;
    try {
      fs.writeFileSync(PROCESSING_FILE, JSON.stringify({ chatId, startedAt: new Date().toISOString() }));
      const result = await callClaude(combined, chatId, media);

      // If response was already streamed live, don't re-send it
      if (typeof result === 'object' && result.streamed) {
        console.log(`[supreme] Response delivered via streaming (${result.text.length} chars)`);
      } else if (typeof result === 'object' && result.text) {
        // Not streamed — send as regular message
        sendLongMessage(chatId, result.text);
      } else if (typeof result === 'string') {
        sendLongMessage(chatId, result);
      } else {
        // Safety: unknown result shape — notify user something happened
        bot.sendMessage(chatId, '⚠️ Task completed but response was empty. Check if actions were taken.').catch(() => {});
      }
      callCount++;
    } catch (err) {
      console.error('[supreme] ❌', err.message?.slice(0, 300));
      errorCount++;
      bot.sendMessage(chatId, `⚠️ Error: ${err.message?.slice(0, 200)}`).catch(() => {});
    } finally {
      try { fs.unlinkSync(PROCESSING_FILE); } catch {}
      processing = false;
    }
  }, DEBOUNCE_MS);
});

// ── Typing indicator while processing ─────────────────────────────────────────
setInterval(() => {
  try {
    if (!fs.existsSync(PROCESSING_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PROCESSING_FILE, 'utf-8'));
    if (data.chatId) bot.sendChatAction(data.chatId, 'typing').catch(() => {});
  } catch {}
}, 4000);

// ── Outbox watcher (for progress updates) ─────────────────────────────────────
setInterval(() => {
  try {
    const files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(OUTBOX_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.chatId && data.text) sendLongMessage(data.chatId, data.text);
        fs.unlinkSync(filePath);
      } catch (e) {
        try { fs.renameSync(filePath, filePath + '.error'); } catch {}
      }
    }
  } catch {}
}, 1000);

// ── Health Heartbeat ──────────────────────────────────────────────────────────
function writeHealth() {
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({
      alive: true,
      agent: 'supreme',
      version: '1.0',
      uptime: Math.floor(process.uptime()),
      calls: callCount,
      errors: errorCount,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      ts: new Date().toISOString()
    }, null, 2));
  } catch {}
}

setInterval(writeHealth, 60000);
writeHealth();

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[supreme] ${signal} — shutting down`);
  writeHealth();
  try { fs.unlinkSync(PROCESSING_FILE); } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  // Kill any active Claude process so it doesn't become orphaned
  if (activeProcess) {
    try { activeProcess.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (activeProcess) activeProcess.kill('SIGKILL'); } catch {} }, 2000);
  }
  try {
    await bot.stopPolling({ cancel: true });
  } catch {}
  // Give Telegram API a moment to release the polling session
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

console.log('👑 Supreme Agent ready. Waiting for commands...');
