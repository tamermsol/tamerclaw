/**
 * command-registry.js — Slash Command Registry for TamerClaw
 *
 * Inspired by Claude Code's commands.ts + commands/ architecture.
 * Replaces if/else chains with a proper command framework supporting:
 *   - Command types: local (immediate), prompt (expand to text), remote-safe
 *   - Availability requirements (admin-only, bridge-safe, etc.)
 *   - Argument parsing
 *   - Help text generation
 *   - Plugin/skill command loading
 *
 * Usage:
 *   import { CommandRegistry, registerBuiltins } from '../shared/command-registry.js';
 *
 *   const cmds = new CommandRegistry();
 *   registerBuiltins(cmds);
 *   cmds.register({
 *     name: 'deploy',
 *     description: 'Deploy to production',
 *     type: 'local',
 *     handler: async (ctx) => { ... }
 *   });
 *
 *   const result = await cmds.execute('/deploy staging', ctx);
 */

// ── Command Types ────────────────────────────────────────────────────────
export const COMMAND_TYPES = {
  LOCAL: 'local',       // Immediate local action (no LLM involved)
  PROMPT: 'prompt',     // Expands to text sent to the model (skills)
  HYBRID: 'hybrid',     // Runs local logic then optionally sends to LLM
};

// ── Command Definition ───────────────────────────────────────────────────
/**
 * @typedef {object} CommandDef
 * @property {string} name           - Command name without slash (e.g. 'start')
 * @property {string[]} [aliases]    - Alternative names
 * @property {string} description    - One-line description
 * @property {string} [help]         - Extended help text
 * @property {string} type           - Command type from COMMAND_TYPES
 * @property {boolean} [adminOnly]   - Requires admin user
 * @property {boolean} [bridgeSafe]  - Safe to execute from remote bridge
 * @property {boolean} [hidden]      - Don't show in help
 * @property {string} [usage]        - Usage pattern (e.g. '/model <name>')
 * @property {Function} handler      - async (ctx) => result
 * @property {Function} [validate]   - (args) => boolean
 * @property {string} [source]       - 'builtin', 'plugin', 'skill', 'custom'
 */

// ── Command Context ──────────────────────────────────────────────────────
/**
 * @typedef {object} CommandContext
 * @property {string} agentId      - Agent executing the command
 * @property {string} chatId       - Telegram chat ID
 * @property {object} bot          - Telegram bot instance
 * @property {object} config       - Current config
 * @property {string} rawText      - Full original message text
 * @property {string[]} args       - Parsed arguments
 * @property {string} argString    - Everything after the command name
 * @property {object} session      - Current session state
 * @property {object} [metadata]   - Additional context
 */

// ── Registry ─────────────────────────────────────────────────────────────
export class CommandRegistry {
  constructor() {
    /** @type {Map<string, CommandDef>} */
    this._commands = new Map();
    /** @type {Map<string, string>} aliasName → commandName */
    this._aliases = new Map();
    /** @type {Function[]} */
    this._middleware = [];
  }

  /**
   * Register a command.
   * @param {CommandDef} def
   */
  register(def) {
    if (!def.name) throw new Error('Command must have a name');
    if (!def.handler) throw new Error(`Command '${def.name}' must have a handler`);

    const cmd = {
      name: def.name.toLowerCase().replace(/^\//, ''),
      aliases: (def.aliases || []).map(a => a.toLowerCase().replace(/^\//, '')),
      description: def.description || '',
      help: def.help || '',
      type: def.type || COMMAND_TYPES.LOCAL,
      adminOnly: def.adminOnly ?? false,
      bridgeSafe: def.bridgeSafe ?? true,
      hidden: def.hidden ?? false,
      usage: def.usage || `/${def.name}`,
      handler: def.handler,
      validate: def.validate || (() => true),
      source: def.source || 'custom',
    };

    this._commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases) {
      this._aliases.set(alias, cmd.name);
    }
  }

  /**
   * Unregister a command.
   * @param {string} name
   */
  unregister(name) {
    const cmd = this._commands.get(name);
    if (cmd) {
      for (const alias of cmd.aliases) {
        this._aliases.delete(alias);
      }
      this._commands.delete(name);
    }
  }

  /**
   * Add middleware that runs before every command.
   * @param {Function} fn - async (ctx, next) => result
   */
  use(fn) {
    this._middleware.push(fn);
  }

  /**
   * Check if text is a command.
   * @param {string} text
   * @returns {boolean}
   */
  isCommand(text) {
    if (!text || !text.startsWith('/')) return false;
    const name = text.split(/\s+/)[0].slice(1).toLowerCase();
    return this._commands.has(name) || this._aliases.has(name);
  }

  /**
   * Parse a command string into parts.
   * @param {string} text
   * @returns {{ name: string, args: string[], argString: string } | null}
   */
  parse(text) {
    if (!text || !text.startsWith('/')) return null;
    const parts = text.trim().split(/\s+/);
    const rawName = parts[0].slice(1).toLowerCase();
    const name = this._aliases.get(rawName) || rawName;

    if (!this._commands.has(name)) return null;

    const args = parts.slice(1);
    const argString = text.slice(parts[0].length).trim();

    return { name, args, argString };
  }

  /**
   * Execute a command.
   * @param {string} text     - Full message text (e.g. '/model opus')
   * @param {object} ctx      - Command context
   * @returns {Promise<{ handled: boolean, result?: any, error?: string }>}
   */
  async execute(text, ctx) {
    const parsed = this.parse(text);
    if (!parsed) return { handled: false };

    const cmd = this._commands.get(parsed.name);
    if (!cmd) return { handled: false };

    // Build full context
    const fullCtx = {
      ...ctx,
      command: cmd,
      args: parsed.args,
      argString: parsed.argString,
      rawText: text,
    };

    // Run validation
    if (!cmd.validate(parsed.args)) {
      return {
        handled: true,
        error: `Invalid usage. Expected: ${cmd.usage}`,
      };
    }

    // Run middleware chain
    try {
      for (const mw of this._middleware) {
        const shouldContinue = await mw(fullCtx);
        if (shouldContinue === false) {
          return { handled: true, result: 'Blocked by middleware' };
        }
      }

      const result = await cmd.handler(fullCtx);
      return { handled: true, result };
    } catch (err) {
      return {
        handled: true,
        error: `Command /${cmd.name} failed: ${err.message}`,
      };
    }
  }

  /**
   * Get a command definition.
   * @param {string} name
   * @returns {CommandDef|null}
   */
  get(name) {
    const resolved = this._aliases.get(name) || name;
    return this._commands.get(resolved) || null;
  }

  /**
   * Get all registered commands.
   * @param {object} [opts]
   * @param {boolean} [opts.includeHidden]
   * @param {string} [opts.source]
   * @returns {CommandDef[]}
   */
  getAll(opts = {}) {
    let cmds = [...this._commands.values()];
    if (!opts.includeHidden) cmds = cmds.filter(c => !c.hidden);
    if (opts.source) cmds = cmds.filter(c => c.source === opts.source);
    return cmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Generate help text for all commands.
   * @param {object} [opts]
   * @param {boolean} [opts.detailed]
   * @returns {string}
   */
  generateHelp(opts = {}) {
    const cmds = this.getAll();
    if (cmds.length === 0) return 'No commands available.';

    const lines = ['📋 Available Commands:\n'];

    for (const cmd of cmds) {
      lines.push(`/${cmd.name} — ${cmd.description}`);
      if (opts.detailed && cmd.help) {
        lines.push(`  ${cmd.help}`);
      }
      if (opts.detailed && cmd.aliases.length > 0) {
        lines.push(`  Aliases: ${cmd.aliases.map(a => '/' + a).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get a map of bridge-safe commands.
   * @returns {Set<string>}
   */
  getBridgeSafe() {
    return new Set(
      [...this._commands.values()]
        .filter(c => c.bridgeSafe)
        .map(c => c.name)
    );
  }
}

// ── Built-in Commands ────────────────────────────────────────────────────
/**
 * Register all built-in commands.
 * @param {CommandRegistry} registry
 */
export function registerBuiltins(registry) {

  registry.register({
    name: 'start',
    aliases: ['hello', 'hi'],
    description: 'Start a conversation / show welcome',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      const agentName = ctx.agentId.charAt(0).toUpperCase() + ctx.agentId.slice(1);
      return {
        text: `👋 Hey! I'm ${agentName}.\n\n` +
          `Send me a message and I'll help you out.\n\n` +
          `Type /help to see available commands.`,
      };
    },
  });

  registry.register({
    name: 'help',
    aliases: ['commands', 'h'],
    description: 'Show available commands',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      return { text: registry.generateHelp({ detailed: false }) };
    },
  });

  registry.register({
    name: 'new',
    aliases: ['reset', 'clear'],
    description: 'Start a fresh conversation',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      // Clear session — the bridge should handle this via the result
      return {
        text: '🔄 Session cleared. Starting fresh!',
        action: 'clear_session',
      };
    },
  });

  registry.register({
    name: 'status',
    description: 'Show system status',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      return {
        text: `📊 System Status\n` +
          `• Agent: ${ctx.agentId}\n` +
          `• Uptime: ${hours}h ${mins}m\n` +
          `• Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB\n` +
          `• Node: ${process.version}`,
      };
    },
  });

  registry.register({
    name: 'stop',
    aliases: ['cancel', 'abort'],
    description: 'Stop the current task',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      return {
        text: '⏹ Stopping current task...',
        action: 'stop_active_call',
      };
    },
  });

  registry.register({
    name: 'model',
    description: 'Switch the AI model',
    usage: '/model <name>',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        return {
          text: `Current model: ${ctx.config?.agents?.[ctx.agentId]?.model || 'default'}\n\n` +
            `Usage: /model <name>\n` +
            `Available: opus, sonnet, haiku`,
        };
      }
      const model = ctx.args[0].toLowerCase();
      return {
        text: `🔄 Switching to ${model}...`,
        action: 'set_model',
        model,
      };
    },
  });

  registry.register({
    name: 'sessions',
    description: 'List recent conversation sessions',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      return {
        text: '📂 Fetching sessions...',
        action: 'list_sessions',
      };
    },
  });

  registry.register({
    name: 'resume',
    description: 'Resume a previous session',
    usage: '/resume <session-number>',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      const num = parseInt(ctx.args[0]);
      if (isNaN(num)) {
        return { text: 'Usage: /resume <session-number>' };
      }
      return {
        text: `Resuming session #${num}...`,
        action: 'resume_session',
        sessionNumber: num,
      };
    },
  });

  registry.register({
    name: 'voice',
    description: 'Toggle voice conversation mode',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      return {
        action: 'toggle_voice',
      };
    },
  });

  registry.register({
    name: 'compact',
    description: 'Compact conversation history to save context',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      return {
        text: '📦 Compacting conversation history...',
        action: 'compact_session',
      };
    },
  });

  registry.register({
    name: 'memory',
    description: 'Show or search agent memory',
    usage: '/memory [search query]',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      if (ctx.argString) {
        return {
          action: 'search_memory',
          query: ctx.argString,
        };
      }
      return {
        action: 'show_memory_stats',
      };
    },
  });

  registry.register({
    name: 'tools',
    description: 'List available tools and their permissions',
    type: COMMAND_TYPES.LOCAL,
    bridgeSafe: true,
    source: 'builtin',
    handler: async (ctx) => {
      return { action: 'list_tools' };
    },
  });

  registry.register({
    name: 'features',
    description: 'List enabled features',
    type: COMMAND_TYPES.LOCAL,
    adminOnly: true,
    source: 'builtin',
    handler: async (ctx) => {
      return { action: 'list_features' };
    },
  });
}

// ── Singleton ────────────────────────────────────────────────────────────
let _defaultRegistry = null;

/**
 * Get or create the default command registry with builtins.
 * @returns {CommandRegistry}
 */
export function getCommandRegistry() {
  if (!_defaultRegistry) {
    _defaultRegistry = new CommandRegistry();
    registerBuiltins(_defaultRegistry);
  }
  return _defaultRegistry;
}

export default CommandRegistry;
