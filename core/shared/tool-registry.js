/**
 * tool-registry.js — Structured Tool Registry for TamerClaw
 *
 * Inspired by Claude Code's Tool.ts + tools.ts architecture.
 * Provides a type-safe tool definition system with:
 *   - Permission checking (read-only, destructive, concurrency-safe)
 *   - Input validation
 *   - Dynamic descriptions
 *   - Feature-gated conditional loading
 *   - Safety metadata for auto-classification
 *
 * Usage:
 *   import { ToolRegistry, buildTool } from '../shared/tool-registry.js';
 *
 *   const registry = new ToolRegistry();
 *   registry.register(buildTool({
 *     name: 'web-search',
 *     description: 'Search the web for information',
 *     category: 'research',
 *     permissions: { readOnly: true, concurrencySafe: true },
 *     allowedTools: ['WebSearch', 'WebFetch'],
 *     validate: (input) => input.query?.length > 0,
 *   }));
 */

// ── Tool Categories ──────────────────────────────────────────────────────
export const TOOL_CATEGORIES = {
  FILE_SYSTEM: 'file-system',
  CODE: 'code',
  RESEARCH: 'research',
  COMMUNICATION: 'communication',
  SYSTEM: 'system',
  MEDIA: 'media',
  COMPUTE: 'compute',
  MEMORY: 'memory',
  AGENT: 'agent',
};

// ── Permission Levels ────────────────────────────────────────────────────
export const PERMISSION_LEVELS = {
  ALWAYS_ALLOW: 'always-allow',    // No confirmation needed
  ASK_FIRST: 'ask-first',         // Ask user before first use
  ASK_EVERY: 'ask-every',         // Ask every time
  DENY: 'deny',                    // Never allow
};

// ── Default Tool Definitions ─────────────────────────────────────────────
// These map to Claude CLI --allowedTools flags
const BUILTIN_TOOL_DEFS = {
  // File system tools
  'Read': {
    name: 'Read',
    description: 'Read file contents',
    category: TOOL_CATEGORIES.FILE_SYSTEM,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },
  'Edit': {
    name: 'Edit',
    description: 'Edit files with exact string replacements',
    category: TOOL_CATEGORIES.FILE_SYSTEM,
    permissions: { readOnly: false, destructive: false, concurrencySafe: false },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
  },
  'Write': {
    name: 'Write',
    description: 'Write or create files',
    category: TOOL_CATEGORIES.FILE_SYSTEM,
    permissions: { readOnly: false, destructive: true, concurrencySafe: false },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
  },
  'Glob': {
    name: 'Glob',
    description: 'Find files by pattern matching',
    category: TOOL_CATEGORIES.FILE_SYSTEM,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },
  'Grep': {
    name: 'Grep',
    description: 'Search file contents with regex',
    category: TOOL_CATEGORIES.FILE_SYSTEM,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },

  // Code execution
  'Bash': {
    name: 'Bash',
    description: 'Execute shell commands',
    category: TOOL_CATEGORIES.SYSTEM,
    permissions: { readOnly: false, destructive: true, concurrencySafe: false },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
  },
  'NotebookEdit': {
    name: 'NotebookEdit',
    description: 'Edit Jupyter notebook cells',
    category: TOOL_CATEGORIES.CODE,
    permissions: { readOnly: false, destructive: false, concurrencySafe: false },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
  },

  // Research tools
  'WebSearch': {
    name: 'WebSearch',
    description: 'Search the web for information',
    category: TOOL_CATEGORIES.RESEARCH,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },
  'WebFetch': {
    name: 'WebFetch',
    description: 'Fetch web page content',
    category: TOOL_CATEGORIES.RESEARCH,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },

  // Agent tools
  'Agent': {
    name: 'Agent',
    description: 'Spawn sub-agents for complex tasks',
    category: TOOL_CATEGORIES.AGENT,
    permissions: { readOnly: false, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },
  'TodoWrite': {
    name: 'TodoWrite',
    description: 'Track task progress with todo lists',
    category: TOOL_CATEGORIES.AGENT,
    permissions: { readOnly: false, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },

  // Memory tools
  'Skill': {
    name: 'Skill',
    description: 'Execute specialized skills',
    category: TOOL_CATEGORIES.AGENT,
    permissions: { readOnly: false, destructive: false, concurrencySafe: false },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
  },
};

// ── Build Tool Factory ───────────────────────────────────────────────────
/**
 * Build a tool definition with safe defaults (fail-closed).
 * Mirrors Claude Code's buildTool() pattern.
 *
 * @param {object} opts
 * @param {string} opts.name            - Tool name (must be unique)
 * @param {string} opts.description     - Human-readable description
 * @param {string} [opts.category]      - Tool category (from TOOL_CATEGORIES)
 * @param {object} [opts.permissions]   - Permission metadata
 * @param {boolean} [opts.permissions.readOnly=false]
 * @param {boolean} [opts.permissions.destructive=false]
 * @param {boolean} [opts.permissions.concurrencySafe=false]
 * @param {string} [opts.defaultPermission] - Default permission level
 * @param {string[]} [opts.allowedTools]    - Claude CLI --allowedTools flags
 * @param {string[]} [opts.requiredFeatures] - Feature flags required
 * @param {Function} [opts.validate]        - Input validation function
 * @param {Function} [opts.beforeExecute]   - Pre-execution hook
 * @param {Function} [opts.afterExecute]    - Post-execution hook
 * @param {boolean} [opts.shouldDefer=false] - Defer loading via ToolSearch
 * @param {boolean} [opts.alwaysLoad=true]   - Always include in tool pool
 * @param {object} [opts.metadata]          - Arbitrary metadata
 * @returns {object} Tool definition
 */
export function buildTool(opts) {
  return {
    name: opts.name,
    description: opts.description || '',
    category: opts.category || TOOL_CATEGORIES.SYSTEM,
    permissions: {
      readOnly: opts.permissions?.readOnly ?? false,
      destructive: opts.permissions?.destructive ?? false,
      concurrencySafe: opts.permissions?.concurrencySafe ?? false,
    },
    defaultPermission: opts.defaultPermission || PERMISSION_LEVELS.ASK_FIRST,
    allowedTools: opts.allowedTools || [opts.name],
    requiredFeatures: opts.requiredFeatures || [],
    validate: opts.validate || (() => true),
    beforeExecute: opts.beforeExecute || null,
    afterExecute: opts.afterExecute || null,
    shouldDefer: opts.shouldDefer ?? false,
    alwaysLoad: opts.alwaysLoad ?? true,
    metadata: opts.metadata || {},
    // Computed
    get isReadOnly() { return this.permissions.readOnly; },
    get isDestructive() { return this.permissions.destructive; },
    get isConcurrencySafe() { return this.permissions.concurrencySafe; },
  };
}

// ── Tool Registry ────────────────────────────────────────────────────────
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._tools = new Map();
    /** @type {Map<string, Set<string>>} */
    this._categories = new Map();
    /** @type {Map<string, string>} */
    this._permissionOverrides = new Map(); // toolName → permission level
    /** @type {Set<string>} */
    this._enabledFeatures = new Set();

    // Register all builtin tools
    for (const [name, def] of Object.entries(BUILTIN_TOOL_DEFS)) {
      this.register(buildTool(def));
    }
  }

  /**
   * Register a tool definition.
   * @param {object} tool - Built tool definition from buildTool()
   */
  register(tool) {
    this._tools.set(tool.name, tool);

    if (!this._categories.has(tool.category)) {
      this._categories.set(tool.category, new Set());
    }
    this._categories.get(tool.category).add(tool.name);
  }

  /**
   * Unregister a tool.
   * @param {string} name
   */
  unregister(name) {
    const tool = this._tools.get(name);
    if (tool) {
      this._categories.get(tool.category)?.delete(name);
      this._tools.delete(name);
    }
  }

  /**
   * Get a tool by name.
   * @param {string} name
   * @returns {object|null}
   */
  get(name) {
    return this._tools.get(name) || null;
  }

  /**
   * Check if a tool is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._tools.has(name);
  }

  /**
   * Enable a feature flag (for conditional tool loading).
   * @param {string} feature
   */
  enableFeature(feature) {
    this._enabledFeatures.add(feature);
  }

  /**
   * Disable a feature flag.
   * @param {string} feature
   */
  disableFeature(feature) {
    this._enabledFeatures.delete(feature);
  }

  /**
   * Set permission override for a tool.
   * @param {string} toolName
   * @param {string} level - Permission level from PERMISSION_LEVELS
   */
  setPermission(toolName, level) {
    this._permissionOverrides.set(toolName, level);
  }

  /**
   * Get effective permission level for a tool.
   * @param {string} toolName
   * @returns {string}
   */
  getPermission(toolName) {
    return this._permissionOverrides.get(toolName)
      || this._tools.get(toolName)?.defaultPermission
      || PERMISSION_LEVELS.ASK_FIRST;
  }

  /**
   * Check if a tool should be loaded based on feature flags.
   * @param {string} name
   * @returns {boolean}
   */
  isAvailable(name) {
    const tool = this._tools.get(name);
    if (!tool) return false;
    if (tool.requiredFeatures.length === 0) return true;
    return tool.requiredFeatures.every(f => this._enabledFeatures.has(f));
  }

  /**
   * Assemble the tool pool — list of --allowedTools flags for Claude CLI.
   * Mirrors Claude Code's assembleToolPool() pattern.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.categories]   - Only include these categories
   * @param {string[]} [opts.exclude]      - Exclude these tool names
   * @param {boolean} [opts.readOnlyMode]  - Only include read-only tools
   * @param {boolean} [opts.includeDeferrable] - Include tools with shouldDefer
   * @returns {string[]} Array of tool names for --allowedTools
   */
  assembleToolPool(opts = {}) {
    const pool = [];

    for (const [name, tool] of this._tools) {
      // Feature gate check
      if (!this.isAvailable(name)) continue;

      // Category filter
      if (opts.categories && !opts.categories.includes(tool.category)) continue;

      // Exclude list
      if (opts.exclude && opts.exclude.includes(name)) continue;

      // Read-only mode
      if (opts.readOnlyMode && !tool.permissions.readOnly) continue;

      // Defer check (skip deferrable unless explicitly included)
      if (tool.shouldDefer && !opts.includeDeferrable) continue;

      // Always-load check
      if (!tool.alwaysLoad && !opts.includeDeferrable) continue;

      // Permission check - skip denied tools
      if (this.getPermission(name) === PERMISSION_LEVELS.DENY) continue;

      pool.push(...tool.allowedTools);
    }

    // Deduplicate and sort for prompt-cache stability (like Claude Code)
    return [...new Set(pool)].sort();
  }

  /**
   * Get all tools in a category.
   * @param {string} category
   * @returns {object[]}
   */
  getByCategory(category) {
    const names = this._categories.get(category) || new Set();
    return [...names].map(n => this._tools.get(n)).filter(Boolean);
  }

  /**
   * Get all registered tools.
   * @returns {object[]}
   */
  getAll() {
    return [...this._tools.values()];
  }

  /**
   * Generate a human-readable tool summary for system prompts.
   * @returns {string}
   */
  toPromptSection() {
    const lines = ['# Available Tools\n'];

    for (const [category, toolNames] of this._categories) {
      const available = [...toolNames].filter(n => this.isAvailable(n));
      if (available.length === 0) continue;

      lines.push(`## ${category}`);
      for (const name of available) {
        const tool = this._tools.get(name);
        const flags = [];
        if (tool.permissions.readOnly) flags.push('read-only');
        if (tool.permissions.destructive) flags.push('⚠️ destructive');
        const flagStr = flags.length ? ` (${flags.join(', ')})` : '';
        lines.push(`- **${name}**: ${tool.description}${flagStr}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Auto-classify a tool usage for safety.
   * Returns risk level: 'safe', 'moderate', 'dangerous'.
   * Mirrors Claude Code's toAutoClassifierInput().
   *
   * @param {string} toolName
   * @param {object} input - Tool input/args
   * @returns {{ risk: string, reason: string }}
   */
  classifyRisk(toolName, input = {}) {
    const tool = this._tools.get(toolName);
    if (!tool) return { risk: 'dangerous', reason: 'Unknown tool' };

    if (tool.permissions.readOnly) {
      return { risk: 'safe', reason: 'Read-only operation' };
    }

    if (tool.permissions.destructive) {
      // Check for particularly dangerous patterns
      const inputStr = JSON.stringify(input).toLowerCase();
      const dangerPatterns = [
        'rm -rf', 'drop table', 'delete from', 'format',
        'dd if=', 'mkfs', ':(){:|:&};:', 'chmod 777',
        'git push --force', 'git reset --hard',
      ];

      if (dangerPatterns.some(p => inputStr.includes(p))) {
        return { risk: 'dangerous', reason: `Destructive tool with dangerous pattern detected` };
      }

      return { risk: 'moderate', reason: 'Destructive tool' };
    }

    return { risk: 'moderate', reason: 'Write operation' };
  }

  /**
   * Export registry state for persistence.
   * @returns {object}
   */
  toJSON() {
    return {
      tools: Object.fromEntries(
        [...this._tools].map(([name, t]) => [name, {
          name: t.name,
          description: t.description,
          category: t.category,
          permissions: t.permissions,
          defaultPermission: t.defaultPermission,
          allowedTools: t.allowedTools,
          requiredFeatures: t.requiredFeatures,
          shouldDefer: t.shouldDefer,
          alwaysLoad: t.alwaysLoad,
        }])
      ),
      permissionOverrides: Object.fromEntries(this._permissionOverrides),
      enabledFeatures: [...this._enabledFeatures],
    };
  }

  /**
   * Load permission overrides from a config object.
   * @param {object} config - { toolName: permissionLevel }
   */
  loadPermissions(config) {
    for (const [name, level] of Object.entries(config || {})) {
      this._permissionOverrides.set(name, level);
    }
  }
}

// ── Preset Tool Profiles ─────────────────────────────────────────────────
// Pre-built tool configurations for common agent roles

export const TOOL_PROFILES = {
  // Full access — for supreme/admin agents
  full: {
    categories: null, // all categories
    exclude: [],
    readOnlyMode: false,
  },

  // Read-only — for research/analysis agents
  readonly: {
    categories: null,
    exclude: [],
    readOnlyMode: true,
  },

  // Developer — code-focused agent
  developer: {
    categories: [
      TOOL_CATEGORIES.FILE_SYSTEM,
      TOOL_CATEGORIES.CODE,
      TOOL_CATEGORIES.SYSTEM,
      TOOL_CATEGORIES.RESEARCH,
      TOOL_CATEGORIES.AGENT,
    ],
    exclude: [],
    readOnlyMode: false,
  },

  // Researcher — web + file reading only
  researcher: {
    categories: [
      TOOL_CATEGORIES.RESEARCH,
      TOOL_CATEGORIES.FILE_SYSTEM,
      TOOL_CATEGORIES.MEMORY,
    ],
    exclude: ['Edit', 'Write', 'Bash'],
    readOnlyMode: false,
  },

  // Coordinator — only agent management tools (like Claude Code coordinator mode)
  coordinator: {
    categories: [TOOL_CATEGORIES.AGENT],
    exclude: [],
    readOnlyMode: false,
  },

  // Compute — developer tools + compute capabilities (Mac Mini)
  compute: {
    categories: [
      TOOL_CATEGORIES.FILE_SYSTEM,
      TOOL_CATEGORIES.CODE,
      TOOL_CATEGORIES.SYSTEM,
      TOOL_CATEGORIES.RESEARCH,
      TOOL_CATEGORIES.AGENT,
      TOOL_CATEGORIES.COMPUTE,
      TOOL_CATEGORIES.MEDIA,
    ],
    exclude: [],
    readOnlyMode: false,
    includeDeferrable: true,
  },

  // Media — media processing tools (voice, video, image)
  media: {
    categories: [
      TOOL_CATEGORIES.MEDIA,
      TOOL_CATEGORIES.FILE_SYSTEM,
    ],
    exclude: [],
    readOnlyMode: false,
  },
};

// ── Singleton ────────────────────────────────────────────────────────────
let _defaultRegistry = null;

/**
 * Get or create the default global registry.
 * @returns {ToolRegistry}
 */
export function getRegistry() {
  if (!_defaultRegistry) {
    _defaultRegistry = new ToolRegistry();
  }
  return _defaultRegistry;
}

export default ToolRegistry;
