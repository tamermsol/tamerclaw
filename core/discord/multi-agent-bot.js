#!/usr/bin/env node
/**
 * TamerClaw Multi-Agent Discord Gateway
 *
 * A portable Discord bot that routes messages to different Claude AI agents
 * based on channel mapping. Each channel maps to a specific agent from the
 * agency, and the bot spawns Claude CLI sessions per agent with streaming.
 *
 * Features:
 *   - Agent discovery from core/powerup/agency.json + user/agents/
 *   - Channel-to-agent routing with auto-setup
 *   - Slash commands: /chat, /new, /status, /agent, /model, /help, /setup-channels
 *   - Claude CLI streaming with live Discord message edits
 *   - Session persistence per channel in user/discord-sessions.json
 *   - Channel map persistence in user/discord-channels.json
 *   - DM support (routes to default agent)
 *   - Health heartbeat to user/discord-health.json
 *   - Circuit breaker for rate limits
 *   - Graceful shutdown
 *
 * Usage:
 *   node core/discord/multi-agent-bot.js
 *
 * Config: user/config.json → discord { token, clientId, guildId, multiAgent, defaultAgent }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  Partials,
  ChannelType,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import paths from '../shared/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[multi-agent]';
const DISCORD_MAX_LEN = 2000;
const EMBED_MAX_LEN = 4096;
const STREAM_EDIT_INTERVAL_MS = 800;
const SUBPROCESS_TIMEOUT_MS = 600000;  // 10 minutes
const HEALTH_INTERVAL_MS = 30000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 20;             // max messages per window per user

// ── Claude Binary Resolution ─────────────────────────────────────────────────

const CLAUDE_BIN = (() => {
  const candidates = [
    path.join(process.env.HOME || '/root', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return candidates[0];
})();

// ── Singleton Lock ───────────────────────────────────────────────────────────

const LOCK_FILE = path.join(paths.user, 'multi-agent-bot.lock');

function acquireLock() {
  const pid = process.pid;
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== pid) {
        try {
          process.kill(oldPid, 0);
          console.log(`${LOG_PREFIX} Another instance running (PID ${oldPid}). Killing it.`);
          process.kill(oldPid, 'SIGTERM');
          const start = Date.now();
          while (Date.now() - start < 3000) {
            try { process.kill(oldPid, 0); } catch { break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        } catch {
          // Process already dead
        }
      }
    } catch {}
  }
  fs.writeFileSync(LOCK_FILE, String(pid));
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (lockPid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

process.on('exit', releaseLock);

// ── Load Config ──────────────────────────────────────────────────────────────

let config = {};
try {
  if (fs.existsSync(paths.config)) {
    config = JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
  }
} catch (e) {
  console.error(`${LOG_PREFIX} Failed to load config:`, e.message);
}

const discordConfig = config.discord || {};

const token = process.env.TAMERCLAW_DISCORD_TOKEN
  || discordConfig.token
  || '';

const clientId = process.env.TAMERCLAW_DISCORD_CLIENT_ID
  || discordConfig.clientId
  || '';

const guildId = process.env.TAMERCLAW_DISCORD_GUILD_ID
  || discordConfig.guildId
  || null;

const defaultAgentId = discordConfig.defaultAgent || 'supreme';
const defaultModel = discordConfig.defaultModel || config.defaultModel || 'sonnet';

// Token/clientId validation is deferred to startup time (startMultiAgentBot or standalone).
// This allows safe importing without process.exit at module load.
function validateConfig() {
  if (!token) {
    console.error('FATAL: Discord bot token not configured.');
    console.error('Set discord.token in user/config.json or TAMERCLAW_DISCORD_TOKEN env var.');
    console.error('Run: ./tamerclaw discord setup');
    return false;
  }
  if (!clientId) {
    console.error('FATAL: Discord client ID not configured.');
    console.error('Set discord.clientId in user/config.json or TAMERCLAW_DISCORD_CLIENT_ID env var.');
    return false;
  }
  return true;
}

// ── Agent Discovery ──────────────────────────────────────────────────────────

/**
 * Load agents from agency.json and scan user/agents/ directory.
 * Returns a Map of agentId → { id, displayName, emoji, role, teamId, hasIdentity }
 */
function discoverAgents() {
  const agents = new Map();

  // 1. Load from core/powerup/agency.json
  const agencyPath = path.join(paths.core, 'powerup', 'agency.json');
  try {
    if (fs.existsSync(agencyPath)) {
      const agency = JSON.parse(fs.readFileSync(agencyPath, 'utf-8'));
      if (agency.agents && Array.isArray(agency.agents)) {
        for (const agent of agency.agents) {
          agents.set(agent.id, {
            id: agent.id,
            displayName: agent.displayName || agent.id,
            emoji: agent.emoji || '🤖',
            role: agent.role || '',
            teamId: agent.teamId || null,
            order: agent.order || 99,
            hasIdentity: false,
          });
        }
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to load agency.json:`, e.message);
  }

  // 2. Add supreme agent (the CEO/coordinator)
  if (!agents.has('supreme')) {
    agents.set('supreme', {
      id: 'supreme',
      displayName: 'Supreme',
      emoji: '👑',
      role: 'CEO — coordinates all agents and oversees all operations',
      teamId: 'leadership',
      order: 0,
      hasIdentity: false,
    });
  }

  // 3. Scan user/agents/ for installed agents
  try {
    if (fs.existsSync(paths.agents)) {
      const dirs = fs.readdirSync(paths.agents, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const agentId = dir.name;
        const identityPath = path.join(paths.agents, agentId, 'IDENTITY.md');
        const hasIdentity = fs.existsSync(identityPath);

        if (agents.has(agentId)) {
          // Update existing — mark as having identity
          agents.get(agentId).hasIdentity = hasIdentity;
        } else {
          // New user-installed agent
          agents.set(agentId, {
            id: agentId,
            displayName: agentId.charAt(0).toUpperCase() + agentId.slice(1),
            emoji: '🤖',
            role: `User-installed agent: ${agentId}`,
            teamId: null,
            order: 100,
            hasIdentity,
          });
        }
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to scan user/agents:`, e.message);
  }

  return agents;
}

const agents = discoverAgents();
console.log(`${LOG_PREFIX} Discovered ${agents.size} agents: ${[...agents.keys()].join(', ')}`);

// ── Channel Map Persistence ──────────────────────────────────────────────────

const CHANNEL_MAP_FILE = path.join(paths.user, 'discord-channels.json');
const SESSIONS_FILE = path.join(paths.user, 'discord-sessions.json');
const HEALTH_FILE = path.join(paths.user, 'discord-health.json');

// channelId → agentId
let channelAgentMap = {};

function loadChannelMap() {
  try {
    if (fs.existsSync(CHANNEL_MAP_FILE)) {
      channelAgentMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf-8'));
    }
  } catch {}
}

function saveChannelMap() {
  try {
    fs.writeFileSync(CHANNEL_MAP_FILE, JSON.stringify(channelAgentMap, null, 2));
  } catch {}
}

loadChannelMap();

// ── Session Management ───────────────────────────────────────────────────────

const sessions = {};       // sessionKey → { sessionId, agentId, model, messageCount, ... }
const activeProcesses = {}; // sessionKey → { proc, startedAt }
let callCount = 0;
const startedAt = Date.now();

// Load persisted sessions
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

function getSessionKey(source) {
  if (source.channel?.type === ChannelType.DM) {
    return `dm-${source.user?.id || source.author?.id}`;
  }
  return `ch-${source.channelId}`;
}

function resolveAgent(channelId, channelName) {
  // 1. Explicit channel map
  if (channelAgentMap[channelId]) return channelAgentMap[channelId];

  // 2. Match channel name to agent ID
  if (channelName) {
    const normalizedName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (agents.has(normalizedName)) return normalizedName;

    // Try partial matches
    for (const [agentId] of agents) {
      if (normalizedName.includes(agentId) || agentId.includes(normalizedName)) {
        return agentId;
      }
    }
  }

  // 3. Default agent
  return defaultAgentId;
}

function getOrCreateSession(sessionKey, userId, agentId) {
  if (!sessions[sessionKey] || sessions[sessionKey].agentId !== agentId) {
    sessions[sessionKey] = {
      sessionId: randomUUID(),
      agentId,
      model: defaultModel,
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

// ── Rate Limiter (Circuit Breaker) ───────────────────────────────────────────

const rateLimitBuckets = {}; // userId → { count, windowStart }

function checkRateLimit(userId) {
  const now = Date.now();
  if (!rateLimitBuckets[userId] || now - rateLimitBuckets[userId].windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets[userId] = { count: 0, windowStart: now };
  }
  rateLimitBuckets[userId].count++;
  return rateLimitBuckets[userId].count <= RATE_LIMIT_MAX;
}

// ── Agent Identity Loading ───────────────────────────────────────────────────

function loadSystemPrompt(agentId) {
  const agentDir = paths.agentDir(agentId);
  const parts = [];

  // Load identity files in order
  for (const file of ['IDENTITY.md', 'MEMORY.md', 'USER.md', 'TOOLS.md']) {
    const filePath = path.join(agentDir, file);
    try {
      if (fs.existsSync(filePath)) {
        parts.push(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch {}
  }

  // Fallback: generate a generic prompt from agent metadata
  if (parts.length === 0) {
    const meta = agents.get(agentId);
    if (meta) {
      parts.push(`# ${meta.displayName}\n\nYou are the ${meta.displayName} for the TamerClaw agency.\nRole: ${meta.role}\n\nYou are an expert in your domain. Help the user with tasks related to your role. Be concise, professional, and actionable.`);
    } else {
      parts.push(`# ${agentId}\n\nYou are the ${agentId} agent. Help the user with their request. Be concise and actionable.`);
    }
  }

  // Add platform context
  parts.push(`\n# Platform Context\n- Platform: Discord (multi-agent gateway)\n- Agent: ${agentId}\n- Current date: ${new Date().toISOString().split('T')[0]}\n- Use Discord markdown formatting (bold, code blocks, etc.)\n- Keep responses concise — Discord has a 2000 character limit per message.`);

  return parts.join('\n\n---\n\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitMessage(text, maxLen = DISCORD_MAX_LEN) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = remaining.lastIndexOf(' ', maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

function fmtTool(name) {
  const map = {
    'Read': '📖 Reading',
    'Write': '✏️ Writing',
    'Edit': '🔧 Editing',
    'Bash': '⚡ Running command',
    'Glob': '🔍 Searching files',
    'Grep': '🔍 Searching code',
    'Agent': '🤖 Sub-agent',
    'WebSearch': '🌐 Searching web',
    'WebFetch': '🌐 Fetching page',
  };
  return map[name] || `🔧 ${name}`;
}

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

function createEmbed(options = {}) {
  const embed = new EmbedBuilder()
    .setColor(options.color || '#5865F2')
    .setTimestamp();
  if (options.title) embed.setTitle(options.title);
  if (options.description) embed.setDescription(options.description.slice(0, EMBED_MAX_LEN));
  if (options.fields) embed.addFields(options.fields);
  if (options.footer !== false) {
    embed.setFooter({ text: options.footerText || 'TamerClaw Multi-Agent Gateway' });
  }
  return embed;
}

// ── Ensure Agent Workspace ───────────────────────────────────────────────────

function ensureAgentDirs(agentId) {
  const agentDir = paths.agentDir(agentId);
  for (const sub of ['', 'workspace', 'media', 'memory', 'sessions']) {
    const dir = path.join(agentDir, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(agentDir, 'workspace');
}

// ── Claude CLI Runner ────────────────────────────────────────────────────────

async function runClaude(sessionKey, messageText, userId, agentId, replyFn, editFn) {
  const session = getOrCreateSession(sessionKey, userId, agentId);
  session.messageCount++;
  saveSessions();

  // Prevent concurrent processes per session
  if (activeProcesses[sessionKey]) {
    await replyFn('⏳ Still processing your previous message. Please wait or use `/stop`.');
    return null;
  }

  if (!messageText?.trim()) {
    await replyFn('Please provide a message.');
    return null;
  }

  const systemPrompt = loadSystemPrompt(agentId);
  const cwd = ensureAgentDirs(agentId);
  const agentMeta = agents.get(agentId);
  const agentEmoji = agentMeta?.emoji || '🤖';

  // Build CLI args
  const isResume = session.messageCount > 1;
  const args = [
    '-p', messageText,
    '--verbose',
    '--output-format', 'stream-json',
    '--model', session.model,
    '--max-turns', '200',
    '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep,Agent,WebSearch,WebFetch',
  ];

  if (isResume) {
    args.push('--resume', session.sessionId, '--append-system-prompt', systemPrompt);
  } else {
    args.push('--session-id', session.sessionId, '--system-prompt', systemPrompt);
  }

  // Streaming state
  let streamMsg = null;
  let streamContent = '';
  let lastEditTime = 0;
  let streamedAnyText = false;
  let lastToolActivity = '';
  let toolCount = 0;
  let inToolPhase = false;
  let lastProgressSent = 0;
  const events = [];
  const startTime = Date.now();
  const STREAM_MSG_MAX = DISCORD_MAX_LEN - 60;

  function elapsedStr() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${secs}s`;
  }

  async function safeEdit(msg, text) {
    if (!msg) return;
    try {
      const truncated = text.length > DISCORD_MAX_LEN ? text.slice(0, DISCORD_MAX_LEN - 3) + '...' : text;
      await editFn(msg, truncated);
    } catch (e) {
      if (e.code === 10008) streamMsg = null; // message deleted
    }
  }

  async function doStreamUpdate() {
    if (!streamMsg || !streamContent) return;
    const now = Date.now();
    if (streamedAnyText && now - lastEditTime < STREAM_EDIT_INTERVAL_MS) return;
    lastEditTime = now;

    // Handle overflow — if text exceeds a single message
    if (streamContent.length > STREAM_MSG_MAX) {
      let splitAt = streamContent.lastIndexOf('\n\n', STREAM_MSG_MAX);
      if (splitAt < STREAM_MSG_MAX * 0.3) splitAt = streamContent.lastIndexOf('\n', STREAM_MSG_MAX);
      if (splitAt < STREAM_MSG_MAX * 0.3) splitAt = STREAM_MSG_MAX;

      const finalizedText = streamContent.slice(0, splitAt);
      const remainingText = streamContent.slice(splitAt).trimStart();

      await safeEdit(streamMsg, finalizedText);
      streamContent = remainingText;
      if (remainingText.length > 0) {
        try { streamMsg = await replyFn(remainingText + ' ▌'); } catch { streamMsg = null; }
      } else {
        streamMsg = null;
      }
      return;
    }

    await safeEdit(streamMsg, streamContent + ' ▌');
    streamedAnyText = true;
  }

  // Initial "thinking" message
  try {
    streamMsg = await replyFn(`${agentEmoji} Thinking...`);
  } catch {}

  // Spawn Claude CLI
  const env = { ...process.env, HOME: '/root' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
  }

  const proc = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcesses[sessionKey] = { proc, startedAt: startTime };
  callCount++;

  let buffer = '';
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGTERM'); } catch {}
  }, SUBPROCESS_TIMEOUT_MS);

  // Progress timer — keeps user informed during long tool runs
  const progressTimer = setInterval(async () => {
    const now = Date.now();
    const elapsed = Math.floor((now - startTime) / 1000);
    if (elapsed < 8) return;
    if (now - lastEditTime < 4000 && now - lastProgressSent < 4000) return;
    if (!streamMsg) return;

    const timeStr = elapsedStr();
    if (streamedAnyText) {
      const indicator = `\n\n⏳ ${lastToolActivity || 'Working...'} (${timeStr})`;
      const displayText = streamContent + indicator;
      if (displayText.length < DISCORD_MAX_LEN - 10) {
        await safeEdit(streamMsg, displayText);
      }
    } else {
      const dots = '.'.repeat(1 + (Math.floor(elapsed / 3) % 3));
      await safeEdit(streamMsg, `${agentEmoji} Thinking${dots}\n${lastToolActivity || 'Analyzing...'} (${timeStr})${toolCount > 0 ? ` · ${toolCount} steps` : ''}`);
    }
    lastProgressSent = now;
  }, 4000);

  // Parse stream-json events from stdout
  proc.stdout.on('data', async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);

        // Assistant text blocks
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              if (inToolPhase && streamContent.length > 0) streamContent += '\n\n';
              inToolPhase = false;
              streamContent += block.text;
              await doStreamUpdate();
            }
            if (block.type === 'tool_use') {
              lastToolActivity = fmtTool(block.name);
              toolCount++;
              inToolPhase = true;
            }
          }
        }

        // Incremental text deltas
        if (event.type === 'content_block_delta' && event.delta?.text) {
          if (inToolPhase && streamContent.length > 0) streamContent += '\n\n';
          inToolPhase = false;
          streamContent += event.delta.text;
          await doStreamUpdate();
        }

        // Tool use events
        if (event.type === 'tool_use') {
          lastToolActivity = fmtTool(event.name || event.tool_name);
          toolCount++;
          inToolPhase = true;
        }
      } catch {}
    }
  });

  let stderrBuffer = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    const trimmed = text.trim();
    if (trimmed && !trimmed.startsWith('Debugger') && !trimmed.startsWith('Warning:')) {
      console.error(`${LOG_PREFIX} [${agentId}] stderr: ${trimmed.slice(0, 500)}`);
    }
  });

  return new Promise((resolve) => {
    proc.on('close', async (code) => {
      clearTimeout(timeout);
      clearInterval(progressTimer);
      delete activeProcesses[sessionKey];

      const result = extractResultFromEvents(events) || streamContent;

      if (code !== 0 && code !== null) {
        console.error(`${LOG_PREFIX} [${agentId}] Claude exited with code ${code}. Events: ${events.length}`);
        if (stderrBuffer.trim()) {
          console.error(`${LOG_PREFIX} [${agentId}] stderr: ${stderrBuffer.trim().slice(0, 500)}`);
        }
      }

      if (timedOut) {
        try {
          const msg = '⏰ Response timed out. Try a simpler request or use `/new` to start fresh.';
          if (streamMsg) await safeEdit(streamMsg, msg);
          else await replyFn(msg);
        } catch {}
        resolve(null);
        return;
      }

      if (!result) {
        console.error(`${LOG_PREFIX} [${agentId}] No result. Exit: ${code}, events: ${events.length}, stderr: ${stderrBuffer.trim().slice(0, 300)}`);
        try {
          const msg = '❌ No response received. The agent may have encountered an error. Try `/new` to reset.';
          if (streamMsg) await safeEdit(streamMsg, msg);
          else await replyFn(msg);
        } catch {}
        resolve(null);
        return;
      }

      // Send final response
      try {
        const chunks = splitMessage(result);
        if (streamMsg) {
          await safeEdit(streamMsg, chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await replyFn(chunks[i]);
          }
        } else {
          for (const chunk of chunks) await replyFn(chunk);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} [${agentId}] Send failed:`, e.message);
      }

      resolve(result);
    });

    proc.on('error', async (err) => {
      clearTimeout(timeout);
      clearInterval(progressTimer);
      delete activeProcesses[sessionKey];
      console.error(`${LOG_PREFIX} [${agentId}] Process error:`, err.message);
      try {
        const msg = '❌ Failed to start AI process. Check that Claude CLI is installed.';
        if (streamMsg) await safeEdit(streamMsg, msg);
        else await replyFn(msg);
      } catch {}
      resolve(null);
    });
  });
}

// ── Auto Channel Setup ───────────────────────────────────────────────────────

const CHANNEL_STRUCTURE = {
  '🏢 LEADERSHIP': {
    channels: [
      { name: 'command-center', agent: 'supreme', topic: 'Supreme agent — CEO and coordinator' },
      { name: 'announcements', agent: null, topic: 'Agency announcements and updates' },
    ],
  },
  '💻 ENGINEERING': {
    channels: [
      { name: 'cto', agent: 'cto', topic: 'CTO — Engineering team leader' },
      { name: 'flutter', agent: 'flutter', topic: 'Flutter development — mobile apps' },
      { name: 'frontend', agent: 'frontend', topic: 'Frontend — React, Next.js, TypeScript' },
      { name: 'backend', agent: 'backend', topic: 'Backend — APIs, databases, infrastructure' },
      { name: 'qa', agent: 'qa', topic: 'QA — Testing, bug hunting, quality assurance' },
    ],
  },
  '📣 MARKETING': {
    channels: [
      { name: 'cmo', agent: 'cmo', topic: 'CMO — Marketing team leader' },
      { name: 'presentations', agent: 'presentations', topic: 'Presentation design — decks, pitch materials' },
      { name: 'digital-marketing', agent: 'digital-marketing', topic: 'Digital marketing — SEO, social, campaigns' },
    ],
  },
  '⚙️ SYSTEM': {
    channels: [
      { name: 'logs', agent: null, topic: 'Bot logs and system messages' },
      { name: 'settings', agent: null, topic: 'Bot settings and configuration' },
    ],
  },
};

async function setupChannels(guild) {
  const created = [];
  const existing = [];

  for (const [categoryName, categoryDef] of Object.entries(CHANNEL_STRUCTURE)) {
    // Find or create category
    let category = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildCategory && ch.name === categoryName
    );

    if (!category) {
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
        });
        console.log(`${LOG_PREFIX} Created category: ${categoryName}`);
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to create category ${categoryName}:`, e.message);
        continue;
      }
    }

    // Create channels under category
    for (const chDef of categoryDef.channels) {
      let channel = guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildText && ch.name === chDef.name
      );

      if (channel) {
        existing.push(chDef.name);
        // Ensure mapping exists
        if (chDef.agent) {
          channelAgentMap[channel.id] = chDef.agent;
        }
      } else {
        try {
          channel = await guild.channels.create({
            name: chDef.name,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: chDef.topic || '',
          });
          created.push(chDef.name);
          console.log(`${LOG_PREFIX} Created channel: #${chDef.name}`);

          // Map channel to agent
          if (chDef.agent) {
            channelAgentMap[channel.id] = chDef.agent;
          }
        } catch (e) {
          console.error(`${LOG_PREFIX} Failed to create channel #${chDef.name}:`, e.message);
        }
      }
    }
  }

  saveChannelMap();
  return { created, existing };
}

// ── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── Slash Command Registration ───────────────────────────────────────────────

async function registerCommands() {
  // Build agent choices for slash commands (max 25)
  const agentChoices = [...agents.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .slice(0, 25)
    .map(([id, meta]) => ({
      name: `${meta.emoji} ${meta.displayName}`,
      value: id,
    }));

  const commands = [
    new SlashCommandBuilder()
      .setName('chat')
      .setDescription('Send a message to an AI agent')
      .addStringOption(opt =>
        opt.setName('message').setDescription('Your message').setRequired(true))
      .addStringOption(opt => {
        opt.setName('agent').setDescription('Which agent to use').setRequired(false);
        if (agentChoices.length) opt.addChoices(...agentChoices);
        return opt;
      }),

    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Start a new conversation in this channel'),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot and agent status'),

    new SlashCommandBuilder()
      .setName('agent')
      .setDescription('Switch the agent for this channel')
      .addStringOption(opt => {
        opt.setName('name').setDescription('Agent to switch to').setRequired(true);
        if (agentChoices.length) opt.addChoices(...agentChoices);
        return opt;
      }),

    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Switch the AI model')
      .addStringOption(opt =>
        opt.setName('model').setDescription('Model name').setRequired(true)
          .addChoices(
            { name: 'Opus (most capable)', value: 'opus' },
            { name: 'Sonnet (balanced)', value: 'sonnet' },
            { name: 'Haiku (fastest)', value: 'haiku' },
          )),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show available commands and agents'),

    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop the current AI process'),

    new SlashCommandBuilder()
      .setName('setup-channels')
      .setDescription('Create agent channels (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  ];

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands.map(c => c.toJSON()),
      });
    } else {
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map(c => c.toJSON()),
      });
    }
    console.log(`${LOG_PREFIX} ${commands.length} slash commands registered`);
  } catch (e) {
    console.error(`${LOG_PREFIX} Command registration failed:`, e.message);
  }
}

// ── Interaction Handler (Slash Commands) ─────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  const sessionKey = getSessionKey(interaction);
  const { commandName } = interaction;

  try {
    switch (commandName) {
      // ── /chat [message] [agent] ─────────────────────────────────────
      case 'chat': {
        const message = interaction.options.getString('message');
        const agentOpt = interaction.options.getString('agent');
        const channelName = interaction.channel?.name || '';
        const agentId = agentOpt || resolveAgent(interaction.channelId, channelName);

        if (!checkRateLimit(userId)) {
          await interaction.reply({ content: '⚠️ Rate limit reached. Please wait a moment.', ephemeral: true });
          return;
        }

        await interaction.deferReply();

        const replyFn = async (txt) => {
          try { return await interaction.editReply({ content: txt }); }
          catch { return await interaction.followUp({ content: txt }); }
        };
        const editFn = async (msg, txt) => {
          try { await interaction.editReply({ content: txt }); } catch {}
        };

        await runClaude(sessionKey, message, userId, agentId, replyFn, editFn);
        break;
      }

      // ── /new ────────────────────────────────────────────────────────
      case 'new': {
        const channelName = interaction.channel?.name || '';
        const agentId = sessions[sessionKey]?.agentId || resolveAgent(interaction.channelId, channelName);

        sessions[sessionKey] = {
          sessionId: randomUUID(),
          agentId,
          model: defaultModel,
          messageCount: 0,
          lastActive: Date.now(),
          userId,
          createdAt: Date.now(),
        };
        saveSessions();

        const meta = agents.get(agentId);
        await interaction.reply({
          embeds: [createEmbed({
            description: `✅ New conversation started with **${meta?.emoji || '🤖'} ${meta?.displayName || agentId}**`,
            color: '#57F287',
          })],
        });
        break;
      }

      // ── /status ─────────────────────────────────────────────────────
      case 'status': {
        const session = sessions[sessionKey];
        const uptime = Math.floor((Date.now() - startedAt) / 1000);
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const activeAgentId = session?.agentId || defaultAgentId;
        const meta = agents.get(activeAgentId);

        await interaction.reply({
          embeds: [createEmbed({
            title: '🤖 Multi-Agent Gateway Status',
            fields: [
              { name: 'Current Agent', value: `${meta?.emoji || '🤖'} ${meta?.displayName || activeAgentId}`, inline: true },
              { name: 'Model', value: session?.model || defaultModel, inline: true },
              { name: 'Uptime', value: `${h}h ${m}m`, inline: true },
              { name: 'Total Messages', value: String(callCount), inline: true },
              { name: 'Session Messages', value: String(session?.messageCount || 0), inline: true },
              { name: 'Active Processes', value: String(Object.keys(activeProcesses).length), inline: true },
              { name: 'Available Agents', value: String(agents.size), inline: true },
              { name: 'Channel Mappings', value: String(Object.keys(channelAgentMap).length), inline: true },
            ],
          })],
        });
        break;
      }

      // ── /agent [name] ───────────────────────────────────────────────
      case 'agent': {
        const agentName = interaction.options.getString('name');

        if (!agents.has(agentName)) {
          const available = [...agents.values()]
            .sort((a, b) => a.order - b.order)
            .map(a => `${a.emoji} **${a.id}** — ${a.role}`)
            .join('\n');

          await interaction.reply({
            embeds: [createEmbed({
              title: '❌ Agent Not Found',
              description: `Agent "${agentName}" not found.\n\n**Available agents:**\n${available}`,
              color: '#ED4245',
            })],
            ephemeral: true,
          });
          return;
        }

        // Update channel mapping
        if (interaction.channelId && interaction.channel?.type !== ChannelType.DM) {
          channelAgentMap[interaction.channelId] = agentName;
          saveChannelMap();
        }

        // Reset session for new agent
        const meta = agents.get(agentName);
        sessions[sessionKey] = {
          sessionId: randomUUID(),
          agentId: agentName,
          model: sessions[sessionKey]?.model || defaultModel,
          messageCount: 0,
          lastActive: Date.now(),
          userId,
          createdAt: Date.now(),
        };
        saveSessions();

        await interaction.reply({
          embeds: [createEmbed({
            description: `✅ Switched to **${meta.emoji} ${meta.displayName}**\n${meta.role}\n\nNew conversation started.`,
            color: '#57F287',
          })],
        });
        break;
      }

      // ── /model [opus|sonnet|haiku] ──────────────────────────────────
      case 'model': {
        const model = interaction.options.getString('model');
        const channelName = interaction.channel?.name || '';
        const agentId = sessions[sessionKey]?.agentId || resolveAgent(interaction.channelId, channelName);
        const session = getOrCreateSession(sessionKey, userId, agentId);
        session.model = model;
        saveSessions();

        await interaction.reply({
          embeds: [createEmbed({
            description: `✅ Model switched to **${model}**`,
            color: '#57F287',
          })],
        });
        break;
      }

      // ── /help ───────────────────────────────────────────────────────
      case 'help': {
        const agentList = [...agents.values()]
          .sort((a, b) => a.order - b.order)
          .map(a => `${a.emoji} **${a.id}** — ${a.role}`)
          .join('\n');

        await interaction.reply({
          embeds: [createEmbed({
            title: '❓ TamerClaw Multi-Agent Bot',
            description: [
              '**Commands:**',
              '`/chat [message] [agent]` — Send a message (optionally pick an agent)',
              '`/new` — Start a new conversation',
              '`/status` — Show bot status',
              '`/agent [name]` — Switch the agent for this channel',
              '`/model [opus|sonnet|haiku]` — Switch AI model',
              '`/stop` — Stop the current process',
              '`/setup-channels` — Create channel structure (admin)',
              '',
              '**How it works:**',
              'Each channel is mapped to a specific agent. Post in #cto to talk to the CTO, #flutter for Flutter help, etc. You can also just type in any channel and the bot will route to the right agent.',
              '',
              `**Available Agents (${agents.size}):**`,
              agentList,
            ].join('\n'),
          })],
        });
        break;
      }

      // ── /stop ───────────────────────────────────────────────────────
      case 'stop': {
        if (activeProcesses[sessionKey]) {
          try { activeProcesses[sessionKey].proc.kill('SIGTERM'); } catch {}
          delete activeProcesses[sessionKey];
          await interaction.reply({
            embeds: [createEmbed({ description: '✅ Process stopped.', color: '#57F287' })],
          });
        } else {
          await interaction.reply({ content: 'No active process to stop.', ephemeral: true });
        }
        break;
      }

      // ── /setup-channels ─────────────────────────────────────────────
      case 'setup-channels': {
        if (!interaction.guild) {
          await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
          return;
        }

        await interaction.deferReply();
        const result = await setupChannels(interaction.guild);

        const desc = [];
        if (result.created.length > 0) {
          desc.push(`**Created:** ${result.created.map(c => `#${c}`).join(', ')}`);
        }
        if (result.existing.length > 0) {
          desc.push(`**Already existed:** ${result.existing.map(c => `#${c}`).join(', ')}`);
        }
        if (result.created.length === 0 && result.existing.length === 0) {
          desc.push('No channels were created or found.');
        }

        await interaction.editReply({
          embeds: [createEmbed({
            title: '⚙️ Channel Setup Complete',
            description: desc.join('\n\n'),
            color: result.created.length > 0 ? '#57F287' : '#5865F2',
          })],
        });
        break;
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Command error (${commandName}):`, e.message);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ An error occurred processing your command.' });
      } else {
        await interaction.reply({ content: '❌ An error occurred processing your command.', ephemeral: true });
      }
    } catch {}
  }
});

// ── Message Handler (auto-respond in mapped channels + DMs) ──────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const isMapped = channelAgentMap[message.channelId] !== undefined;
  const isMentioned = message.mentions.has(client.user);

  // Only respond in: DMs, explicitly mapped channels, or when @mentioned
  if (!isDM && !isMapped && !isMentioned) return;

  const userId = message.author.id;

  // Rate limit check
  if (!checkRateLimit(userId)) return;

  const sessionKey = getSessionKey(message);
  let content = message.content;

  // Strip bot mention
  if (client.user) {
    content = content.replace(new RegExp(`<@!?${client.user.id}>`), '').trim();
  }

  if (!content) return;

  // Resolve which agent handles this channel
  const channelName = message.channel?.name || '';
  const agentId = resolveAgent(message.channelId, channelName);

  const replyFn = async (txt) => {
    return message.reply({ content: txt, allowedMentions: { repliedUser: false } });
  };
  const editFn = async (msg, txt) => {
    try { await msg.edit({ content: txt }); } catch {}
  };

  // Show typing indicator
  try { await message.channel.sendTyping(); } catch {}

  await runClaude(sessionKey, content, userId, agentId, replyFn, editFn);
});

// ── Client Ready ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  console.log('');
  console.log('=== TamerClaw Multi-Agent Discord Gateway ===');
  console.log(`  Bot:           ${readyClient.user.tag}`);
  console.log(`  Guilds:        ${readyClient.guilds.cache.size}`);
  console.log(`  Agents:        ${agents.size} (${[...agents.keys()].join(', ')})`);
  console.log(`  Default Agent: ${defaultAgentId}`);
  console.log(`  Default Model: ${defaultModel}`);
  console.log(`  Channel Maps:  ${Object.keys(channelAgentMap).length}`);
  console.log(`  Client ID:     ${clientId}`);
  console.log(`  Guild ID:      ${guildId || '(global)'}`);
  console.log(`  PID:           ${process.pid}`);
  console.log('');

  // Register slash commands
  await registerCommands();

  // Auto-discover channel mappings from channel names
  let autoMapped = 0;
  for (const [, guild] of readyClient.guilds.cache) {
    for (const [channelId, channel] of guild.channels.cache) {
      if (channel.type !== ChannelType.GuildText) continue;
      if (channelAgentMap[channelId]) continue; // already mapped

      const name = channel.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (agents.has(name)) {
        channelAgentMap[channelId] = name;
        autoMapped++;
      }
    }
  }

  if (autoMapped > 0) {
    console.log(`${LOG_PREFIX} Auto-mapped ${autoMapped} channels by name`);
    saveChannelMap();
  }

  // Health heartbeat
  const writeHealth = () => {
    try {
      fs.writeFileSync(HEALTH_FILE, JSON.stringify({
        platform: 'discord',
        mode: 'multi-agent',
        status: 'online',
        user: readyClient.user.tag,
        guilds: readyClient.guilds.cache.size,
        agents: [...agents.keys()],
        defaultAgent: defaultAgentId,
        channelMappings: Object.keys(channelAgentMap).length,
        uptime: Date.now() - startedAt,
        callCount,
        activeSessions: Object.keys(sessions).length,
        activeProcesses: Object.keys(activeProcesses).length,
        lastMessageAt: sessions[Object.keys(sessions).sort(
          (a, b) => (sessions[b]?.lastActive || 0) - (sessions[a]?.lastActive || 0)
        )[0]]?.lastActive || null,
        pid: process.pid,
        timestamp: new Date().toISOString(),
      }, null, 2));
    } catch {}
  };
  writeHealth();
  setInterval(writeHealth, HEALTH_INTERVAL_MS);

  console.log(`${LOG_PREFIX} Gateway ready. Total channel mappings: ${Object.keys(channelAgentMap).length}`);
});

// ── Error Handling ───────────────────────────────────────────────────────────

client.on('error', (e) => console.error(`${LOG_PREFIX} Client error:`, e.message));
client.on('warn', (w) => console.warn(`${LOG_PREFIX} Warning:`, w));

// ── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`${LOG_PREFIX} Shutting down (${signal})...`);

  // Kill all active Claude processes
  for (const [key, entry] of Object.entries(activeProcesses)) {
    try { entry.proc.kill('SIGTERM'); } catch {}
    delete activeProcesses[key];
  }

  // Persist state
  saveSessions();
  saveChannelMap();

  // Write final health
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({
      platform: 'discord',
      mode: 'multi-agent',
      status: 'offline',
      uptime: Date.now() - startedAt,
      callCount,
      pid: process.pid,
      stoppedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    }, null, 2));
  } catch {}

  // Destroy Discord client
  try { client.destroy(); } catch {}

  releaseLock();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  console.error(`${LOG_PREFIX} Uncaught exception:`, e.message);
  console.error(e.stack);
  // Don't crash on uncaught exceptions in production
});
process.on('unhandledRejection', (reason) => {
  console.error(`${LOG_PREFIX} Unhandled rejection:`, reason);
});

// ── Export for bot.js integration ────────────────────────────────────────────

/**
 * Start the multi-agent bot. Called by bot.js when multi-agent mode is detected.
 * Also supports standalone execution (node multi-agent-bot.js).
 *
 * @param {object} [opts] - Options (token, clientId, guildId, config)
 *   If omitted, reads from user/config.json / env vars (already loaded above).
 */
export async function startMultiAgentBot(opts = {}) {
  if (!validateConfig()) {
    throw new Error('Discord configuration is incomplete. Run: ./tamerclaw discord setup');
  }
  acquireLock();
  return client.login(token);
}

// ── Auto-Start (standalone mode) ────────────────────────────────────────────

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  if (!validateConfig()) process.exit(1);
  acquireLock();
  client.login(token).catch((e) => {
    console.error(`${LOG_PREFIX} Login failed:`, e.message);
    process.exit(1);
  });
}
