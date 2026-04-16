#!/usr/bin/env node
/**
 * TamerClaw Discord Channel Setup
 *
 * Reads agent definitions from core/powerup/agency.json,
 * checks which agents are installed in user/agents/,
 * and creates the full Discord server channel structure.
 *
 * Saves the channel-to-agent mapping at user/discord-channels.json.
 *
 * Usage:
 *   node core/discord/setup-channels.js
 *
 * Or import programmatically:
 *   import { setupChannels } from './setup-channels.js';
 *   await setupChannels();
 */

import fs from 'fs';
import path from 'path';
import paths from '../shared/paths.js';

// ── Channel Structure Definition ────────────────────────────────────────────

/**
 * Build the desired channel structure from agency.json + installed agents.
 *
 * Static categories (COMMAND CENTER, SYSTEM) are always present when they
 * have at least one relevant agent/channel.  Team categories (ENGINEERING,
 * MARKETING) only appear when at least one team member is installed.
 */
function buildChannelStructure(agencyData, installedAgents) {
  const agentMap = Object.fromEntries(
    agencyData.agents.map((a) => [a.id, a]),
  );

  // Supreme is the default agent — always considered "installed"
  const installed = new Set([...installedAgents, 'supreme']);

  const categories = [];

  // ── COMMAND CENTER ──────────────────────────────────────────────────────
  categories.push({
    name: 'COMMAND CENTER',
    emoji: '🏢',
    channels: [
      {
        name: 'command-center',
        agent: 'supreme',
        topic: '🏢 Supreme command center — talk to the agency lead',
      },
      {
        name: 'announcements',
        agent: null,
        topic: '📢 System announcements and updates',
        readOnly: true,
      },
      {
        name: 'general',
        agent: 'supreme',
        topic: '💬 General discussion — routed to Supreme',
      },
    ],
    // Always show command center if supreme is available
    alwaysShow: true,
  });

  // ── Team categories (from agency.json) ─────────────────────────────────
  const teamEmoji = {
    engineering: '💻',
    marketing: '📣',
  };

  for (const [teamId, team] of Object.entries(agencyData.teams)) {
    const teamChannels = [];
    for (const memberId of team.members) {
      if (!installed.has(memberId)) continue;
      const agentDef = agentMap[memberId];
      if (!agentDef) continue;
      teamChannels.push({
        name: memberId,
        agent: memberId,
        topic: `${agentDef.emoji} ${agentDef.role}`,
      });
    }
    if (teamChannels.length === 0) continue;

    categories.push({
      name: team.name.toUpperCase(),
      emoji: teamEmoji[teamId] || '📁',
      channels: teamChannels,
    });
  }

  // ── SYSTEM ─────────────────────────────────────────────────────────────
  categories.push({
    name: 'SYSTEM',
    emoji: '⚙️',
    channels: [
      {
        name: 'logs',
        agent: null,
        topic: '📋 System logs and diagnostics',
      },
      {
        name: 'settings',
        agent: null,
        topic: '🔧 Configuration and settings',
      },
    ],
    alwaysShow: true,
  });

  return categories;
}

// ── Discord Operations ──────────────────────────────────────────────────────

/**
 * Create (or reuse) a category channel in the guild.
 * Returns the CategoryChannel object.
 */
async function ensureCategory(guild, name, emoji, existingChannels) {
  const displayName = `${emoji} ${name}`;

  // Check for existing category by name (with or without emoji prefix)
  const existing = existingChannels.find(
    (ch) =>
      ch.type === 4 && // ChannelType.GuildCategory
      (ch.name === displayName || ch.name === name),
  );
  if (existing) {
    console.log(`  ✓ Category "${displayName}" already exists`);
    return existing;
  }

  console.log(`  + Creating category "${displayName}"`);
  const category = await guild.channels.create({
    name: displayName,
    type: 4, // ChannelType.GuildCategory
  });
  return category;
}

/**
 * Create (or reuse) a text channel inside a category.
 * Returns the TextChannel object.
 */
async function ensureTextChannel(guild, category, channelDef, existingChannels) {
  const { name, topic, readOnly } = channelDef;

  // Check for existing channel with this name under the same category
  const existing = existingChannels.find(
    (ch) =>
      ch.type === 0 && // ChannelType.GuildText
      ch.name === name &&
      ch.parentId === category.id,
  );
  if (existing) {
    console.log(`    ✓ #${name} already exists`);
    return existing;
  }

  // Also check for the channel name anywhere in the guild (not under this category)
  const existingElsewhere = existingChannels.find(
    (ch) => ch.type === 0 && ch.name === name,
  );
  if (existingElsewhere) {
    console.log(`    ✓ #${name} exists (moving to ${category.name})`);
    await existingElsewhere.setParent(category.id);
    if (topic && existingElsewhere.topic !== topic) {
      await existingElsewhere.setTopic(topic);
    }
    return existingElsewhere;
  }

  console.log(`    + Creating #${name}`);
  const options = {
    name,
    type: 0, // ChannelType.GuildText
    parent: category.id,
    topic: topic || undefined,
  };

  // For read-only channels, deny SEND_MESSAGES for @everyone
  if (readOnly) {
    options.permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: ['SendMessages'],
      },
    ];
  }

  const channel = await guild.channels.create(options);
  return channel;
}

// ── Main Setup Function ─────────────────────────────────────────────────────

/**
 * Run the full channel setup.
 *
 * @param {object} [opts]
 * @param {string} [opts.token]    Discord bot token (reads config.json if omitted)
 * @param {string} [opts.clientId] Discord client ID (reads config.json if omitted)
 * @param {string} [opts.guildId]  Discord guild ID (reads config.json if omitted)
 * @param {boolean} [opts.destroyAfter=true] Whether to destroy the client when done
 * @returns {Promise<object>} The saved channel mapping
 */
export async function setupChannels(opts = {}) {
  // ── Load config ──────────────────────────────────────────────────────
  let config = {};
  try {
    if (fs.existsSync(paths.config)) {
      config = JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
    }
  } catch (e) {
    console.error('[setup-channels] Failed to load config:', e.message);
  }

  const discordConfig = config.discord || {};

  const token =
    opts.token ||
    process.env.TAMERCLAW_DISCORD_TOKEN ||
    discordConfig.token ||
    '';
  const clientId =
    opts.clientId ||
    process.env.TAMERCLAW_DISCORD_CLIENT_ID ||
    discordConfig.clientId ||
    '';
  const guildId =
    opts.guildId ||
    process.env.TAMERCLAW_DISCORD_GUILD_ID ||
    discordConfig.guildId ||
    '';

  if (!token) {
    throw new Error(
      'Discord bot token not configured. Run: ./tamerclaw discord setup',
    );
  }
  if (!clientId) {
    throw new Error(
      'Discord client ID not configured. Run: ./tamerclaw discord setup',
    );
  }
  if (!guildId) {
    throw new Error(
      'Discord guild ID not configured. Set discord.guildId in user/config.json',
    );
  }

  // ── Load agency definitions ──────────────────────────────────────────
  const agencyPath = path.join(paths.core, 'powerup', 'agency.json');
  let agencyData;
  try {
    agencyData = JSON.parse(fs.readFileSync(agencyPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to load agency.json: ${e.message}`);
  }

  // ── Scan installed agents ────────────────────────────────────────────
  let installedAgents = [];
  try {
    if (fs.existsSync(paths.agents)) {
      installedAgents = fs
        .readdirSync(paths.agents)
        .filter((entry) => {
          const full = path.join(paths.agents, entry);
          return fs.statSync(full).isDirectory();
        });
    }
  } catch (e) {
    console.warn('[setup-channels] Could not read user/agents/:', e.message);
  }

  console.log('');
  console.log('=== TamerClaw Discord Channel Setup ===');
  console.log(`  Guild ID:         ${guildId}`);
  console.log(`  Installed agents: ${installedAgents.length > 0 ? installedAgents.join(', ') : '(none)'}`);
  console.log('');

  // ── Build desired structure ──────────────────────────────────────────
  const structure = buildChannelStructure(agencyData, installedAgents);

  // ── Connect to Discord ───────────────────────────────────────────────
  const { Client, GatewayIntentBits } = await import('discord.js');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const destroyAfter = opts.destroyAfter !== false;

  try {
    await client.login(token);

    // Wait for the client to be ready
    await new Promise((resolve, reject) => {
      if (client.isReady()) return resolve();
      client.once('ready', resolve);
      client.once('error', reject);
      setTimeout(() => reject(new Error('Discord client did not become ready within 30s')), 30000);
    });

    console.log(`[setup-channels] Connected as ${client.user.tag}`);
    console.log('');

    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} not found. Is the bot invited to this server?`);
    }

    // Fetch all existing channels once
    const existingChannels = await guild.channels.fetch();
    const channelArray = [...existingChannels.values()].filter(Boolean);

    // ── Create channels ──────────────────────────────────────────────
    const result = {
      channels: {},
      categories: {},
      createdAt: new Date().toISOString(),
      guildId,
    };

    for (const catDef of structure) {
      console.log(`Creating category "${catDef.emoji} ${catDef.name}"...`);

      const category = await ensureCategory(
        guild,
        catDef.name,
        catDef.emoji,
        channelArray,
      );
      result.categories[category.id] = catDef.name;

      for (const chDef of catDef.channels) {
        const channel = await ensureTextChannel(
          guild,
          category,
          chDef,
          channelArray,
        );
        result.channels[channel.id] = {
          name: chDef.name,
          agent: chDef.agent,
        };

        // Add to local array so subsequent duplicate checks work
        if (!channelArray.find((c) => c.id === channel.id)) {
          channelArray.push(channel);
        }
      }

      console.log('');
    }

    // ── Save mapping ─────────────────────────────────────────────────
    const outputPath = path.join(paths.user, 'discord-channels.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`[setup-channels] Channel mapping saved to ${outputPath}`);

    // ── Summary ──────────────────────────────────────────────────────
    const channelCount = Object.keys(result.channels).length;
    const categoryCount = Object.keys(result.categories).length;
    console.log(
      `[setup-channels] Done — ${categoryCount} categories, ${channelCount} channels`,
    );
    console.log('');

    return result;
  } finally {
    if (destroyAfter) {
      client.destroy();
    }
  }
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  setupChannels()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('');
      console.error('[setup-channels] FATAL:', err.message);
      if (err.code === 'TOKEN_INVALID') {
        console.error('  The Discord token is invalid. Regenerate it at:');
        console.error('  https://discord.com/developers/applications');
      }
      process.exit(1);
    });
}
