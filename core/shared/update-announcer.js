/**
 * update-announcer.js — Post-Update Announcement System for TamerClaw
 *
 * After `./tamerclaw update`, Supreme Agent restarts and finds
 * `update-notify.json` in the agent's runtime directory. This module:
 *   1. Reads the notification file
 *   2. Generates a rich, human-friendly "What's New" message
 *   3. Includes new commands, features, and tips
 *   4. Sends it proactively on first user interaction
 *   5. Cleans up the notification file
 *
 * Also provides `/changelog` and `/whatsnew` commands.
 *
 * Usage:
 *   import { UpdateAnnouncer } from '../shared/update-announcer.js';
 *   const announcer = new UpdateAnnouncer(agentDir);
 *   // On startup:
 *   const pending = announcer.checkPendingUpdate();
 *   // On first message:
 *   if (announcer.hasPendingAnnouncement()) {
 *     bot.sendMessage(chatId, announcer.getAnnouncement(), { parse_mode: 'Markdown' });
 *     announcer.markAnnounced();
 *   }
 */

import fs from 'fs';
import path from 'path';

// ── Feature Knowledge Base ──────────────────────────────────────────────────
// Maps version features to user-facing commands and explanations.
// This gets enriched with each release.

const FEATURE_DB = {
  // Module name → user-facing info
  'dream-feature.js': {
    command: '/dream',
    summary: 'Capture ideas now, plan & execute later',
    usage: [
      '/dream of <your idea> — Save a dream',
      '/dream list — See all your dreams',
      '/dream plan <id> — Convert to executable plan',
      '/dream execute <id> — Run the plan',
    ],
  },
  'auto-dream.js': {
    summary: 'Dreams auto-capture from conversations when enabled',
  },
  'mini-meeting.js': {
    command: '/meeting',
    summary: 'Quick alignment meetings between agents',
    usage: [
      '/meeting <agent> <topic> — Start a meeting with an agent',
    ],
  },
  'smart-memory.js': {
    command: '/memory',
    summary: 'Long-term memory that persists across sessions',
    usage: [
      '/memory — Show recent memory',
      '/memory search <query> — Search memory',
    ],
  },
  'delegation-router.js': {
    summary: 'CTO can delegate tasks to team members automatically',
  },
  'task-registry.js': {
    summary: 'Central task tracking across all agents',
  },
  'team-discovery.js': {
    summary: 'Agents can discover and collaborate with teammates',
  },
  'coordinator.js': {
    summary: 'Multi-agent coordination for complex tasks',
  },
  'gui-access.js': {
    summary: 'Remote GUI control of Mac Mini (screenshots, clicks, typing)',
  },
  'compute-router.js': {
    summary: 'Offload heavy tasks (voice, image, ML) to Mac Mini',
  },
  'compaction.js': {
    command: '/compact',
    summary: 'Compress conversation history to save tokens',
    usage: ['/compact — Compress current session history'],
  },
  'store.js': {
    summary: 'Mobile app store publishing pipeline (iOS/Android)',
  },
  'magic-docs.js': {
    summary: 'Auto-generate documentation from code',
  },
  'account-ratelimit.js': {
    summary: 'Smart rate limit detection and account switching',
  },
  'loop-guard.js': {
    summary: 'Prevents infinite loops in agent processing',
  },
};

// ── Commands that all agents share (from command-registry.js + skills.js) ──
const ALL_COMMANDS = [
  { cmd: '/help', desc: 'Show all available commands' },
  { cmd: '/status', desc: 'System status (uptime, memory, agents)' },
  { cmd: '/agents', desc: 'List all managed agents' },
  { cmd: '/model <name>', desc: 'Switch AI model (opus/sonnet/haiku)' },
  { cmd: '/new', desc: 'Start fresh conversation' },
  { cmd: '/sessions', desc: 'List recent conversations' },
  { cmd: '/resume <n>', desc: 'Resume a previous session' },
  { cmd: '/voice', desc: 'Toggle voice response mode' },
  { cmd: '/compact', desc: 'Compress conversation history' },
  { cmd: '/memory', desc: 'View/search long-term memory' },
  { cmd: '/dream of <idea>', desc: 'Capture an idea for later' },
  { cmd: '/dream list', desc: 'See all captured dreams' },
  { cmd: '/meeting <agent> <topic>', desc: 'Start a meeting with an agent' },
  { cmd: '/tools', desc: 'List available tools' },
  { cmd: '/stuck', desc: 'Diagnose when agent seems stuck' },
  { cmd: '/recap', desc: 'Summarize current session' },
  { cmd: '/handoff <agent>', desc: 'Hand off work to another agent' },
  { cmd: '/diagnose', desc: 'Run system diagnostics' },
  { cmd: '/checkpoint <name>', desc: 'Save current state' },
  { cmd: '/stop', desc: 'Stop current task' },
];

// Team leader only commands
const LEADER_COMMANDS = [
  { cmd: '/team status', desc: 'Show all team members status' },
  { cmd: '/team assign <member> <task>', desc: 'Delegate task to team member' },
  { cmd: '/team meeting <topic>', desc: 'Start a team meeting' },
  { cmd: '/team review', desc: 'Get team progress report' },
  { cmd: '/team members', desc: 'List team members' },
];

// Supreme-only commands
const SUPREME_COMMANDS = [
  { cmd: '/account', desc: 'Show current Claude account' },
  { cmd: '/switch <account>', desc: 'Switch Claude account' },
  { cmd: '/usage', desc: 'Token usage & rate limits' },
  { cmd: '/changelog', desc: 'Show version history' },
  { cmd: '/whatsnew', desc: 'Show what changed in latest update' },
];

// ── Update Announcer Class ──────────────────────────────────────────────────

export class UpdateAnnouncer {
  /**
   * @param {string} agentDir - Runtime agent directory (e.g. user/agents/supreme/)
   * @param {string} [homeDir] - TamerClaw home directory (for version.json)
   */
  constructor(agentDir, homeDir) {
    this.agentDir = agentDir;
    this.homeDir = homeDir || path.resolve(agentDir, '..', '..', '..');
    this.notifyFile = path.join(agentDir, 'update-notify.json');
    this._pending = null;
    this._announced = false;
  }

  /**
   * Check for a pending update notification.
   * Call this on startup.
   * @returns {object|null} The notification data, or null
   */
  checkPendingUpdate() {
    try {
      if (fs.existsSync(this.notifyFile)) {
        const data = JSON.parse(fs.readFileSync(this.notifyFile, 'utf-8'));
        if (data.newVersion && data.oldVersion) {
          this._pending = data;
          this._announced = false;
          console.log(`[update-announcer] Pending update: v${data.oldVersion} → v${data.newVersion}`);
          return data;
        }
      }
    } catch (err) {
      console.error('[update-announcer] Error reading notification:', err.message);
    }
    return null;
  }

  /**
   * Whether there's an unannounced update.
   */
  hasPendingAnnouncement() {
    return this._pending !== null && !this._announced;
  }

  /**
   * Generate the announcement message.
   * @returns {string} Telegram-formatted message (Markdown)
   */
  getAnnouncement() {
    if (!this._pending) return '';
    return this._buildAnnouncementMessage(this._pending);
  }

  /**
   * Mark the announcement as sent and clean up the file.
   */
  markAnnounced() {
    this._announced = true;
    try {
      // Archive the notification (don't just delete — useful for /whatsnew)
      const archiveDir = path.join(this.agentDir, 'update-history');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

      const archiveFile = path.join(archiveDir, `${this._pending.newVersion}.json`);
      fs.writeFileSync(archiveFile, JSON.stringify({
        ...this._pending,
        announcedAt: new Date().toISOString(),
      }, null, 2));

      // Remove the trigger file
      if (fs.existsSync(this.notifyFile)) {
        fs.unlinkSync(this.notifyFile);
      }
      console.log('[update-announcer] Announcement delivered and archived');
    } catch (err) {
      console.error('[update-announcer] Error cleaning up:', err.message);
    }
  }

  /**
   * Get the current version info from version.json.
   * @returns {object|null}
   */
  getVersionInfo() {
    try {
      const versionFile = path.join(this.homeDir, 'version.json');
      if (fs.existsSync(versionFile)) {
        return JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
      }
    } catch {}
    return null;
  }

  /**
   * Generate changelog message (for /changelog command).
   * @param {number} [limit=5] - How many versions to show
   * @returns {string}
   */
  getChangelog(limit = 5) {
    const version = this.getVersionInfo();
    if (!version) return 'Version info unavailable.';

    const lines = [
      `📋 *TamerClaw Changelog*\n`,
      `*v${version.version}* "${version.codename}" — ${version.releasedAt}`,
      version.changelog,
      '',
    ];

    // Add history
    if (version.history && version.history.length > 0) {
      for (const entry of version.history.slice(0, limit - 1)) {
        lines.push(`*v${entry.version}* "${entry.codename}" — ${entry.releasedAt}`);
        lines.push(entry.changelog);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate "what's new" message (for /whatsnew command).
   * Shows latest version features and commands.
   * @returns {string}
   */
  getWhatsNew() {
    const version = this.getVersionInfo();
    if (!version) return 'Version info unavailable.';

    return this._buildWhatsNewMessage(version);
  }

  // ── Private Methods ─────────────────────────────────────────────────────

  /**
   * Build the rich announcement message sent after update.
   */
  _buildAnnouncementMessage(notify) {
    const version = this.getVersionInfo();
    const lines = [];

    // Header
    lines.push(`🚀 *TamerClaw Updated!*`);
    lines.push(`v${notify.oldVersion} → *v${notify.newVersion}*${version?.codename ? ` "${version.codename}"` : ''}\n`);

    // Changelog summary
    if (version?.changelog) {
      lines.push(`📝 *What changed:*`);
      lines.push(version.changelog);
      lines.push('');
    }

    // New modules → user-facing features
    if (version?.modules?.new?.length > 0) {
      const features = this._extractFeatures(version.modules.new);
      if (features.length > 0) {
        lines.push('✨ *New features:*');
        for (const feat of features) {
          if (feat.command) {
            lines.push(`• \`${feat.command}\` — ${feat.summary}`);
          } else {
            lines.push(`• ${feat.summary}`);
          }
        }
        lines.push('');
      }
    }

    // New commands to learn
    const newCommands = this._extractNewCommands(version?.modules?.new || []);
    if (newCommands.length > 0) {
      lines.push('🎯 *New commands to try:*');
      for (const cmd of newCommands) {
        lines.push(`• \`${cmd.usage[0]}\``);
        if (cmd.usage.length > 1) {
          for (const u of cmd.usage.slice(1)) {
            lines.push(`  \`${u}\``);
          }
        }
      }
      lines.push('');
    }

    // Commits (abbreviated)
    if (notify.commits?.length > 0) {
      lines.push('📌 *Recent commits:*');
      for (const commit of notify.commits.slice(0, 5)) {
        lines.push(`• ${commit}`);
      }
      if (notify.commits.length > 5) {
        lines.push(`  _...and ${notify.commits.length - 5} more_`);
      }
      lines.push('');
    }

    // Tip
    lines.push('💡 Run /changelog for full version history');
    lines.push('Run /whatsnew anytime to see this again');

    return lines.join('\n');
  }

  /**
   * Build the /whatsnew response (can be called anytime).
   */
  _buildWhatsNewMessage(version) {
    const lines = [];

    lines.push(`🆕 *What's New in v${version.version}* "${version.codename}"\n`);
    lines.push(version.changelog);
    lines.push('');

    // Features with commands
    if (version.modules?.new?.length > 0) {
      const features = this._extractFeatures(version.modules.new);
      if (features.length > 0) {
        lines.push('*Features:*');
        for (const feat of features) {
          if (feat.command) {
            lines.push(`• \`${feat.command}\` — ${feat.summary}`);
          } else {
            lines.push(`• ${feat.summary}`);
          }
        }
        lines.push('');
      }
    }

    // All available commands cheat sheet
    lines.push('📋 *All available commands:*');
    lines.push('');
    lines.push('_General:_');
    for (const c of ALL_COMMANDS.slice(0, 12)) {
      lines.push(`• \`${c.cmd}\` — ${c.desc}`);
    }
    lines.push('');
    lines.push('_Productivity:_');
    for (const c of ALL_COMMANDS.slice(12)) {
      lines.push(`• \`${c.cmd}\` — ${c.desc}`);
    }
    lines.push('');
    lines.push('_Supreme-only:_');
    for (const c of SUPREME_COMMANDS) {
      lines.push(`• \`${c.cmd}\` — ${c.desc}`);
    }
    lines.push('');
    lines.push('_Team leaders:_');
    for (const c of LEADER_COMMANDS) {
      lines.push(`• \`${c.cmd}\` — ${c.desc}`);
    }

    return lines.join('\n');
  }

  /**
   * Extract user-facing features from module file names.
   */
  _extractFeatures(moduleNames) {
    const features = [];
    for (const mod of moduleNames) {
      const basename = path.basename(mod);
      if (FEATURE_DB[basename]) {
        features.push(FEATURE_DB[basename]);
      }
    }
    return features;
  }

  /**
   * Extract new commands from modules that have usage instructions.
   */
  _extractNewCommands(moduleNames) {
    const commands = [];
    for (const mod of moduleNames) {
      const basename = path.basename(mod);
      const feat = FEATURE_DB[basename];
      if (feat?.usage) {
        commands.push(feat);
      }
    }
    return commands;
  }
}

// ── Standalone helper for non-Supreme agents (bot-template integration) ────

/**
 * Create an announcer for any agent.
 * @param {string} agentId
 * @returns {Promise<UpdateAnnouncer>}
 */
export async function createAnnouncer(agentId) {
  // Import paths dynamically to avoid circular deps
  let agentDir, homeDir;
  try {
    const pathsMod = await import('./paths.js');
    agentDir = pathsMod.default.agentDir(agentId);
    homeDir = pathsMod.default.home;
  } catch {
    // Fallback
    agentDir = path.join(process.env.TAMERCLAW_HOME || '/root/tamerclaw', 'user', 'agents', agentId);
    homeDir = process.env.TAMERCLAW_HOME || '/root/tamerclaw';
  }
  return new UpdateAnnouncer(agentDir, homeDir);
}

export default UpdateAnnouncer;
