/**
 * Discord Bot Template v1.0 — Reusable Discord Bot for All Agents
 *
 * Mirrors the Telegram bot-template.js capabilities for Discord:
 * - Slash commands (chat, new, status, sessions, resume, model, lang, dream, stop, help)
 * - Regular message handling in DMs and designated channels
 * - Claude CLI streaming with live message edits
 * - Session persistence with --resume
 * - Multi-language support (English + Arabic)
 * - Audio/image attachment handling
 * - Embeds for rich formatting
 * - Model routing (haiku/sonnet/opus)
 * - Circuit breaker for rate limits
 * - Per-user language preferences
 *
 * Usage:
 *   import { createDiscordBot } from '../../shared/discord-bot-template.js';
 *   createDiscordBot({
 *     agentId: 'myagent',
 *     token: process.env.DISCORD_BOT_TOKEN,
 *     cwd: '/path/to/workspace',
 *   });
 *
 * Flow: Discord message/slash → Claude CLI (stream-json, --resume) → live edit → Discord
 */

import fs from 'fs';
import path, { join } from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  Partials,
  ChannelType,
  Events,
} from 'discord.js';
import { t, getUserLang, setUserLang, getLangMeta } from './i18n/index.js';
import { archiveSession, formatSessionsList, getSessionByIndex } from './session-history.js';
import { transcribeAudio } from './transcribe.js';
import { TAMERCLAW_HOME } from './paths.js';

// ── Claude Binary Resolution ──────────────────────────────────────────────

const CLAUDE_BIN = (() => {
  const candidates = [
    join(process.env.HOME || '/root', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return candidates[0]; // fallback
})();

// ── Media Processing Helpers ────────────────────────────────────────────────

/**
 * Download a Discord attachment URL to a temp file.
 * @param {string} url - Discord CDN URL
 * @param {string} ext - File extension (e.g. '.jpg', '.ogg', '.mp4')
 * @returns {string|null} Local file path or null on failure
 */
function downloadAttachment(url, ext) {
  try {
    const tmpPath = path.join(tmpdir(), `discord_media_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    execSync(`curl -sL "${url}" -o "${tmpPath}"`, { timeout: 60000 });
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) return tmpPath;
    return null;
  } catch (e) {
    console.error('[discord-media] Download failed:', e.message);
    return null;
  }
}

/**
 * Process a video file: extract audio for transcription + key frames for visual context.
 * Returns { transcription, frames[] } where frames are local image paths.
 */
async function processVideo(videoPath) {
  const result = { transcription: null, frames: [] };
  if (!videoPath || !fs.existsSync(videoPath)) return result;

  const baseId = `vid_${Date.now()}`;
  const tmpBase = path.join(tmpdir(), baseId);

  // 1. Extract audio → transcribe
  try {
    const audioPath = `${tmpBase}_audio.wav`;
    execSync(
      `ffmpeg -y -i "${videoPath}" -vn -ar 16000 -ac 1 -f wav "${audioPath}" 2>/dev/null`,
      { timeout: 60000 }
    );
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
      try {
        result.transcription = await transcribeAudio(audioPath);
      } catch (e) {
        console.error('[discord-video] Audio transcription failed:', e.message);
      }
      try { fs.unlinkSync(audioPath); } catch {}
    }
  } catch (e) {
    console.log('[discord-video] Audio extraction failed (may be silent video):', e.message);
  }

  // 2. Extract key frames — 1 frame every 5 seconds, max 6 frames
  try {
    const framePattern = `${tmpBase}_frame_%03d.jpg`;
    execSync(
      `ffmpeg -y -i "${videoPath}" -vf "fps=1/5,scale='min(800,iw)':-1" -frames:v 6 -q:v 3 "${framePattern}" 2>/dev/null`,
      { timeout: 60000 }
    );
    for (let i = 1; i <= 6; i++) {
      const framePath = `${tmpBase}_frame_${String(i).padStart(3, '0')}.jpg`;
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 500) {
        result.frames.push(framePath);
      }
    }
    if (result.frames.length === 0) {
      const singleFrame = `${tmpBase}_thumb.jpg`;
      execSync(
        `ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 -q:v 3 "${singleFrame}" 2>/dev/null`,
        { timeout: 15000 }
      );
      if (fs.existsSync(singleFrame) && fs.statSync(singleFrame).size > 500) {
        result.frames.push(singleFrame);
      }
    }
  } catch (e) {
    console.log('[discord-video] Frame extraction failed:', e.message);
  }

  console.log(`[discord-video] Processed: ${result.frames.length} frames, transcription: ${result.transcription ? 'yes' : 'no'}`);
  return result;
}

/**
 * Clean up temp media files after processing.
 */
function cleanupTempFiles(paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const DISCORD_MAX_LEN = 2000;      // Discord message character limit
const EMBED_MAX_LEN = 4096;         // Embed description limit
const STREAM_EDIT_INTERVAL_MS = 800;  // How often to edit message during streaming (fast for responsive feel)
const SUBPROCESS_TIMEOUT_MS = 600000; // 10 min timeout
const STUCK_WATCHDOG_MS = 2700000;    // 45 min idle
const MAX_CONTINUATIONS = 10;
const CONTINUATION_TIMEOUT_MS = 900000; // 15 min per continuation

// ── Model Router ───────────────────────────────────────────────────────────

function defaultModelRouter(messageText, defaultModel) {
  if (!messageText) return defaultModel || 'sonnet';
  const text = messageText.toLowerCase();
  const len = messageText.length;

  const simplePatterns = ['status', 'help', 'hi', 'hello', 'hey', 'thanks', 'ok', 'ping'];
  if (len < 30 && simplePatterns.some(p => text.includes(p))) return 'haiku';

  const complexitySignals = [
    'all files', 'entire', 'everything', 'full system', 'end to end',
    'from scratch', 'complete', 'comprehensive', 'complex', 'complicated',
    'integrate', 'integration', 'migration', 'overhaul', 'rewrite',
    'plan', 'architect', 'design', 'research', 'evaluate', 'strategy',
    'system design', 'architecture', 'roadmap', 'review', 'audit',
  ];
  if (complexitySignals.some(p => text.includes(p))) return 'opus';
  if (len > 500) return 'opus';

  const executionPatterns = [
    'implement', 'build', 'code', 'write', 'create', 'fix', 'debug',
    'deploy', 'configure', 'setup', 'add', 'modify', 'update', 'refactor',
  ];
  if (executionPatterns.some(p => text.includes(p))) return 'sonnet';

  return defaultModel || 'sonnet';
}

// ── Tool Activity ──────────────────────────────────────────────────────────

function formatToolActivity(toolName, input, lang) {
  const map = {
    'Read':      t(lang, 'streaming.reading', { file: input?.file_path?.split('/').pop() || 'file' }),
    'Write':     t(lang, 'streaming.writing', { file: input?.file_path?.split('/').pop() || 'file' }),
    'Edit':      t(lang, 'streaming.editing', { file: input?.file_path?.split('/').pop() || 'file' }),
    'Bash':      t(lang, 'streaming.running'),
    'Glob':      t(lang, 'streaming.searching'),
    'Grep':      t(lang, 'streaming.searching'),
    'Agent':     t(lang, 'streaming.subAgent'),
    'WebSearch': t(lang, 'streaming.searching'),
    'WebFetch':  t(lang, 'streaming.fetching'),
  };
  return map[toolName] || toolName;
}

// ── Extract Result ─────────────────────────────────────────────────────────

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
  return texts.length ? texts.join('\n\n') : null;
}

// ── Build System Prompt ────────────────────────────────────────────────────

function buildSystemPrompt(agentDir, systemPromptFiles, lang) {
  const parts = [];

  for (const file of systemPromptFiles) {
    const filePath = path.join(agentDir, file);
    try {
      if (fs.existsSync(filePath)) {
        parts.push(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch {}
  }

  // Add language context
  const langMeta = getLangMeta(lang);
  parts.push(`\n\n# Language Context\n- User language: ${langMeta.nativeName} (${langMeta.code})\n- Text direction: ${langMeta.direction}\n- IMPORTANT: Respond in ${langMeta.nativeName} unless the user explicitly switches language or writes in a different language.\n- Current date: ${new Date().toISOString().split('T')[0]}`);

  return parts.join('\n\n---\n\n');
}

// ── Discord Message Splitting ──────────────────────────────────────────────

function splitMessage(text, maxLen = DISCORD_MAX_LEN) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) {
      // Try space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── Create Discord Bot ─────────────────────────────────────────────────────

/**
 * @param {object} config
 * @param {string} config.agentId
 * @param {string} config.token - Discord bot token
 * @param {string} config.clientId - Discord application client ID
 * @param {string} [config.guildId] - Optional guild ID for guild-specific commands (faster registration)
 * @param {string} [config.agentDir] - Override agent directory path
 * @param {string} [config.cwd] - Working directory for Claude CLI
 * @param {string} [config.defaultModel='sonnet']
 * @param {function} [config.modelRouter]
 * @param {number} [config.maxTurns=200]
 * @param {number} [config.timeoutMs=7200000]
 * @param {string[]} [config.allowedUsers=[]] - Discord user IDs to allow (empty = all)
 * @param {string[]} [config.allowedChannels=[]] - Channel IDs where bot responds to regular messages
 * @param {string[]} [config.systemPromptFiles]
 * @param {function} [config.buildSystemPrompt]
 * @param {object} [config.customCommands={}] - Map of '/commandName' → handler function
 * @param {Array} [config.additionalCommands=[]] - Additional SlashCommandBuilder objects to register
 * @param {string} [config.statusEmoji='\ud83e\udd16']
 * @param {string[]} [config.allowedTools]
 * @param {number} [config.debounceMs=2000]
 * @param {boolean} [config.respondInDMs=true]
 * @param {boolean} [config.respondInThreads=true]
 * @param {string} [config.embedColor='#5865F2'] - Discord blurple default
 * @param {string} [config.embedColorError='#ED4245']
 * @param {string} [config.embedColorSuccess='#57F287']
 * @param {string} [config.embedColorWarning='#FEE75C']
 * @returns {object} { client, shutdown, getState }
 */
export function createDiscordBot(config) {
  // ── Merge config ─────────────────────────────────────────────────────────
  const agentDir = config.agentDir || path.join(TAMERCLAW_HOME, 'user', 'agents', config.agentId);
  let fileConfig = {};
  try {
    const configPath = path.join(agentDir, 'config.json');
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  const cfg = {
    defaultModel: 'sonnet',
    maxTurns: 200,
    timeoutMs: 7200000,
    allowedUsers: [],
    allowedChannels: [],
    systemPromptFiles: ['IDENTITY.md', 'MEMORY.md', 'USER.md'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch'],
    statusEmoji: '\ud83e\udd16',
    debounceMs: 2000,
    respondInDMs: true,
    respondInThreads: true,
    respondInAllGuildChannels: false,
    embedColor: '#5865F2',
    embedColorError: '#ED4245',
    embedColorSuccess: '#57F287',
    embedColorWarning: '#FEE75C',
    autoContinue: true,
    maxContinuations: MAX_CONTINUATIONS,
    ...fileConfig,
    ...config,
  };

  const AGENT_ID = cfg.agentId;
  const CWD = cfg.cwd || path.join(agentDir, 'workspace');
  const SESSIONS_FILE = path.join(agentDir, 'discord-sessions.json');
  const HEALTH_FILE = path.join(agentDir, 'discord-health.json');

  // ── State ────────────────────────────────────────────────────────────────

  const sessions = {};     // channelId/userId → { sessionId, model, messageCount, lastActive }
  const activeProcesses = {}; // channelId → { proc, streamMsg, events, ... }
  let callCount = 0;
  const startedAt = Date.now();

  // Load sessions
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      Object.assign(sessions, JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')));
    }
  } catch {}

  function saveSessions() {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    } catch {}
  }

  function getSessionKey(interaction) {
    // DMs: use userId, Channels/Threads: use channelId
    if (interaction.channel?.type === ChannelType.DM) {
      return `dm-${interaction.user?.id || interaction.author?.id}`;
    }
    return `ch-${interaction.channelId}`;
  }

  function getOrCreateSession(sessionKey, userId) {
    if (!sessions[sessionKey]) {
      sessions[sessionKey] = {
        sessionId: randomUUID(),
        model: cfg.defaultModel,
        messageCount: 0,
        lastActive: Date.now(),
        userId,
        createdAt: Date.now(),
      };
      saveSessions();
    }
    sessions[sessionKey].lastActive = Date.now();
    return sessions[sessionKey];
  }

  // ── Discord Client ───────────────────────────────────────────────────────

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // ── Embed Helpers ────────────────────────────────────────────────────────

  function createEmbed(lang, options = {}) {
    const embed = new EmbedBuilder()
      .setColor(options.color || cfg.embedColor)
      .setTimestamp();

    if (options.title) embed.setTitle(options.title);
    if (options.description) embed.setDescription(options.description.slice(0, EMBED_MAX_LEN));
    if (options.fields) embed.addFields(options.fields);
    if (options.footer !== false) {
      const session = options.session;
      const footerText = session?.model
        ? t(lang, 'embeds.footerWithModel', { model: session.model })
        : t(lang, 'embeds.footer');
      embed.setFooter({ text: footerText });
    }
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);

    return embed;
  }

  function errorEmbed(lang, message) {
    return createEmbed(lang, {
      title: `\u274c ${t(lang, 'embeds.errorTitle')}`,
      description: message,
      color: cfg.embedColorError,
    });
  }

  function successEmbed(lang, message) {
    return createEmbed(lang, {
      title: `\u2705 ${t(lang, 'common.success')}`,
      description: message,
      color: cfg.embedColorSuccess,
    });
  }

  // ── Permission Check ─────────────────────────────────────────────────────

  function isAllowedUser(userId) {
    if (!cfg.allowedUsers || cfg.allowedUsers.length === 0) return true;
    return cfg.allowedUsers.includes(String(userId));
  }

  function isAllowedChannel(channelId, channelType) {
    // Always allow DMs
    if (channelType === ChannelType.DM) return cfg.respondInDMs;
    // Threads — allow if parent channel is allowed
    if (channelType === ChannelType.PublicThread || channelType === ChannelType.PrivateThread) {
      return cfg.respondInThreads;
    }
    // If no channel allowlist, allow all
    if (!cfg.allowedChannels || cfg.allowedChannels.length === 0) return true;
    return cfg.allowedChannels.includes(String(channelId));
  }

  // ── Claude CLI Execution ─────────────────────────────────────────────────

  async function runClaude(sessionKey, messageText, userId, replyFn, editFn, lang, attachments = []) {
    const session = getOrCreateSession(sessionKey, userId);
    const model = (cfg.modelRouter || defaultModelRouter)(messageText, session.model);
    session.messageCount++;
    saveSessions();

    // Check for active process
    if (activeProcesses[sessionKey]) {
      await replyFn(t(lang, 'common.processing'));
      return;
    }

    const systemPrompt = (cfg.buildSystemPrompt || buildSystemPrompt)(agentDir, cfg.systemPromptFiles, lang);

    // Handle attachments (images, audio, video) — download to disk so Claude can see them
    let fullMessage = messageText || '';
    const tempFiles = [];  // Track temp files for cleanup after Claude finishes

    for (const att of attachments) {
      const ext = path.extname(att.name || '').toLowerCase() || (
        att.contentType?.startsWith('image/') ? '.jpg' :
        att.contentType?.startsWith('audio/') ? '.ogg' :
        att.contentType?.startsWith('video/') ? '.mp4' : '.bin'
      );

      if (att.contentType?.startsWith('image/')) {
        // Download image so Claude CLI can see it with vision
        const imgPath = downloadAttachment(att.url, ext);
        if (imgPath) {
          tempFiles.push(imgPath);
          const safePath = imgPath.replace(/"/g, '\\"').replace(/\$/g, '\\$');
          fullMessage += `\n\n[Media file at: "${safePath}"]\nUser sent an image${att.name ? ` (${att.name})` : ''}.`;
        } else {
          fullMessage += `\n\n[Image attachment: ${att.url} — download failed]`;
        }
      } else if (att.contentType?.startsWith('video/')) {
        // Download video → extract frames + transcribe audio
        const videoPath = downloadAttachment(att.url, ext);
        if (videoPath) {
          tempFiles.push(videoPath);
          const videoResult = await processVideo(videoPath);
          if (videoResult.transcription) {
            fullMessage += `\n\n[Video voice transcription: "${videoResult.transcription}"]`;
          }
          if (videoResult.frames.length > 0) {
            for (let i = 0; i < videoResult.frames.length; i++) {
              tempFiles.push(videoResult.frames[i]);
              const safePath = videoResult.frames[i].replace(/"/g, '\\"').replace(/\$/g, '\\$');
              fullMessage += `\n\n[Media file at: "${safePath}"]\nVideo frame ${i + 1} of ${videoResult.frames.length}${att.name ? ` from ${att.name}` : ''}.`;
            }
          }
          if (!videoResult.transcription && videoResult.frames.length === 0) {
            fullMessage += `\n\n[Video attachment: ${att.name || 'video'} — processing failed]`;
          }
        } else {
          fullMessage += `\n\n[Video attachment: ${att.name || 'video'} — download failed]`;
        }
      } else if (att.contentType?.startsWith('audio/')) {
        // Download audio → transcribe with whisper
        const audioPath = downloadAttachment(att.url, ext);
        if (audioPath) {
          tempFiles.push(audioPath);
          try {
            const transcription = await transcribeAudio(audioPath);
            if (transcription) {
              fullMessage += `\n\n[Voice message transcription: "${transcription}"]`;
            } else {
              fullMessage += `\n\n[Audio attachment — transcription returned empty]`;
            }
          } catch (e) {
            fullMessage += `\n\n[Audio attachment — transcription failed: ${e.message}]`;
          }
        } else {
          fullMessage += `\n\n[Audio attachment — download failed]`;
        }
      } else {
        // Other file types — pass as media file path
        const filePath = downloadAttachment(att.url, ext);
        if (filePath) {
          tempFiles.push(filePath);
          const safePath = filePath.replace(/"/g, '\\"').replace(/\$/g, '\\$');
          fullMessage += `\n\n[Media file at: "${safePath}"]\nUser sent a file: ${att.name || 'unknown'} (${att.contentType || 'unknown type'}).`;
        } else {
          fullMessage += `\n\n[File attachment: ${att.name || 'file'} — download failed]`;
        }
      }
    }

    if (!fullMessage.trim()) {
      await replyFn(t(lang, 'commands.chat.emptyMessage'));
      return;
    }

    // Build Claude CLI args (must use -p for print/piped mode)
    const isResume = session.messageCount > 1;
    const baseArgs = [
      '-p', fullMessage,
      '--verbose',
      '--output-format', 'stream-json',
      '--model', model,
      '--max-turns', String(cfg.maxTurns),
    ];

    // Allowed tools
    if (cfg.allowedTools?.length) {
      baseArgs.push('--allowedTools', cfg.allowedTools.join(','));
    }

    // Session: --session-id for new, --resume for existing
    let args;
    if (isResume) {
      args = [...baseArgs, '--resume', session.sessionId, '--append-system-prompt', systemPrompt];
    } else {
      args = [...baseArgs, '--session-id', session.sessionId, '--system-prompt', systemPrompt];
    }

    // ── Streaming state ──────────────────────────────────────────────────
    let streamMsg = null;           // Current Discord message being streamed into
    let streamContent = '';         // Accumulated text from Claude
    let lastEditTime = 0;
    let lastToolActivity = '';
    let toolCount = 0;
    let inToolPhase = false;        // True when tools are running (between text blocks)
    let streamedAnyText = false;    // True once first text has been shown
    let lastProgressSent = 0;
    let overflowMessages = [];      // Additional messages for long responses
    const events = [];
    const startTime = Date.now();
    const STREAM_MSG_MAX = DISCORD_MAX_LEN - 60; // Leave room for cursor + tool indicator

    try {
      streamMsg = await replyFn(t(lang, 'common.thinking'));
    } catch {}

    // ── Helper: format elapsed time ─────────────────────────────────────
    function elapsedStr() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      return mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${secs}s`;
    }

    // ── Helper: safe edit that handles Discord errors ───────────────────
    async function safeEdit(msg, text) {
      if (!msg) return;
      try {
        const truncated = text.length > DISCORD_MAX_LEN ? text.slice(0, DISCORD_MAX_LEN - 3) + '...' : text;
        await editFn(msg, truncated);
      } catch (e) {
        // Message may have been deleted, ignore
        if (e.code === 10008) streamMsg = null;
      }
    }

    // ── Helper: stream update — edit current message with cursor ────────
    async function doStreamUpdate() {
      if (!streamMsg || !streamContent) return;
      const now = Date.now();
      // Bypass throttle for FIRST text — show it immediately so user sees response start
      if (streamedAnyText && now - lastEditTime < STREAM_EDIT_INTERVAL_MS) return;
      lastEditTime = now;

      // Multi-message overflow: if streamContent exceeds limit, finalize current msg and start new one
      if (streamContent.length > STREAM_MSG_MAX) {
        let splitAt = streamContent.lastIndexOf('\n\n', STREAM_MSG_MAX);
        if (splitAt < STREAM_MSG_MAX * 0.3) splitAt = streamContent.lastIndexOf('\n', STREAM_MSG_MAX);
        if (splitAt < STREAM_MSG_MAX * 0.3) splitAt = STREAM_MSG_MAX;

        const finalizedText = streamContent.slice(0, splitAt);
        const remainingText = streamContent.slice(splitAt).trimStart();

        // Finalize current message (remove cursor)
        await safeEdit(streamMsg, finalizedText);
        overflowMessages.push(streamMsg);

        // Start new message for overflow
        streamContent = remainingText;
        if (remainingText.length > 0) {
          try {
            streamMsg = await replyFn(remainingText + ' \u258c');
          } catch {
            streamMsg = null;
          }
        } else {
          streamMsg = null;
        }
        return;
      }

      // Normal edit — append cursor to show it's still generating
      const displayText = streamContent + ' \u258c';
      await safeEdit(streamMsg, displayText);
      streamedAnyText = true;
    }

    // ── Helper: show tool progress ──────────────────────────────────────
    async function showToolProgress() {
      if (!streamMsg) return;
      const now = Date.now();
      if (now - lastProgressSent < 2500) return; // Throttle to 2.5s
      lastProgressSent = now;
      const timeStr = elapsedStr();

      if (streamedAnyText) {
        // Append tool indicator to existing streamed text
        const toolIndicator = `\n\n\u23f3 ${lastToolActivity} (${timeStr})`;
        const displayText = streamContent + toolIndicator;
        if (displayText.length < DISCORD_MAX_LEN - 10) {
          await safeEdit(streamMsg, displayText);
        }
      } else {
        // No text yet — show thinking state with tool details
        const dots = '.'.repeat(1 + (toolCount % 3));
        const statusMsg = `\ud83d\udcad Thinking${dots}\n${lastToolActivity}${toolCount > 1 ? ` \u00b7 ${toolCount} steps` : ''} (${timeStr})`;
        await safeEdit(streamMsg, statusMsg);
      }
    }

    // ── Fallback progress timer — keeps user informed during silences ───
    const progressTimer = setInterval(async () => {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      if (elapsed < 10) return; // Silent for first 10s
      if (now - lastEditTime < 5000 && now - lastProgressSent < 5000) return; // Recent update exists

      const timeStr = elapsedStr();
      if (streamMsg) {
        if (streamedAnyText) {
          const indicator = `\n\n\u23f3 ${lastToolActivity || 'Working...'} (${timeStr})`;
          const displayText = streamContent + indicator;
          if (displayText.length < DISCORD_MAX_LEN - 10) {
            await safeEdit(streamMsg, displayText);
          }
        } else {
          const dots = '.'.repeat(1 + (Math.floor(elapsed / 3) % 3));
          const statusMsg = `\ud83d\udcad Thinking${dots}\n${lastToolActivity || 'Analyzing your request'} (${timeStr})${toolCount > 0 ? ` \u00b7 ${toolCount} steps` : ''}`;
          await safeEdit(streamMsg, statusMsg);
        }
        lastProgressSent = now;
      }
    }, 5000);

    // Ensure workspace directory exists
    if (!fs.existsSync(CWD)) fs.mkdirSync(CWD, { recursive: true });

    // Spawn Claude — stdin must be 'ignore' (not 'pipe'), clean CLAUDE* env vars
    const env = { ...process.env, HOME: '/root' };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
    }
    const proc = spawn(CLAUDE_BIN, args, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });

    activeProcesses[sessionKey] = { proc, streamMsg, events, startedAt: startTime };
    callCount++;

    let buffer = '';
    let timedOut = false;

    // Timeout
    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, SUBPROCESS_TIMEOUT_MS);

    // ── Process stdout — parse stream-json events ───────────────────────
    proc.stdout.on('data', async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);

          // ── Assistant message content blocks (full text blocks) ────
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                // Add separator if coming back from a tool phase
                if (inToolPhase && streamContent.length > 0) {
                  streamContent += '\n\n';
                }
                inToolPhase = false;
                streamContent += block.text;
                await doStreamUpdate();
              }
              if (block.type === 'tool_use') {
                lastToolActivity = formatToolActivity(block.name, block.input, lang);
                toolCount++;
                inToolPhase = true;
                await showToolProgress();
              }
            }
          }

          // ── Content block delta (incremental text) ────────────────
          if (event.type === 'content_block_delta' && event.delta?.text) {
            if (inToolPhase && streamContent.length > 0) {
              streamContent += '\n\n';
            }
            inToolPhase = false;
            streamContent += event.delta.text;
            await doStreamUpdate();
          }

          // ── Tool use event ────────────────────────────────────────
          if (event.type === 'tool_use') {
            lastToolActivity = formatToolActivity(event.name || event.tool_name, event.input, lang);
            toolCount++;
            inToolPhase = true;
            await showToolProgress();
          }
        } catch {}
      }
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (chunk) => {
      const errText = chunk.toString();
      stderrBuffer += errText;
      if (errText.includes('rate limit') || errText.includes('429')) {
        console.error(`[${AGENT_ID}] Rate limit hit`);
      }
      const trimmed = errText.trim();
      if (trimmed && !trimmed.startsWith('Debugger') && !trimmed.startsWith('Warning:')) {
        console.error(`[${AGENT_ID}] stderr: ${trimmed.slice(0, 500)}`);
      }
    });

    // ── Wait for completion ──────────────────────────────────────────────
    return new Promise((resolve) => {
      proc.on('close', async (code) => {
        clearTimeout(timeout);
        clearInterval(progressTimer);
        delete activeProcesses[sessionKey];
        cleanupTempFiles(tempFiles);

        const result = extractResultFromEvents(events) || streamContent;

        if (code !== 0 && code !== null) {
          console.error(`[${AGENT_ID}] Claude exited with code ${code}. Events: ${events.length}, streamContent length: ${streamContent.length}`);
          if (stderrBuffer.trim()) {
            console.error(`[${AGENT_ID}] stderr output: ${stderrBuffer.trim().slice(0, 1000)}`);
          }
        }

        if (timedOut) {
          try {
            const msg = t(lang, 'errors.processTimeout');
            if (streamMsg) await safeEdit(streamMsg, msg);
            else await replyFn(msg);
          } catch {}
          resolve(null);
          return;
        }

        if (!result) {
          console.error(`[${AGENT_ID}] No result. Exit code: ${code}, events: ${events.length}, stream: ${streamContent.length} chars, stderr: ${stderrBuffer.trim().slice(0, 300)}`);
          try {
            const msg = t(lang, 'errors.noResponse');
            if (streamMsg) await safeEdit(streamMsg, msg);
            else await replyFn(msg);
          } catch {}
          resolve(null);
          return;
        }

        // ── Send final response (remove cursor, clean up) ───────────
        try {
          // If we already streamed most/all of the text, just finalize the current message
          if (streamedAnyText && streamMsg) {
            // Finalize: split remaining result into Discord-safe chunks
            const chunks = splitMessage(result);

            // If the streamed content closely matches the result, just do a final edit
            if (overflowMessages.length === 0) {
              await safeEdit(streamMsg, chunks[0]);
              for (let i = 1; i < chunks.length; i++) {
                await replyFn(chunks[i]);
              }
            } else {
              // We already sent overflow messages — finalize the last one
              await safeEdit(streamMsg, streamContent.length > 0 ? streamContent : chunks[chunks.length - 1]);
            }
          } else {
            // No streaming happened — send result fresh
            const chunks = splitMessage(result);
            if (streamMsg) {
              await safeEdit(streamMsg, chunks[0]);
              for (let i = 1; i < chunks.length; i++) {
                await replyFn(chunks[i]);
              }
            } else {
              for (const chunk of chunks) {
                await replyFn(chunk);
              }
            }
          }
        } catch (e) {
          console.error(`[${AGENT_ID}] Failed to send response:`, e.message);
        }

        resolve(result);
      });

      proc.on('error', async (err) => {
        clearTimeout(timeout);
        clearInterval(progressTimer);
        delete activeProcesses[sessionKey];
        cleanupTempFiles(tempFiles);
        console.error(`[${AGENT_ID}] Claude process error:`, err.message);
        try {
          const msg = t(lang, 'errors.claudeError');
          if (streamMsg) await safeEdit(streamMsg, msg);
          else await replyFn(msg);
        } catch {}
        resolve(null);
      });
    });
  }

  // ── Register Slash Commands ──────────────────────────────────────────────

  async function registerCommands() {
    const commands = [
      // Additional commands from agent config (if any)
      ...(cfg.additionalCommands || []),

      new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Send a message to the AI assistant / \u0623\u0631\u0633\u0644 \u0631\u0633\u0627\u0644\u0629 \u0644\u0644\u0645\u0633\u0627\u0639\u062f')
        .addStringOption(opt =>
          opt.setName('message')
            .setDescription('Your message / \u0631\u0633\u0627\u0644\u062a\u0643')
            .setRequired(true)),

      new SlashCommandBuilder()
        .setName('new')
        .setDescription('Start a fresh conversation / \u0627\u0628\u062f\u0623 \u0645\u062d\u0627\u062f\u062b\u0629 \u062c\u062f\u064a\u062f\u0629'),

      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show bot status / \u0639\u0631\u0636 \u062d\u0627\u0644\u0629 \u0627\u0644\u0628\u0648\u062a'),

      new SlashCommandBuilder()
        .setName('sessions')
        .setDescription('Browse past sessions / \u062a\u0635\u0641\u062d \u0627\u0644\u062c\u0644\u0633\u0627\u062a'),

      new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume a past session / \u0627\u0633\u062a\u0626\u0646\u0627\u0641 \u062c\u0644\u0633\u0629')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Session number / \u0631\u0642\u0645 \u0627\u0644\u062c\u0644\u0633\u0629')
            .setRequired(true)),

      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Switch AI model / \u062a\u063a\u064a\u064a\u0631 \u0627\u0644\u0646\u0645\u0648\u0630\u062c')
        .addStringOption(opt =>
          opt.setName('model')
            .setDescription('Model name / \u0627\u0633\u0645 \u0627\u0644\u0646\u0645\u0648\u0630\u062c')
            .setRequired(true)
            .addChoices(
              { name: 'Opus (most capable)', value: 'opus' },
              { name: 'Sonnet (balanced)', value: 'sonnet' },
              { name: 'Haiku (fastest)', value: 'haiku' },
            )),

      new SlashCommandBuilder()
        .setName('lang')
        .setDescription('Switch language / \u062a\u063a\u064a\u064a\u0631 \u0627\u0644\u0644\u063a\u0629')
        .addStringOption(opt =>
          opt.setName('language')
            .setDescription('Language / \u0627\u0644\u0644\u063a\u0629')
            .setRequired(true)
            .addChoices(
              { name: 'English', value: 'en' },
              { name: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629 (Arabic)', value: 'ar' },
            )),

      new SlashCommandBuilder()
        .setName('dream')
        .setDescription('Capture ideas for later / \u0627\u0644\u062a\u0642\u0637 \u0623\u0641\u0643\u0627\u0631\u0643')
        .addStringOption(opt =>
          opt.setName('action')
            .setDescription('Action / \u0627\u0644\u0625\u062c\u0631\u0627\u0621')
            .setRequired(true)
            .addChoices(
              { name: 'Capture a new idea', value: 'capture' },
              { name: 'List all dreams', value: 'list' },
              { name: 'Plan a dream', value: 'plan' },
              { name: 'Execute a dream', value: 'execute' },
              { name: 'Delete a dream', value: 'delete' },
            ))
        .addStringOption(opt =>
          opt.setName('text')
            .setDescription('Dream description or ID / \u0648\u0635\u0641 \u0623\u0648 \u0645\u0639\u0631\u0641')
            .setRequired(false)),

      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop current AI process / \u0625\u064a\u0642\u0627\u0641 \u0627\u0644\u0639\u0645\u0644\u064a\u0629'),

      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show available commands / \u0639\u0631\u0636 \u0627\u0644\u0623\u0648\u0627\u0645\u0631'),
    ];

    const rest = new REST({ version: '10' }).setToken(cfg.token);

    try {
      console.log(`[${AGENT_ID}] Registering ${commands.length} slash commands...`);

      if (cfg.guildId) {
        // Guild-specific (instant)
        await rest.put(
          Routes.applicationGuildCommands(cfg.clientId, cfg.guildId),
          { body: commands.map(c => c.toJSON()) },
        );
      } else {
        // Global (takes up to 1 hour to propagate)
        await rest.put(
          Routes.applicationCommands(cfg.clientId),
          { body: commands.map(c => c.toJSON()) },
        );
      }

      console.log(`[${AGENT_ID}] Slash commands registered successfully`);
    } catch (e) {
      console.error(`[${AGENT_ID}] Failed to register commands:`, e.message);
    }
  }

  // ── Slash Command Handlers ───────────────────────────────────────────────

  async function handleChatCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(interaction);
    const message = interaction.options.getString('message');

    await interaction.deferReply();

    const replyFn = async (text) => {
      try {
        return await interaction.editReply({ content: text });
      } catch {
        return await interaction.followUp({ content: text });
      }
    };
    const editFn = async (msg, text) => {
      try {
        await interaction.editReply({ content: text });
      } catch {}
    };

    await runClaude(sessionKey, message, userId, replyFn, editFn, lang);
  }

  async function handleNewCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(interaction);

    // Archive old session (pass full session object)
    if (sessions[sessionKey]) {
      archiveSession(AGENT_ID, sessions[sessionKey], 'new_session');
    }

    // Create new session
    sessions[sessionKey] = {
      sessionId: randomUUID(),
      model: cfg.defaultModel,
      messageCount: 0,
      lastActive: Date.now(),
      userId,
      createdAt: Date.now(),
    };
    saveSessions();

    const embed = successEmbed(lang, t(lang, 'commands.new.success'));
    await interaction.reply({ embeds: [embed] });
  }

  async function handleStatusCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(interaction);
    const session = sessions[sessionKey];
    const langMeta = getLangMeta(lang);

    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const embed = createEmbed(lang, {
      title: `${cfg.statusEmoji} ${t(lang, 'commands.status.title')}`,
      fields: [
        {
          name: t(lang, 'commands.status.model'),
          value: session?.model || cfg.defaultModel,
          inline: true,
        },
        {
          name: t(lang, 'commands.status.session'),
          value: session
            ? `${t(lang, 'commands.status.active')} (${session.messageCount} ${t(lang, 'commands.status.messages').toLowerCase()})`
            : t(lang, 'commands.status.noSession'),
          inline: true,
        },
        {
          name: t(lang, 'commands.status.uptime'),
          value: `${hours}h ${minutes}m`,
          inline: true,
        },
        {
          name: t(lang, 'commands.status.language'),
          value: `${langMeta.flag} ${langMeta.nativeName}`,
          inline: true,
        },
        {
          name: 'Agent',
          value: AGENT_ID,
          inline: true,
        },
        {
          name: t(lang, 'commands.status.messages'),
          value: String(callCount),
          inline: true,
        },
      ],
    });

    await interaction.reply({ embeds: [embed] });
  }

  async function handleSessionsCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);

    const sessionsList = formatSessionsList(AGENT_ID);
    if (!sessionsList) {
      const embed = createEmbed(lang, {
        title: t(lang, 'commands.sessions.title'),
        description: t(lang, 'commands.sessions.noSessions'),
      });
      await interaction.reply({ embeds: [embed] });
      return;
    }

    const embed = createEmbed(lang, {
      title: t(lang, 'commands.sessions.title'),
      description: sessionsList.slice(0, EMBED_MAX_LEN),
    });
    await interaction.reply({ embeds: [embed] });
  }

  async function handleResumeCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(interaction);
    const sessionIndex = interaction.options.getInteger('id');

    const sessionData = getSessionByIndex(AGENT_ID, sessionIndex);
    if (!sessionData) {
      await interaction.reply({ embeds: [errorEmbed(lang, t(lang, 'commands.resume.notFound'))], ephemeral: true });
      return;
    }

    sessions[sessionKey] = {
      sessionId: sessionData.sessionId,
      model: cfg.defaultModel,
      messageCount: sessionData.messageCount || 0,
      lastActive: Date.now(),
      userId,
      createdAt: Date.now(),
    };
    saveSessions();

    const embed = successEmbed(lang, t(lang, 'commands.resume.success', { id: sessionIndex }));
    await interaction.reply({ embeds: [embed] });
  }

  async function handleModelCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(interaction);
    const model = interaction.options.getString('model');

    const session = getOrCreateSession(sessionKey, userId);
    session.model = model;
    saveSessions();

    const embed = successEmbed(lang, t(lang, 'commands.model.switched', { model }));
    await interaction.reply({ embeds: [embed] });
  }

  async function handleLangCommand(interaction) {
    const userId = interaction.user.id;
    const newLang = interaction.options.getString('language');

    setUserLang(userId, newLang);
    const langMeta = getLangMeta(newLang);

    const embed = successEmbed(newLang, t(newLang, 'commands.lang.switched', { lang: `${langMeta.flag} ${langMeta.nativeName}` }));
    await interaction.reply({ embeds: [embed] });
  }

  async function handleDreamCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const action = interaction.options.getString('action');
    const text = interaction.options.getString('text');

    // Dynamic import dream feature
    let dreamModule;
    try {
      dreamModule = await import('./dream-feature.js');
    } catch {
      await interaction.reply({ embeds: [errorEmbed(lang, 'Dream feature not available')], ephemeral: true });
      return;
    }

    switch (action) {
      case 'capture': {
        if (!text) {
          await interaction.reply({ embeds: [errorEmbed(lang, t(lang, 'commands.chat.emptyMessage'))], ephemeral: true });
          return;
        }
        const dream = await dreamModule.saveDream(AGENT_ID, text, interaction.user.username);
        const embed = successEmbed(lang, `${t(lang, 'commands.dream.captured')}\n\nID: \`${dream.id}\``);
        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'list': {
        const dreams = await dreamModule.listDreams(AGENT_ID);
        if (!dreams || dreams.length === 0) {
          await interaction.reply({ embeds: [createEmbed(lang, {
            title: t(lang, 'commands.dream.title'),
            description: t(lang, 'commands.dream.noDreams'),
          })] });
          return;
        }
        const list = dreams.map((d, i) => `**${i + 1}.** ${d.description?.slice(0, 80)}${d.description?.length > 80 ? '...' : ''}\n   \`${d.id}\` \u2014 ${d.status}`).join('\n\n');
        await interaction.reply({ embeds: [createEmbed(lang, {
          title: t(lang, 'commands.dream.title'),
          description: list.slice(0, EMBED_MAX_LEN),
        })] });
        break;
      }
      case 'delete': {
        if (!text) {
          await interaction.reply({ embeds: [errorEmbed(lang, 'Please provide a dream ID or number')], ephemeral: true });
          return;
        }
        try {
          // Resolve by index or ID
          const dream = dreamModule.getDream ? await dreamModule.getDream(AGENT_ID, text) : null;
          const dreamId = dream?.id || text;
          await dreamModule.deleteDream(AGENT_ID, dreamId);
          await interaction.reply({ embeds: [successEmbed(lang, t(lang, 'commands.dream.deleted'))] });
        } catch {
          await interaction.reply({ embeds: [errorEmbed(lang, t(lang, 'commands.dream.notFound'))], ephemeral: true });
        }
        break;
      }
      default: {
        // plan and execute go through Claude
        await interaction.deferReply();
        const sessionKey = getSessionKey(interaction);
        const prompt = `/dream ${action} ${text || ''}`.trim();
        const replyFn = async (txt) => interaction.editReply({ content: txt });
        const editFn = async (msg, txt) => interaction.editReply({ content: txt });
        await runClaude(sessionKey, prompt, userId, replyFn, editFn, lang);
      }
    }
  }

  async function handleStopCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(interaction);

    if (activeProcesses[sessionKey]) {
      try { activeProcesses[sessionKey].proc.kill('SIGTERM'); } catch {}
      delete activeProcesses[sessionKey];
      await interaction.reply({ embeds: [successEmbed(lang, t(lang, 'commands.stop.success'))] });
    } else {
      await interaction.reply({ embeds: [createEmbed(lang, {
        description: t(lang, 'commands.stop.noProcess'),
        color: cfg.embedColorWarning,
      })], ephemeral: true });
    }
  }

  async function handleHelpCommand(interaction) {
    const userId = interaction.user.id;
    const lang = getUserLang(userId);
    const cmdList = t(lang, 'commands.help.commandList');

    const fields = Object.entries(cmdList).map(([cmd, desc]) => ({
      name: `\`/${cmd}\``,
      value: desc,
      inline: true,
    }));

    const embed = createEmbed(lang, {
      title: `\u2753 ${t(lang, 'commands.help.title')}`,
      fields,
    });
    embed.setFooter({ text: t(lang, 'commands.help.footer') });

    // Add language switch button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('switch_lang')
        .setLabel(lang === 'en' ? '\ud83c\uddf8\ud83c\udde6 \u0627\u0644\u0639\u0631\u0628\u064a\u0629' : '\ud83c\uddec\ud83c\udde7 English')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('new_chat')
        .setLabel(t(lang, 'buttons.newChat'))
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  // ── Event Handlers ───────────────────────────────────────────────────────

  // Slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    // Handle button clicks
    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const lang = getUserLang(userId);

      if (interaction.customId === 'switch_lang') {
        const newLang = lang === 'en' ? 'ar' : 'en';
        setUserLang(userId, newLang);
        const langMeta = getLangMeta(newLang);
        await interaction.reply({
          embeds: [successEmbed(newLang, t(newLang, 'commands.lang.switched', { lang: `${langMeta.flag} ${langMeta.nativeName}` }))],
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId === 'new_chat') {
        const sessionKey = getSessionKey(interaction);
        sessions[sessionKey] = {
          sessionId: randomUUID(),
          model: cfg.defaultModel,
          messageCount: 0,
          lastActive: Date.now(),
          userId,
          createdAt: Date.now(),
        };
        saveSessions();
        await interaction.reply({
          embeds: [successEmbed(lang, t(lang, 'commands.new.success'))],
          ephemeral: true,
        });
        return;
      }

      return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;
    if (!isAllowedUser(userId)) {
      const lang = getUserLang(userId);
      await interaction.reply({ content: t(lang, 'common.noPermission'), ephemeral: true });
      return;
    }

    const { commandName } = interaction;

    try {
      switch (commandName) {
        case 'chat':     return await handleChatCommand(interaction);
        case 'new':      return await handleNewCommand(interaction);
        case 'status':   return await handleStatusCommand(interaction);
        case 'sessions': return await handleSessionsCommand(interaction);
        case 'resume':   return await handleResumeCommand(interaction);
        case 'model':    return await handleModelCommand(interaction);
        case 'lang':     return await handleLangCommand(interaction);
        case 'dream':    return await handleDreamCommand(interaction);
        case 'stop':     return await handleStopCommand(interaction);
        case 'help':     return await handleHelpCommand(interaction);
        default: {
          // Check custom commands
          if (cfg.customCommands?.[`/${commandName}`]) {
            await cfg.customCommands[`/${commandName}`](interaction);
          }
        }
      }
    } catch (e) {
      console.error(`[${AGENT_ID}] Command error (${commandName}):`, e.message);
      const lang = getUserLang(userId);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: t(lang, 'common.error') });
        } else {
          await interaction.reply({ content: t(lang, 'common.error'), ephemeral: true });
        }
      } catch {}
    }
  });

  // Regular messages (DMs and allowed channels)
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Permission checks
    if (!isAllowedUser(message.author.id)) return;
    if (!isAllowedChannel(message.channelId, message.channel.type)) return;

    // In guild channels, only respond if mentioned, in allowed channel, or respondInAllGuildChannels is set
    if (message.guild && !cfg.respondInAllGuildChannels && !cfg.allowedChannels?.includes(message.channelId)) {
      if (!message.mentions.has(client.user)) return;
    }

    const userId = message.author.id;
    const lang = getUserLang(userId);
    const sessionKey = getSessionKey(message);

    // Get message content (strip bot mention if present)
    let content = message.content;
    if (client.user) {
      content = content.replace(new RegExp(`<@!?${client.user.id}>`), '').trim();
    }

    // Collect attachments
    const attachments = [];
    for (const [, att] of message.attachments) {
      attachments.push({
        url: att.url,
        contentType: att.contentType,
        name: att.name,
      });
    }

    if (!content && attachments.length === 0) return;

    // Reply helper
    const replyFn = async (text) => {
      return await message.reply({ content: text, allowedMentions: { repliedUser: false } });
    };
    const editFn = async (msg, text) => {
      try { await msg.edit({ content: text }); } catch {}
    };

    // Show typing indicator
    try { await message.channel.sendTyping(); } catch {}

    const result = await runClaude(sessionKey, content, userId, replyFn, editFn, lang, attachments);

    // Post-response hook — allows bots to process responses (e.g., delegation, cross-channel posting)
    if (cfg.onResponseComplete && result) {
      try {
        await cfg.onResponseComplete({ result, message, userId, lang, channelName: message.channel?.name });
      } catch (e) {
        console.error(`[${AGENT_ID}] onResponseComplete error:`, e.message);
      }
    }
  });

  // ── Client Ready ─────────────────────────────────────────────────────────

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`${cfg.statusEmoji} ${AGENT_ID} Discord Bot ready as ${readyClient.user.tag}`);
    console.log(`  Guilds: ${readyClient.guilds.cache.size}`);
    console.log(`  PID: ${process.pid}`);

    // Register slash commands
    await registerCommands();

    // Health heartbeat
    const writeHealth = () => {
      try {
        fs.writeFileSync(HEALTH_FILE, JSON.stringify({
          agent: AGENT_ID,
          platform: 'discord',
          status: 'online',
          user: readyClient.user.tag,
          guilds: readyClient.guilds.cache.size,
          uptime: Date.now() - startedAt,
          callCount,
          pid: process.pid,
          timestamp: new Date().toISOString(),
        }, null, 2));
      } catch {}
    };
    writeHealth();
    setInterval(writeHealth, 60000);
  });

  // ── Error Handling ───────────────────────────────────────────────────────

  client.on('error', (error) => {
    console.error(`[${AGENT_ID}] Discord client error:`, error.message);
  });

  client.on('warn', (warning) => {
    console.warn(`[${AGENT_ID}] Discord warning:`, warning);
  });

  // ── Login ────────────────────────────────────────────────────────────────

  client.login(cfg.token).catch((err) => {
    console.error(`[${AGENT_ID}] Failed to login to Discord:`, err.message);
    process.exit(1);
  });

  // ── Graceful Shutdown ────────────────────────────────────────────────────

  function shutdown(signal) {
    console.log(`[${AGENT_ID}] Discord bot shutting down (${signal})`);

    // Kill active processes
    for (const [key, proc] of Object.entries(activeProcesses)) {
      try { proc.proc.kill('SIGTERM'); } catch {}
    }

    // Save sessions
    saveSessions();

    // Destroy client
    try { client.destroy(); } catch {}

    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── Return Interface ─────────────────────────────────────────────────────

  return {
    client,
    shutdown,
    getState: () => ({
      agent: AGENT_ID,
      platform: 'discord',
      uptime: Date.now() - startedAt,
      callCount,
      activeSessions: Object.keys(sessions).length,
      activeProcesses: Object.keys(activeProcesses).length,
    }),
  };
}

export default createDiscordBot;
