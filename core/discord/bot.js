#!/usr/bin/env node
/**
 * TamerClaw Discord Bot — Supreme Agent on Discord
 *
 * Entry point for the Discord bot. Reads config from user/config.json,
 * loads the Supreme agent identity, and starts the Discord bot using
 * the shared discord-bot-template.
 *
 * Usage:
 *   node core/discord/bot.js
 *
 * Environment:
 *   TAMERCLAW_DISCORD_TOKEN    — Discord bot token (overrides config.json)
 *   TAMERCLAW_DISCORD_CLIENT_ID — Discord application client ID
 *   TAMERCLAW_DISCORD_GUILD_ID  — Optional guild ID for instant command registration
 *   TAMERCLAW_HOME              — TamerClaw install directory
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import paths from '../shared/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Singleton Guard ──────────────────────────────────────────────────────────

const LOCK_FILE = path.join(paths.user, 'discord-bot.lock');

function acquireLock() {
  const pid = process.pid;
  // Check if another instance is running
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== pid) {
        try {
          process.kill(oldPid, 0); // Check if process exists
          console.log(`[discord] Another instance running (PID ${oldPid}). Killing it.`);
          process.kill(oldPid, 'SIGTERM');
          // Wait briefly for old process to die
          const start = Date.now();
          while (Date.now() - start < 3000) {
            try { process.kill(oldPid, 0); } catch { break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        } catch {
          // Process already dead — clean
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
      if (lockPid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
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
  console.error('[discord] Failed to load config:', e.message);
}

const discordConfig = config.discord || {};
const agentId = discordConfig.agentId || 'supreme';

// Token sources: env var > config.json > discord-config.json in agent dir
const token = process.env.TAMERCLAW_DISCORD_TOKEN
  || discordConfig.token
  || '';

const clientId = process.env.TAMERCLAW_DISCORD_CLIENT_ID
  || discordConfig.clientId
  || '';

const guildId = process.env.TAMERCLAW_DISCORD_GUILD_ID
  || discordConfig.guildId
  || null;

if (!token) {
  console.error('FATAL: Discord bot token not configured.');
  console.error('');
  console.error('Run: ./tamerclaw discord setup');
  console.error('');
  console.error('Or set TAMERCLAW_DISCORD_TOKEN environment variable.');
  console.error('');
  console.error('To get a token:');
  console.error('  1. Go to https://discord.com/developers/applications');
  console.error('  2. Create a new application');
  console.error('  3. Bot tab -> Copy token');
  console.error('  4. Enable MESSAGE CONTENT INTENT + SERVER MEMBERS INTENT');
  console.error('  5. OAuth2 -> URL Generator -> scopes: bot, applications.commands');
  console.error('  6. Permissions: Send Messages, Embed Links, Read Message History,');
  console.error('     Attach Files, Use Slash Commands, Read Messages/View Channels,');
  console.error('     Add Reactions, Create Public Threads');
  console.error('  7. Add bot to your server with the generated URL');
  process.exit(1);
}

if (!clientId) {
  console.error('FATAL: Discord client ID not configured.');
  console.error('');
  console.error('Run: ./tamerclaw discord setup');
  console.error('Or set TAMERCLAW_DISCORD_CLIENT_ID environment variable.');
  process.exit(1);
}

// ── Agent Directory Setup ────────────────────────────────────────────────────

const agentDir = paths.agentDir(agentId);

// Ensure agent directory structure
for (const dir of [
  agentDir,
  path.join(agentDir, 'workspace'),
  path.join(agentDir, 'media'),
  path.join(agentDir, 'memory'),
  path.join(agentDir, 'sessions'),
]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Start Bot ────────────────────────────────────────────────────────────────

acquireLock();

console.log('');
console.log('=== TamerClaw Discord Bot ===');
console.log(`  Agent:     ${agentId}`);
console.log(`  Client ID: ${clientId}`);
console.log(`  Guild ID:  ${guildId || '(global)'}`);
console.log(`  Agent Dir: ${agentDir}`);
console.log(`  CWD:       ${paths.home}`);
console.log(`  PID:       ${process.pid}`);
console.log('');

// Dynamic import of discord-bot-template (after discord.js is installed)
let createDiscordBot;
try {
  const mod = await import('../shared/discord-bot-template.js');
  createDiscordBot = mod.createDiscordBot || mod.default;
} catch (e) {
  console.error('FATAL: Failed to import discord-bot-template:', e.message);
  console.error('');
  console.error('Make sure discord.js is installed:');
  console.error('  cd core/discord && npm install');
  process.exit(1);
}

// Allowlist — reuse supreme's allowlist if available
let allowedUsers = discordConfig.allowedUsers || [];
if (allowedUsers.length === 0) {
  // Load from allowlist file if exists
  const allowlistFile = path.join(paths.credentials, 'discord-allowFrom.json');
  try {
    if (fs.existsSync(allowlistFile)) {
      allowedUsers = JSON.parse(fs.readFileSync(allowlistFile, 'utf-8'));
    }
  } catch {}
}

const bot = createDiscordBot({
  agentId,
  agentDir,
  token,
  clientId,
  guildId,
  cwd: paths.home,
  defaultModel: discordConfig.defaultModel || config.defaultModel || 'sonnet',
  maxTurns: discordConfig.maxTurns || 200,
  respondInDMs: discordConfig.respondInDMs !== false,
  respondInThreads: discordConfig.respondInThreads !== false,
  respondInAllGuildChannels: discordConfig.respondInAllGuildChannels || false,
  embedColor: discordConfig.embedColor || '#5865F2',
  allowedUsers,
  allowedChannels: discordConfig.allowedChannels || [],
  systemPromptFiles: ['IDENTITY.md', 'MEMORY.md', 'USER.md', 'TOOLS.md'],
});

// Log that we're live
console.log('[discord] Bot initialization complete. Waiting for Discord ready event...');
