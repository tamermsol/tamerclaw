/**
 * Telegram Relay Bot v3.3 — Fixed async interval overlap causing double messages
 *
 * Receives messages from Telegram → writes to inbox.jsonl
 * Downloads media (photos, documents, voice, video) → saves to agent media dir
 * Watches outbox/ for responses → sends back to Telegram
 * Watches stream-outbox/ for real-time streaming responses
 * Handles callback queries (inline buttons)
 *
 * v3.2: Fixed sidecar .msgid read — stream edits now work correctly
 *
 * Adapted for TamerClaw: all paths resolved via paths.js, token from config.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import TelegramBot from 'node-telegram-bot-api';
import { execSync } from 'child_process';
import paths from '../shared/paths.js';
import { newTraceId } from '../shared/trace.js';
import { transcribeAudio } from '../shared/transcribe.js';
import { textToSpeech, getVoicePresets } from '../shared/tts.js';
import { enableVoiceMode, disableVoiceMode, getVoiceMode, setVoice, setProvider, setModel, getActiveChats } from '../shared/voice-mode.js';
import { getActiveProvider } from '../shared/tts.js';
import { isAvailable as elevenLabsAvailable, getVoicePresets as getElevenLabsPresets } from '../shared/tts-elevenlabs.js';
import { prepareBroadcast, analyzeResponse } from '../shared/smart-broadcast.js';

// ── Config-based token loading ───────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
  } catch (e) {
    console.error('[config] Failed to load:', e.message);
    return {};
  }
}

const config = loadConfig();
const TOKEN = config.telegram?.sharedBotToken;
if (!TOKEN) {
  console.error('[FATAL] No telegram.sharedBotToken found in config at:', paths.config);
  process.exit(1);
}

// ── Path Resolution ──────────────────────────────────────────────────────────
// Runtime state in user/relay/ for workspace isolation (core/ is code only)
const RELAY_RUNTIME = paths.relayRuntime;            // user/relay
const INBOX = path.join(RELAY_RUNTIME, 'inbox.jsonl');
const OUTBOX_DIR = paths.relayOutbox;                // user/relay/outbox
const STREAM_OUTBOX_DIR = paths.relayStreamOutbox;   // user/relay/stream-outbox
const AGENTS_DIR = paths.agents;
const CURRENT_AGENT_FILE = path.join(RELAY_RUNTIME, 'current-agent.txt');
const CREDENTIALS_DIR = paths.credentials;

for (const dir of [RELAY_RUNTIME, OUTBOX_DIR, STREAM_OUTBOX_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Duplicate Process Guard ─────────────────────────────────────────────────
// Prevent multiple relay bot.js from running (causes 409 Conflict on Telegram)
const LOCK_FILE = path.join(RELAY_RUNTIME, 'bot.lock');
try {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    try {
      execSync(`kill -0 ${oldPid} 2>/dev/null`);
      // Old process is alive — kill it to prevent 409 conflicts
      console.log(`[startup] Killing old relay bot.js (PID ${oldPid}) to prevent 409 conflict`);
      try { execSync(`kill ${oldPid} 2>/dev/null`); } catch {}
      // Wait for old process to release the Telegram polling connection
      try { execSync('sleep 3'); } catch {}
    } catch {
      // Old process is dead, clean up stale lock
      console.log(`[startup] Cleaned stale lock file (old PID ${oldPid} dead)`);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {
  console.error('[WARN] Could not create lock file:', e.message);
}
// Clean up lock on exit
function cleanLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }
process.on('exit', cleanLock);
// ─────────────────────────────────────────────────────────────────────────────

// Clear any stale webhook before starting (use same instance, don't create two)
const bot = new TelegramBot(TOKEN, { polling: false }); // start without polling
await bot.deleteWebHook({ drop_pending_updates: false });
await new Promise(r => setTimeout(r, 2000));
// NOW start polling on the single instance
bot.startPolling({ interval: 1000, params: { timeout: 30 } });

console.log(`Telegram relay bot v3.3 started (PID ${process.pid}). Waiting for messages...`);

// ── Global Rate-Limit Backoff ────────────────────────────────────────────────
// When Telegram returns 429, ALL send/edit operations pause until the cooldown expires.
// This prevents the death spiral where rapid retries keep the rate limit alive forever.
let rateLimitUntil = 0; // timestamp (ms) when we can resume sending

function isRateLimited() {
  return Date.now() < rateLimitUntil;
}

function handleRateLimit(err) {
  const retryAfter = err?.response?.body?.parameters?.retry_after;
  if (retryAfter) {
    const until = Date.now() + (retryAfter * 1000) + 1000; // +1s buffer
    if (until > rateLimitUntil) {
      rateLimitUntil = until;
      const secsLeft = Math.ceil((rateLimitUntil - Date.now()) / 1000);
      console.log(`Rate-limited by Telegram — pausing ALL sends for ${secsLeft}s`);
    }
    return true;
  }
  return false;
}

// Wrap bot.sendMessage to respect rate limits
const _origSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = async function(chatId, text, opts) {
  if (isRateLimited()) {
    const wait = Math.ceil((rateLimitUntil - Date.now()) / 1000);
    console.log(`sendMessage blocked — rate-limited for ${wait}s more`);
    return null;
  }
  try {
    return await _origSendMessage(chatId, text, opts);
  } catch (err) {
    if (handleRateLimit(err)) return null;
    throw err;
  }
};

// Wrap bot.editMessageText to respect rate limits
const _origEditMessage = bot.editMessageText.bind(bot);
bot.editMessageText = async function(text, opts) {
  if (isRateLimited()) return null;
  try {
    return await _origEditMessage(text, opts);
  } catch (err) {
    if (handleRateLimit(err)) return null;
    throw err;
  }
};

// Wrap bot.sendPhoto to respect rate limits
const _origSendPhoto = bot.sendPhoto.bind(bot);
bot.sendPhoto = async function(chatId, photo, opts) {
  if (isRateLimited()) return null;
  try {
    return await _origSendPhoto(chatId, photo, opts);
  } catch (err) {
    if (handleRateLimit(err)) return null;
    throw err;
  }
};

// Wrap bot.sendDocument to respect rate limits
const _origSendDocument = bot.sendDocument.bind(bot);
bot.sendDocument = async function(chatId, doc, opts) {
  if (isRateLimited()) return null;
  try {
    return await _origSendDocument(chatId, doc, opts);
  } catch (err) {
    if (handleRateLimit(err)) return null;
    throw err;
  }
};

// Wrap bot.sendVoice to respect rate limits
const _origSendVoice = bot.sendVoice.bind(bot);
bot.sendVoice = async function(chatId, voice, opts) {
  if (isRateLimited()) return null;
  try {
    return await _origSendVoice(chatId, voice, opts);
  } catch (err) {
    if (handleRateLimit(err)) return null;
    throw err;
  }
};

// ── Dedup Cache ──────────────────────────────────────────────────────────────
// Prevents the same message from being sent to the same chat twice within 30s.
// Key = chatId + hash(text first 200 chars), Value = timestamp.
const recentlySent = new Map();
const DEDUP_WINDOW_MS = 30000; // 30 seconds

function isDuplicate(chatId, text) {
  if (!text || text.length < 10) return false; // Skip short status messages
  // Use first 200 chars as fingerprint (enough to identify unique messages)
  const key = `${chatId}:${text.slice(0, 200)}`;
  const now = Date.now();
  const lastSent = recentlySent.get(key);
  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    console.log(`Dedup: skipping duplicate message to ${chatId} (sent ${Math.floor((now - lastSent) / 1000)}s ago)`);
    return true;
  }
  recentlySent.set(key, now);
  return false;
}

function isDuplicateMedia(chatId, mediaPath) {
  if (!mediaPath) return false;
  const key = `media:${chatId}:${mediaPath}`;
  const now = Date.now();
  const lastSent = recentlySent.get(key);
  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    console.log(`Dedup: skipping duplicate media to ${chatId}: ${path.basename(mediaPath)} (sent ${Math.floor((now - lastSent) / 1000)}s ago)`);
    return true;
  }
  recentlySent.set(key, now);
  return false;
}

// Clean old entries every 60s to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [key, ts] of recentlySent) {
    if (ts < cutoff) recentlySent.delete(key);
  }
}, 60000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentAgent() {
  try { return fs.readFileSync(CURRENT_AGENT_FILE, 'utf-8').trim() || 'scrum'; }
  catch { return 'scrum'; }
}

function isUserAllowed(userId, agentId) {
  try {
    // Try per-agent allowlist first, fall back to default
    let filePath = path.join(CREDENTIALS_DIR, `telegram-${agentId}-allowFrom.json`);
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

// ── Media Download ───────────────────────────────────────────────────────────

async function downloadMedia(fileId, agentId) {
  const mediaDir = paths.agentMedia(agentId);
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

  try {
    const file = await bot.getFile(fileId);
    const ext = path.extname(file.file_path || '') || '.bin';
    const localPath = path.join(mediaDir, `${Date.now()}${ext}`);

    const fileStream = await bot.getFileStream(fileId);
    const writeStream = fs.createWriteStream(localPath);

    return new Promise((resolve, reject) => {
      fileStream.pipe(writeStream);
      writeStream.on('finish', () => {
        console.log(`Media saved: ${localPath}`);
        resolve(localPath);
      });
      writeStream.on('error', (err) => {
        console.error('Media write error:', err.message);
        reject(err);
      });
    });
  } catch (err) {
    console.error('Media download error:', err.message);
    return null;
  }
}

// ── Voice Conversation Commands ───────────────────────────────────────────────

bot.onText(/^\/voice(?:\s+(.*))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args = (match[1] || '').trim().toLowerCase();

  if (!args || args === 'on') {
    const has11labs = await elevenLabsAvailable();
    enableVoiceMode(chatId, {
      voice: has11labs ? 'josh' : 'en-casual',
      provider: has11labs ? 'elevenlabs' : 'edge',
    });
    const engine = has11labs ? 'ElevenLabs' : 'Edge TTS';
    await bot.sendMessage(chatId,
      `🎙 Voice mode ON (${engine})\n\n` +
      'Commands:\n' +
      '/voice off — disable\n' +
      '/voice set <voice> — change voice\n' +
      '/voice voices — list presets\n' +
      '/voice engine <elevenlabs|edge> — switch TTS engine\n' +
      '/voice model <flash|quality|v3> — ElevenLabs model\n' +
      '/voice textoff — voice only\n' +
      '/voice texton — voice + text'
    );
    return;
  }

  if (args === 'off') {
    disableVoiceMode(chatId);
    await bot.sendMessage(chatId, '🔇 Voice mode OFF — back to text responses.');
    return;
  }

  if (args === 'status') {
    const mode = getVoiceMode(chatId);
    if (mode) {
      const activeProvider = mode.provider || await getActiveProvider();
      await bot.sendMessage(chatId,
        `🎙 Voice mode: ON\n` +
        `• Engine: ${activeProvider}\n` +
        `• Voice: ${mode.voice}\n` +
        `• Model: ${mode.model || 'flash'}\n` +
        `• Text alongside: ${mode.textToo ? 'yes' : 'no'}\n` +
        `• Since: ${mode.enabledAt}`
      );
    } else {
      await bot.sendMessage(chatId, '🔇 Voice mode: OFF\nUse /voice on to enable');
    }
    return;
  }

  if (args.startsWith('set ')) {
    const voiceName = args.slice(4).trim();
    setVoice(chatId, voiceName);
    await bot.sendMessage(chatId, `🎙 Voice set to: ${voiceName}`);
    return;
  }

  if (args === 'voices') {
    const mode = getVoiceMode(chatId);
    const provider = mode?.provider || await getActiveProvider();

    let msg_text = '🎙 Available Voices:\n\n';

    if (provider === 'elevenlabs') {
      const presets = getElevenLabsPresets();
      msg_text += '🔷 ElevenLabs:\n';
      msg_text += presets.map(v => `• ${v.key} — ${v.description}`).join('\n');
      msg_text += '\n\n💡 Use /voice engine edge to see Edge TTS voices';
    } else {
      const edgePresets = getVoicePresets();
      const edgeList = Object.entries(edgePresets.edge || {}).map(([k, v]) => `• ${k} → ${v}`).join('\n');
      msg_text += '⚪ Edge TTS:\n' + edgeList;
      msg_text += '\n\n💡 Use /voice engine elevenlabs for premium voices';
    }

    msg_text += '\n\nUse: /voice set <name>';
    await bot.sendMessage(chatId, msg_text);
    return;
  }

  if (args.startsWith('engine ') || args.startsWith('provider ')) {
    const engineName = args.split(' ')[1]?.trim();
    if (engineName === 'elevenlabs' || engineName === '11labs') {
      const has11labs = await elevenLabsAvailable();
      if (!has11labs) {
        await bot.sendMessage(chatId, '⚠️ ElevenLabs API key not configured.\nSet ELEVENLABS_API_KEY or add to user/config.json');
        return;
      }
      setProvider(chatId, 'elevenlabs');
      // Switch to a good default ElevenLabs voice
      const mode = getVoiceMode(chatId);
      if (mode && !getElevenLabsPresets().find(v => v.key === mode.voice)) {
        setVoice(chatId, 'josh');
      }
      await bot.sendMessage(chatId, '🔷 Switched to ElevenLabs — premium voice quality.\nUse /voice voices to see available voices.');
    } else if (engineName === 'edge' || engineName === 'free') {
      setProvider(chatId, 'edge');
      await bot.sendMessage(chatId, '⚪ Switched to Edge TTS (free).\nUse /voice voices to see available voices.');
    } else {
      await bot.sendMessage(chatId, '⚠️ Unknown engine. Use: elevenlabs or edge');
    }
    return;
  }

  if (args.startsWith('model ')) {
    const modelName = args.slice(6).trim();
    const validModels = ['flash', 'quality', 'v3'];
    if (validModels.includes(modelName)) {
      setModel(chatId, modelName);
      const desc = {
        flash: 'Flash v2.5 — fast, low latency',
        quality: 'Multilingual v2 — highest quality',
        v3: 'V3 — newest, emotion tags support',
      };
      await bot.sendMessage(chatId, `🎙 Model: ${desc[modelName]}`);
    } else {
      await bot.sendMessage(chatId, `⚠️ Unknown model. Available: ${validModels.join(', ')}`);
    }
    return;
  }

  if (args === 'textoff') {
    const mode = getVoiceMode(chatId);
    if (mode) {
      const { setTextMode } = await import('../shared/voice-mode.js');
      setTextMode(chatId, false);
      await bot.sendMessage(chatId, '🎙 Text mode OFF — voice only responses.');
    } else {
      await bot.sendMessage(chatId, '⚠️ Voice mode not active. Use /voice on first.');
    }
    return;
  }

  if (args === 'texton') {
    const mode = getVoiceMode(chatId);
    if (mode) {
      const { setTextMode } = await import('../shared/voice-mode.js');
      setTextMode(chatId, true);
      await bot.sendMessage(chatId, '🎙 Text mode ON — you\'ll get voice + text.');
    } else {
      await bot.sendMessage(chatId, '⚠️ Voice mode not active. Use /voice on first.');
    }
    return;
  }

  await bot.sendMessage(chatId,
    '🎙 Voice Commands:\n' +
    '/voice on — enable voice mode\n' +
    '/voice off — disable\n' +
    '/voice status — current state & engine\n' +
    '/voice set <voice> — change voice preset\n' +
    '/voice voices — list available presets\n' +
    '/voice engine <elevenlabs|edge> — switch TTS engine\n' +
    '/voice model <flash|quality|v3> — ElevenLabs model\n' +
    '/voice textoff — voice only\n' +
    '/voice texton — voice + text'
  );
});

// ── Incoming Messages ────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const agentId = getCurrentAgent();
  const userId = msg.from?.id;

  // Allowlist check (per-agent, then default fallback)
  if (!isUserAllowed(userId, agentId)) {
    console.log(`Blocked message from ${userId} for agent ${agentId} (not in allowlist)`);
    return;
  }

  const entry = {
    id: Date.now().toString(),
    traceId: newTraceId(),
    chatId: msg.chat.id,
    from: msg.from?.username || String(msg.from?.id),
    text: msg.text || msg.caption || '',
    ts: new Date().toISOString(),
    agent: agentId
  };

  // Download media and attach path
  let mediaPath = null;

  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    mediaPath = await downloadMedia(largest.file_id, agentId);
    entry.media = 'photo';
    entry.mediaPath = mediaPath;
  } else if (msg.document) {
    mediaPath = await downloadMedia(msg.document.file_id, agentId);
    entry.media = 'document';
    entry.mediaPath = mediaPath;
    entry.fileName = msg.document.file_name;
  } else if (msg.voice) {
    mediaPath = await downloadMedia(msg.voice.file_id, agentId);
    entry.media = 'voice';
    entry.mediaPath = mediaPath;
    try {
      const transcription = await transcribeAudio(mediaPath);
      entry.text = `[Voice message transcription]: ${transcription}\n${entry.text || ''}`.trim();
    } catch (err) {
      console.error('[voice] Transcription failed:', err.message);
      entry.text = `[Voice message — transcription failed]\n${entry.text || ''}`.trim();
    }
  } else if (msg.video) {
    mediaPath = await downloadMedia(msg.video.file_id, agentId);
    entry.media = 'video';
    entry.mediaPath = mediaPath;
  } else if (msg.sticker) {
    entry.media = 'sticker';
    entry.text = entry.text || `[Sticker: ${msg.sticker.emoji || 'unknown'}]`;
  }

  // Skip messages with no content at all
  if (!entry.text && !mediaPath) return;

  // If media but no text, add descriptive text
  if (mediaPath && !entry.text) {
    entry.text = `[Sent a ${entry.media} file]`;
  }

  await fsp.appendFile(INBOX, JSON.stringify(entry) + '\n');
  bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
  console.log(`[${entry.traceId}] ${entry.from}: ${entry.text.slice(0, 80)}${entry.media ? ` [${entry.media}]` : ''}`);
});

// ── Callback Queries (Inline Buttons) ────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const agentId = getCurrentAgent();
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  const entry = {
    id: Date.now().toString(),
    traceId: newTraceId(),
    chatId,
    from: query.from?.username || String(query.from?.id),
    text: `[Button pressed: ${query.data}]`,
    ts: new Date().toISOString(),
    agent: agentId
  };

  fsp.appendFile(INBOX, JSON.stringify(entry) + '\n').catch(e => console.error('Inbox write error:', e.message));
  console.log(`[${entry.traceId}] ${entry.from}: ${entry.text}`);
});

// ── Typing Indicator ─────────────────────────────────────────────────────────

const PROCESSING_FILE = path.join(RELAY_RUNTIME, 'processing.json');
setInterval(async () => {
  try {
    const content = await fsp.readFile(PROCESSING_FILE, 'utf-8');
    const data = JSON.parse(content);
    if (data.chatId) {
      const voiceConfig = getVoiceMode(data.chatId);
      const action = voiceConfig ? 'record_voice' : 'typing';
      bot.sendChatAction(data.chatId, action).catch(() => {});
    }
  } catch {}
}, 4000);

// ── Outbox Watcher ───────────────────────────────────────────────────────────

let outboxProcessing = false;
setInterval(async () => {
  if (outboxProcessing) return; // Guard: previous async interval still running
  if (isRateLimited()) return;
  outboxProcessing = true;
  try {
    const files = (await fsp.readdir(OUTBOX_DIR)).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(OUTBOX_DIR, file);
      try {
        const data = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
        const traceTag = data.traceId ? `[${data.traceId}] ` : '';
        let sent = false;
        if (data.chatId && data.text) {
          // Dedup: skip if same text was sent to same chat recently
          if (isDuplicate(data.chatId, data.text)) {
            sent = true; // Mark as sent so the file gets deleted
          } else {
            // Check if voice mode is active for this chat
            const voiceConfig = getVoiceMode(data.chatId);
            if (voiceConfig && !data.skipVoice) {
              // Smart voice broadcast — analyzes content and delivers optimally
              try {
                const deliverables = await prepareBroadcast(data.text, voiceConfig);
                let voiceSent = false;

                for (const item of deliverables) {
                  if (item.type === 'voice' && item.audioPath) {
                    bot.sendChatAction(data.chatId, 'record_voice').catch(() => {});
                    const voiceResult = await bot.sendVoice(data.chatId, item.audioPath);
                    if (voiceResult) voiceSent = true;
                    // Clean up temp file
                    try { fs.unlinkSync(item.audioPath); } catch {}
                  } else if (item.type === 'text') {
                    await sendLongMessage(data.chatId, item.content);
                  }
                }

                if (voiceSent || deliverables.some(d => d.type === 'text')) {
                  console.log(`${traceTag}-> ${data.chatId} [SMART-VOICE]: ${deliverables.filter(d => d.type === 'voice').length} voice + ${deliverables.filter(d => d.type === 'text').length} text segments`);
                  sent = true;
                }
              } catch (broadcastErr) {
                console.error(`${traceTag}[smart-broadcast] Failed, falling back to text:`, broadcastErr.message);
                // Fallback to plain text
                const result = await sendLongMessage(data.chatId, data.text);
                if (result !== null) sent = true;
              }
            } else {
              // Standard text mode
              const result = await sendLongMessage(data.chatId, data.text);
              if (result !== null) {
                console.log(`${traceTag}-> ${data.chatId}: ${data.text.slice(0, 80)}...`);
                sent = true;
              }
            }
          }
        }
        // Send media file if present
        if (data.chatId && data.mediaPath) {
          // Dedup: skip if same media was sent to same chat recently
          if (isDuplicateMedia(data.chatId, data.mediaPath)) {
            sent = true; // Mark as sent so the file gets deleted
          } else {
          try {
            await fsp.access(data.mediaPath);
            const ext = path.extname(data.mediaPath).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
              const r = await bot.sendPhoto(data.chatId, data.mediaPath).catch(e => {
                console.error('Photo send error:', e.message);
                return null;
              });
              if (r) sent = true;
            } else {
              const r = await bot.sendDocument(data.chatId, data.mediaPath).catch(e => {
                console.error('Document send error:', e.message);
                return null;
              });
              if (r) sent = true;
            }
          } catch {}
          } // end dedup else
        }
        // Only delete file if message was actually sent (not rate-limited)
        if (sent) {
          await fsp.unlink(filePath);
        } else if (isRateLimited()) {
          // Leave file for retry after rate limit expires
          break; // Stop processing more files this cycle
        } else {
          // Non-rate-limit failure — remove to prevent infinite loop
          await fsp.unlink(filePath);
        }
      } catch (e) {
        console.error('Outbox error:', e.message);
        try { await fsp.rename(filePath, filePath + '.error'); } catch {}
      }
    }
  } catch {} finally { outboxProcessing = false; }
}, 1000);

// ── Long Message Splitting ───────────────────────────────────────────────────

/**
 * Send a message that may exceed Telegram's 4096 char limit.
 * Splits at paragraph/line boundaries while respecting Markdown formatting.
 *
 * FIX: Markdown-aware splitting — avoids splitting inside bold/italic/code blocks
 * which would cause parse errors on one or both chunks.
 */
async function sendLongMessage(chatId, text) {
  if (isRateLimited()) return null;
  const MAX = 4096;
  if (text.length <= MAX) {
    return await sendWithMarkdownFallback(chatId, text);
  }

  const chunks = splitMessageSafe(text, MAX);

  let firstResult = null;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    const r = await sendWithMarkdownFallback(chatId, chunks[i]);
    if (i === 0) firstResult = r;
  }
  return firstResult;
}

/**
 * Send a single message with Markdown, falling back to plain text on parse error.
 */
async function sendWithMarkdownFallback(chatId, text) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch {
    try {
      return await bot.sendMessage(chatId, text);
    } catch (e) {
      console.error('Send error:', e.message);
      return null;
    }
  }
}

/**
 * Split text into chunks <= maxLen, preferring paragraph/line boundaries.
 * Markdown-aware: won't split inside code blocks (``` ... ```)
 */
function splitMessageSafe(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // 1. Try splitting at paragraph boundary (\n\n)
    splitAt = remaining.lastIndexOf('\n\n', maxLen);

    // 2. Check we're not inside a code block
    if (splitAt > 0) {
      const before = remaining.slice(0, splitAt);
      const codeBlockCount = (before.match(/```/g) || []).length;
      if (codeBlockCount % 2 !== 0) {
        // Inside a code block — find the closing ``` before maxLen
        const closeIdx = remaining.indexOf('```', remaining.lastIndexOf('```', splitAt) + 3);
        if (closeIdx > 0 && closeIdx + 3 <= maxLen) {
          // Split after the code block closes
          splitAt = remaining.indexOf('\n', closeIdx + 3);
          if (splitAt < 0 || splitAt > maxLen) splitAt = closeIdx + 3;
        } else {
          // Code block extends beyond maxLen — split before the opening ```
          const openIdx = remaining.lastIndexOf('```', splitAt);
          if (openIdx > maxLen * 0.2) {
            splitAt = openIdx;
          }
        }
      }
    }

    // 3. Fallback to line boundary
    if (splitAt < maxLen * 0.3) {
      splitAt = remaining.lastIndexOf('\n', maxLen);
    }

    // 4. Hard split as last resort
    if (splitAt < maxLen * 0.3) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── Stream Outbox Watcher ────────────────────────────────────────────────────

const TELEGRAM_MAX_LEN = 4096;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function telegramEditWithRetry(chatId, messageId, text, maxRetries = 3) {
  if (isRateLimited()) return { ok: false, rateLimited: true };
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
      return { ok: true };
    } catch (err) {
      // If Markdown fails, retry without parse_mode
      if (err.message?.includes('parse') || err.message?.includes('Can\'t parse')) {
        try {
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId
          });
          return { ok: true };
        } catch (plainErr) {
          err = plainErr;
        }
      }
      // Handle rate limiting (429) — global backoff handles this now
      if (err.response && err.response.statusCode === 429) {
        handleRateLimit(err);
        return { ok: false, rateLimited: true };
      }
      // "message is not modified" is harmless — text hasn't changed
      if (err.message?.includes('message is not modified')) return { ok: true };
      // Other errors: log and give up
      console.error('Stream editMessageText error:', err.message);
      return { ok: false };
    }
  }
  return { ok: false };
}

let streamProcessing = false;
setInterval(async () => {
  if (streamProcessing) return; // Guard: previous async interval still running
  if (isRateLimited()) return;
  streamProcessing = true;
  try {
  let files;
  try {
    files = (await fsp.readdir(STREAM_OUTBOX_DIR)).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  } catch { return; }

  for (const file of files) {
    const filePath = path.join(STREAM_OUTBOX_DIR, file);
    let data;
    try {
      data = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    } catch {
      continue; // file may be mid-write
    }

    if (!data.chatId || !data.text) continue;

    // READ messageId from sidecar .msgid file (written by us on first send).
    // The JSON file does NOT contain messageId (sidecar protocol prevents race condition).
    if (!data.messageId) {
      const msgIdFile = filePath.replace('.json', '.msgid');
      try {
        const mid = fs.readFileSync(msgIdFile, 'utf-8').trim();
        if (mid) data.messageId = parseInt(mid, 10);
      } catch {} // sidecar doesn't exist yet — first send
    }

    try {
      // Check if text exceeds Telegram limit — handle overflow
      if (data.text.length > TELEGRAM_MAX_LEN) {
        // Find a good split point
        let splitAt = data.text.lastIndexOf('\n\n', TELEGRAM_MAX_LEN);
        if (splitAt < TELEGRAM_MAX_LEN * 0.3) splitAt = data.text.lastIndexOf('\n', TELEGRAM_MAX_LEN);
        if (splitAt < TELEGRAM_MAX_LEN * 0.3) splitAt = TELEGRAM_MAX_LEN;

        const firstPart = data.text.slice(0, splitAt);
        const overflow = data.text.slice(splitAt).trimStart();

        // Finalize the current message with the first part
        if (data.messageId) {
          await telegramEditWithRetry(data.chatId, data.messageId, firstPart);
        } else {
          await sendWithMarkdownFallback(data.chatId, firstPart);
        }

        // Start a new message for the overflow
        data.text = overflow;
        data.messageId = null;

        // If not done, write updated state back for next poll cycle
        if (!data.done) {
          await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
          continue;
        }
        // If done and there's remaining overflow text, send it as final
        if (overflow) {
          await sendWithMarkdownFallback(data.chatId, overflow);
          console.log(`Stream final overflow -> ${data.chatId}`);
        }
        try { await fsp.unlink(filePath); } catch {}
        try { await fsp.unlink(filePath.replace('.json', '.msgid')); } catch {}
        continue;
      }

      // First send — no messageId yet
      if (!data.messageId) {
        const sent = await sendWithMarkdownFallback(data.chatId, data.text);
        if (sent && sent.message_id) {
          if (data.done) {
            console.log(`Stream complete (single send) -> ${data.chatId}`);
            // Send voice if voice mode active
            const singleVoiceConfig = getVoiceMode(data.chatId);
            if (singleVoiceConfig && data.text) {
              try {
                bot.sendChatAction(data.chatId, 'record_voice').catch(() => {});
                const singleOgg = await textToSpeech(data.text, { voice: singleVoiceConfig.voice });
                await bot.sendVoice(data.chatId, singleOgg);
                try { (await import('fs')).unlinkSync(singleOgg); } catch {}
              } catch (e) { console.error('[tts] Single-send voice failed:', e.message); }
            }
            try { await fsp.unlink(filePath); } catch {}
            // Clean sidecar too
            try { await fsp.unlink(filePath.replace('.json', '.msgid')); } catch {}
          } else {
            // Write messageId to a SIDECAR file instead of modifying the stream JSON.
            const msgIdFile = filePath.replace('.json', '.msgid');
            try {
              await fsp.writeFile(msgIdFile, String(sent.message_id));
            } catch (e) {
              console.error('Failed to write msgid sidecar:', e.message);
            }
          }
        }
        continue;
      }

      // Subsequent update — edit existing message
      await telegramEditWithRetry(data.chatId, data.messageId, data.text);

      if (data.done) {
        console.log(`Stream complete (final edit) -> ${data.chatId}`);
        // Send voice version if voice mode is active
        const streamVoiceConfig = getVoiceMode(data.chatId);
        if (streamVoiceConfig && data.text) {
          try {
            bot.sendChatAction(data.chatId, 'record_voice').catch(() => {});
            const streamOgg = await textToSpeech(data.text, { voice: streamVoiceConfig.voice });
            await bot.sendVoice(data.chatId, streamOgg);
            try { (await import('fs')).unlinkSync(streamOgg); } catch {}
            console.log(`Stream voice sent -> ${data.chatId}`);
          } catch (ttsErr) {
            console.error('[tts] Stream voice failed:', ttsErr.message);
          }
        }
        try { await fsp.unlink(filePath); } catch {}
        try { await fsp.unlink(filePath.replace('.json', '.msgid')); } catch {}
      }
    } catch (e) {
      // If it's a rate limit, trigger global backoff and stop processing this cycle
      if (e?.response?.statusCode === 429) {
        handleRateLimit(e);
        break; // Stop processing more files this cycle
      }
      console.error('Stream outbox error:', e.message);
      if (data.done) {
        // Stream delivery failed — fall back to sending as regular outbox message
        console.log(`Stream delivery failed, falling back to outbox for chatId ${data.chatId}`);
        try {
          const fallbackPath = path.join(OUTBOX_DIR, `${Date.now()}-fallback.json`);
          await fsp.writeFile(fallbackPath, JSON.stringify({ chatId: data.chatId, text: data.text }));
          await fsp.unlink(filePath); // Clean up the stream file
          try { await fsp.unlink(filePath.replace('.json', '.msgid')); } catch {}
        } catch (fallbackErr) {
          console.error('Fallback outbox write also failed:', fallbackErr.message);
          try { await fsp.rename(filePath, filePath + '.error'); } catch {}
        }
      }
    }
  }
  } finally { streamProcessing = false; }
}, 500); // 500ms for responsive streaming (was 1000ms)

// ── Polling Error Handler (with 409 self-healing) ───────────────────────────

let conflict409Count = 0;
const MAX_409_BEFORE_EXIT = 5; // Exit after 5 consecutive 409s so watchdog can restart cleanly

bot.on('polling_error', (err) => {
  const msg = err.message || '';
  if (msg.includes('409 Conflict')) {
    conflict409Count++;
    console.error(`Polling 409 Conflict (#${conflict409Count}/${MAX_409_BEFORE_EXIT})`);
    if (conflict409Count >= MAX_409_BEFORE_EXIT) {
      console.error(`[FATAL] ${MAX_409_BEFORE_EXIT} consecutive 409 conflicts — another instance is polling. Exiting to let watchdog restart after cooldown.`);
      bot.stopPolling().catch(() => {});
      cleanLock();
      process.exit(1);
    }
  } else {
    conflict409Count = 0; // Reset on non-409 errors
    if (msg.includes('ETELEGRAM') || msg.includes('EFATAL')) {
      console.error('Polling error (will retry):', msg.slice(0, 100));
    }
  }
});

// ── Graceful Shutdown (properly async) ──────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`Bot shutting down (${signal})...`);
  try {
    await bot.stopPolling();
    console.log('Polling stopped cleanly.');
  } catch (e) {
    console.error('stopPolling error:', e.message);
  }
  cleanLock();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Bot uncaught exception:', err.message);
  // Don't crash on transient errors, but exit on polling-related fatals
  if (err.message?.includes('EFATAL') && err.message?.includes('polling')) {
    console.error('Fatal polling error — exiting for watchdog restart');
    cleanLock();
    process.exit(1);
  }
});
