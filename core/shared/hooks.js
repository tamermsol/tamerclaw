/**
 * hooks.js — Lifecycle Hooks System for TamerClaw
 *
 * Inspired by Claude Code's hooks/ architecture.
 * Provides pre/post hooks for:
 *   - Tool execution (before/after Bash, Edit, etc.)
 *   - Session lifecycle (create, resume, archive)
 *   - Message processing (before/after Claude response)
 *   - Agent lifecycle (start, stop, error)
 *   - Memory operations (before/after write)
 *
 * Hooks can modify, block, or augment operations.
 *
 * Usage:
 *   import { HookManager, HOOK_EVENTS } from '../shared/hooks.js';
 *
 *   const hooks = new HookManager();
 *
 *   hooks.on(HOOK_EVENTS.BEFORE_TOOL_EXECUTE, async (ctx) => {
 *     if (ctx.toolName === 'Bash' && ctx.input.command.includes('rm -rf')) {
 *       return { block: true, reason: 'Dangerous command blocked' };
 *     }
 *   });
 *
 *   hooks.on(HOOK_EVENTS.AFTER_RESPONSE, async (ctx) => {
 *     // Auto-save conversation to memory
 *     await saveToMemory(ctx.agentId, ctx.response);
 *   });
 */

// ── Hook Events ──────────────────────────────────────────────────────────
export const HOOK_EVENTS = {
  // Tool hooks
  BEFORE_TOOL_EXECUTE: 'before:tool:execute',
  AFTER_TOOL_EXECUTE: 'after:tool:execute',
  TOOL_PERMISSION_CHECK: 'tool:permission:check',
  TOOL_ERROR: 'tool:error',

  // Session hooks
  SESSION_CREATE: 'session:create',
  SESSION_RESUME: 'session:resume',
  SESSION_ARCHIVE: 'session:archive',
  SESSION_CLEAR: 'session:clear',

  // Message hooks
  BEFORE_MESSAGE: 'before:message',
  AFTER_MESSAGE: 'after:message',
  BEFORE_RESPONSE: 'before:response',
  AFTER_RESPONSE: 'after:response',
  STREAM_CHUNK: 'stream:chunk',

  // Agent hooks
  AGENT_START: 'agent:start',
  AGENT_STOP: 'agent:stop',
  AGENT_ERROR: 'agent:error',
  AGENT_HEARTBEAT: 'agent:heartbeat',

  // Memory hooks
  BEFORE_MEMORY_WRITE: 'before:memory:write',
  AFTER_MEMORY_WRITE: 'after:memory:write',
  MEMORY_RECALL: 'memory:recall',

  // System hooks
  CONFIG_CHANGE: 'config:change',
  RATE_LIMIT: 'rate:limit',
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPONSE: 'permission:response',
};

// ── Hook Priority ────────────────────────────────────────────────────────
export const HOOK_PRIORITY = {
  CRITICAL: 0,    // Security checks, blockers
  HIGH: 10,       // Validation, transforms
  NORMAL: 50,     // Default
  LOW: 90,        // Logging, analytics
  LAST: 100,      // Cleanup
};

// ── Hook Definition ──────────────────────────────────────────────────────
/**
 * @typedef {object} HookDef
 * @property {string} id          - Unique hook ID
 * @property {string} event       - Event name from HOOK_EVENTS
 * @property {number} [priority]  - Execution priority (lower = earlier)
 * @property {Function} handler   - async (ctx) => result
 * @property {Function} [filter]  - (ctx) => boolean — conditional execution
 * @property {string} [source]    - 'builtin', 'plugin', 'config', 'custom'
 * @property {boolean} [once]     - Remove after first execution
 */

// ── Hook Manager ─────────────────────────────────────────────────────────
export class HookManager {
  constructor() {
    /** @type {Map<string, HookDef[]>} event → sorted hook array */
    this._hooks = new Map();
    /** @type {Map<string, number>} hookId → execution count */
    this._stats = new Map();
    /** @type {boolean} */
    this._enabled = true;
  }

  /**
   * Register a hook.
   * @param {string} event   - Event name
   * @param {Function} handler - async (ctx) => result
   * @param {object} [opts]  - Additional options
   * @returns {string} Hook ID (for removal)
   */
  on(event, handler, opts = {}) {
    const id = opts.id || `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const hook = {
      id,
      event,
      handler,
      priority: opts.priority ?? HOOK_PRIORITY.NORMAL,
      filter: opts.filter || null,
      source: opts.source || 'custom',
      once: opts.once ?? false,
    };

    if (!this._hooks.has(event)) {
      this._hooks.set(event, []);
    }

    const hooks = this._hooks.get(event);
    hooks.push(hook);
    // Keep sorted by priority
    hooks.sort((a, b) => a.priority - b.priority);

    this._stats.set(id, 0);
    return id;
  }

  /**
   * Register a one-time hook.
   * @param {string} event
   * @param {Function} handler
   * @param {object} [opts]
   * @returns {string} Hook ID
   */
  once(event, handler, opts = {}) {
    return this.on(event, handler, { ...opts, once: true });
  }

  /**
   * Remove a hook by ID.
   * @param {string} id
   * @returns {boolean}
   */
  off(id) {
    for (const [event, hooks] of this._hooks) {
      const idx = hooks.findIndex(h => h.id === id);
      if (idx !== -1) {
        hooks.splice(idx, 1);
        this._stats.delete(id);
        return true;
      }
    }
    return false;
  }

  /**
   * Remove all hooks for an event.
   * @param {string} event
   */
  removeAll(event) {
    if (event) {
      const hooks = this._hooks.get(event) || [];
      for (const h of hooks) this._stats.delete(h.id);
      this._hooks.delete(event);
    } else {
      this._hooks.clear();
      this._stats.clear();
    }
  }

  /**
   * Enable/disable the hook system.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
  }

  /**
   * Emit an event and run all matching hooks.
   * Returns aggregated results. If any hook returns { block: true },
   * the operation should be cancelled.
   *
   * @param {string} event
   * @param {object} ctx - Event context
   * @returns {Promise<{ blocked: boolean, reason?: string, results: any[] }>}
   */
  async emit(event, ctx = {}) {
    if (!this._enabled) return { blocked: false, results: [] };

    const hooks = this._hooks.get(event) || [];
    if (hooks.length === 0) return { blocked: false, results: [] };

    const results = [];
    const toRemove = [];

    for (const hook of hooks) {
      // Apply filter
      if (hook.filter && !hook.filter(ctx)) continue;

      try {
        const result = await hook.handler({ ...ctx, hookId: hook.id, event });
        this._stats.set(hook.id, (this._stats.get(hook.id) || 0) + 1);
        results.push(result);

        // Check for block signal
        if (result && result.block) {
          if (hook.once) toRemove.push(hook.id);
          return {
            blocked: true,
            reason: result.reason || `Blocked by hook ${hook.id}`,
            blockedBy: hook.id,
            results,
          };
        }

        // Check for transform signal — mutate ctx for next hooks
        if (result && result.transform) {
          Object.assign(ctx, result.transform);
        }
      } catch (err) {
        console.error(`[hooks] Error in hook ${hook.id} for ${event}:`, err.message);
        results.push({ error: err.message, hookId: hook.id });
      }

      if (hook.once) toRemove.push(hook.id);
    }

    // Remove one-time hooks
    for (const id of toRemove) this.off(id);

    return { blocked: false, results };
  }

  /**
   * Emit and return the first non-null result (useful for transform hooks).
   * @param {string} event
   * @param {object} ctx
   * @returns {Promise<any>}
   */
  async emitFirst(event, ctx = {}) {
    const { results } = await this.emit(event, ctx);
    return results.find(r => r != null) || null;
  }

  /**
   * Get hook statistics.
   * @returns {object}
   */
  getStats() {
    const stats = {};
    for (const [event, hooks] of this._hooks) {
      stats[event] = hooks.map(h => ({
        id: h.id,
        priority: h.priority,
        source: h.source,
        executions: this._stats.get(h.id) || 0,
      }));
    }
    return stats;
  }

  /**
   * List all registered events and their hook counts.
   * @returns {object}
   */
  listEvents() {
    const events = {};
    for (const [event, hooks] of this._hooks) {
      events[event] = hooks.length;
    }
    return events;
  }
}

// ── Built-in Hooks ───────────────────────────────────────────────────────
/**
 * Register security and safety hooks.
 * @param {HookManager} hooks
 * @param {object} [opts]
 */
export function registerSecurityHooks(hooks, opts = {}) {
  // Block dangerous bash commands
  hooks.on(HOOK_EVENTS.BEFORE_TOOL_EXECUTE, async (ctx) => {
    if (ctx.toolName !== 'Bash') return;
    const cmd = (ctx.input?.command || '').toLowerCase();

    const blocked = [
      'rm -rf /',
      'rm -rf /*',
      'dd if=/dev/zero',
      'mkfs.',
      ':(){:|:&};:',
      'chmod -R 777 /',
      '> /dev/sda',
      'mv / ',
    ];

    if (blocked.some(b => cmd.includes(b))) {
      return { block: true, reason: `Dangerous command blocked: ${cmd.slice(0, 50)}` };
    }
  }, {
    id: 'security:block-dangerous-bash',
    priority: HOOK_PRIORITY.CRITICAL,
    source: 'builtin',
    filter: (ctx) => ctx.toolName === 'Bash',
  });

  // Block PM2 destructive commands
  hooks.on(HOOK_EVENTS.BEFORE_TOOL_EXECUTE, async (ctx) => {
    if (ctx.toolName !== 'Bash') return;
    const cmd = ctx.input?.command || '';

    const blockedPm2 = [
      'pm2 kill', 'pm2 delete all', 'pm2 stop all',
      'pm2 restart all', 'pm2 flush', 'pm2 reset',
    ];

    if (blockedPm2.some(b => cmd.includes(b))) {
      return { block: true, reason: `PM2 destructive command blocked: ${cmd.slice(0, 50)}` };
    }
  }, {
    id: 'security:block-pm2-destructive',
    priority: HOOK_PRIORITY.CRITICAL,
    source: 'builtin',
    filter: (ctx) => ctx.toolName === 'Bash',
  });

  // Log all tool executions
  hooks.on(HOOK_EVENTS.AFTER_TOOL_EXECUTE, async (ctx) => {
    const duration = ctx.duration ? `${ctx.duration}ms` : 'n/a';
    console.log(`[hook:audit] ${ctx.agentId} used ${ctx.toolName} (${duration})`);
  }, {
    id: 'audit:tool-usage',
    priority: HOOK_PRIORITY.LAST,
    source: 'builtin',
  });

  // Rate limit warning
  hooks.on(HOOK_EVENTS.RATE_LIMIT, async (ctx) => {
    console.warn(`[hook:rate] Rate limit hit for ${ctx.agentId}: ${ctx.model} (${ctx.remaining} remaining)`);
  }, {
    id: 'rate:warning',
    priority: HOOK_PRIORITY.NORMAL,
    source: 'builtin',
  });
}

/**
 * Register memory-related hooks.
 * @param {HookManager} hooks
 */
export function registerMemoryHooks(hooks) {
  // Auto-trim memory entries that are too long
  hooks.on(HOOK_EVENTS.BEFORE_MEMORY_WRITE, async (ctx) => {
    if (ctx.content && ctx.content.length > 10000) {
      return {
        transform: {
          content: ctx.content.slice(0, 10000) + '\n\n[... truncated at 10K chars]',
        },
      };
    }
  }, {
    id: 'memory:auto-trim',
    priority: HOOK_PRIORITY.NORMAL,
    source: 'builtin',
  });
}

// ── Singleton ────────────────────────────────────────────────────────────
let _defaultHooks = null;

/**
 * Get or create the default hook manager with builtins.
 * @returns {HookManager}
 */
export function getHookManager() {
  if (!_defaultHooks) {
    _defaultHooks = new HookManager();
    registerSecurityHooks(_defaultHooks);
    registerMemoryHooks(_defaultHooks);
  }
  return _defaultHooks;
}

export default HookManager;
