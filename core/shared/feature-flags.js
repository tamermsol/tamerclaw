/**
 * feature-flags.js — Feature Flag System for TamerClaw
 *
 * Inspired by Claude Code's feature() gating from bun:bundle.
 * Provides runtime feature toggles for conditional loading of:
 *   - Tools
 *   - Commands
 *   - Hooks
 *   - Capabilities
 *
 * Features can be toggled per-agent, globally, or via environment variables.
 *
 * Usage:
 *   import { feature, FeatureFlags } from '../shared/feature-flags.js';
 *
 *   if (feature('SMART_MEMORY_RECALL')) {
 *     // Use AI-powered memory recall
 *   }
 *
 *   if (feature('COORDINATOR_MODE')) {
 *     // Enable multi-agent coordinator
 *   }
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import paths from './paths.js';

// ── Feature Definitions ──────────────────────────────────────────────────
// All known features with their defaults and descriptions
export const FEATURES = {
  // Memory features
  SMART_MEMORY_RECALL: {
    default: true,
    description: 'AI-powered memory selection using Haiku side-queries',
    category: 'memory',
  },
  SQLITE_MEMORY: {
    default: true,
    description: 'SQLite FTS5 memory storage (vs flat files only)',
    category: 'memory',
  },
  MEMORY_DEDUP: {
    default: true,
    description: 'Deduplicate memory entries on write',
    category: 'memory',
  },

  // Tool features
  TOOL_REGISTRY: {
    default: true,
    description: 'Structured tool definitions with permissions and validation',
    category: 'tools',
  },
  TOOL_RISK_CLASSIFICATION: {
    default: true,
    description: 'Auto-classify tool usage risk level',
    category: 'tools',
  },
  DEFERRED_TOOL_LOADING: {
    default: false,
    description: 'Defer non-essential tools until requested (saves context)',
    category: 'tools',
  },

  // Agent features
  COORDINATOR_MODE: {
    default: false,
    description: 'Multi-agent coordinator with worker dispatch',
    category: 'agent',
  },
  AGENT_HEARTBEAT: {
    default: true,
    description: 'Regular heartbeat from running agents',
    category: 'agent',
  },
  AGENT_WORKTREE: {
    default: false,
    description: 'Git worktree isolation for parallel agent work',
    category: 'agent',
  },

  // Communication features
  ECHO_DEDUP: {
    default: true,
    description: 'Ring buffer deduplication for bridge messages',
    category: 'communication',
  },
  MESSAGE_BATCHING: {
    default: true,
    description: 'Batch rapid messages before sending to Claude',
    category: 'communication',
  },
  SMART_BROADCAST: {
    default: true,
    description: 'Intelligent voice/text response routing',
    category: 'communication',
  },

  // Security features
  HOOK_SYSTEM: {
    default: true,
    description: 'Pre/post lifecycle hooks for tool and session events',
    category: 'security',
  },
  COMMAND_REGISTRY: {
    default: true,
    description: 'Structured slash command framework',
    category: 'security',
  },
  PERMISSION_PERSISTENCE: {
    default: true,
    description: 'Persist approved tool permissions across sessions',
    category: 'security',
  },

  // Compute features
  REMOTE_COMPUTE: {
    default: true,
    description: 'Remote compute node dispatch (Mac Mini, etc.)',
    category: 'compute',
  },
  COMPUTE_WATCHDOG: {
    default: true,
    description: 'Health monitoring for compute nodes',
    category: 'compute',
  },
  COMPUTE_TOOLS: {
    default: true,
    description: 'Mac Mini capabilities as first-class registered tools',
    category: 'compute',
  },

  // Model routing features
  DIRECT_API: {
    default: true,
    description: 'Direct Anthropic SDK client (bypass CLI for speed)',
    category: 'model',
  },
  SMART_MODEL_ROUTING: {
    default: true,
    description: 'AI-powered complexity classification for model selection',
    category: 'model',
  },
  MODEL_FALLBACK_CHAIN: {
    default: true,
    description: 'Automatic fallback: Claude API → local Ollama → Mac Mini Ollama',
    category: 'model',
  },
  COST_TRACKING: {
    default: true,
    description: 'Track API usage costs per model per agent',
    category: 'model',
  },
  RATE_LIMIT_DOWNSHIFT: {
    default: true,
    description: 'Auto-downshift to cheaper model on rate limits',
    category: 'model',
  },

  // UI/UX features
  LIVE_STREAMING: {
    default: true,
    description: 'Real-time message editing as Claude generates',
    category: 'ux',
  },
  TOOL_ACTIVITY_DISPLAY: {
    default: true,
    description: 'Show what tool Claude is currently using',
    category: 'ux',
  },
  VOICE_MODE: {
    default: true,
    description: 'Voice conversation mode (voice in → voice out)',
    category: 'ux',
  },

  // v1.17.0 "Phoenix" features
  TOKEN_BUDGET: {
    default: true,
    description: 'Token budget tracker with auto-continue and diminishing returns detection',
    category: 'engine',
  },
  EXTRACT_MEMORIES: {
    default: true,
    description: 'Post-turn memory extraction (short-term → medium-term pipeline)',
    category: 'memory',
  },
  SESSION_COMPACT: {
    default: true,
    description: 'Session memory compaction (replace old messages with summary + recent tail)',
    category: 'memory',
  },
  SKILLS_ENGINE: {
    default: true,
    description: 'Context-aware skill system (/stuck, /simplify, /verify, /skillify, etc.)',
    category: 'engine',
  },
  COORDINATOR_MODE: {
    default: true,
    description: 'Multi-agent coordinator with parallel workers, scratchpad, and dependency resolution',
    category: 'agent',
  },
  REACTIVE_STORE: {
    default: true,
    description: 'Pub-sub reactive state stores replacing ad-hoc Maps',
    category: 'engine',
  },
  TASK_FRAMEWORK: {
    default: true,
    description: 'Unified background task registry with lifecycle, progress, and abort support',
    category: 'engine',
  },

  // Performance features
  PROMPT_CACHE: {
    default: true,
    description: 'Cache system prompt sections that rarely change',
    category: 'performance',
  },
  RATE_LIMITER: {
    default: true,
    description: 'Proactive rate limit management with model downshifting',
    category: 'performance',
  },
};

// ── Feature Flags Class ──────────────────────────────────────────────────
export class FeatureFlags {
  constructor() {
    /** @type {Map<string, boolean>} */
    this._overrides = new Map();
    /** @type {Map<string, Map<string, boolean>>} agentId → feature → enabled */
    this._agentOverrides = new Map();

    // Load from config file if it exists
    this._loadFromConfig();
    // Load from environment variables
    this._loadFromEnv();
  }

  /**
   * Check if a feature is enabled.
   * Priority: agent override > global override > env var > default
   *
   * @param {string} featureName
   * @param {string} [agentId] - Optional agent-specific check
   * @returns {boolean}
   */
  isEnabled(featureName, agentId = null) {
    // Agent-specific override
    if (agentId) {
      const agentFlags = this._agentOverrides.get(agentId);
      if (agentFlags?.has(featureName)) {
        return agentFlags.get(featureName);
      }
    }

    // Global override
    if (this._overrides.has(featureName)) {
      return this._overrides.get(featureName);
    }

    // Default
    return FEATURES[featureName]?.default ?? false;
  }

  /**
   * Enable a feature globally.
   * @param {string} featureName
   */
  enable(featureName) {
    this._overrides.set(featureName, true);
  }

  /**
   * Disable a feature globally.
   * @param {string} featureName
   */
  disable(featureName) {
    this._overrides.set(featureName, false);
  }

  /**
   * Toggle a feature.
   * @param {string} featureName
   * @param {string} [agentId]
   * @returns {boolean} New state
   */
  toggle(featureName, agentId = null) {
    const current = this.isEnabled(featureName, agentId);
    if (agentId) {
      this.setForAgent(agentId, featureName, !current);
    } else {
      this._overrides.set(featureName, !current);
    }
    return !current;
  }

  /**
   * Set a feature for a specific agent.
   * @param {string} agentId
   * @param {string} featureName
   * @param {boolean} enabled
   */
  setForAgent(agentId, featureName, enabled) {
    if (!this._agentOverrides.has(agentId)) {
      this._agentOverrides.set(agentId, new Map());
    }
    this._agentOverrides.get(agentId).set(featureName, enabled);
  }

  /**
   * Get all features and their current states.
   * @param {string} [agentId]
   * @returns {object}
   */
  getAll(agentId = null) {
    const result = {};
    for (const [name, def] of Object.entries(FEATURES)) {
      result[name] = {
        enabled: this.isEnabled(name, agentId),
        default: def.default,
        description: def.description,
        category: def.category,
        overridden: this._overrides.has(name) ||
          (agentId && this._agentOverrides.get(agentId)?.has(name)),
      };
    }
    return result;
  }

  /**
   * Get features by category.
   * @param {string} category
   * @param {string} [agentId]
   * @returns {object}
   */
  getByCategory(category, agentId = null) {
    const all = this.getAll(agentId);
    return Object.fromEntries(
      Object.entries(all).filter(([, v]) => v.category === category)
    );
  }

  /**
   * Generate a summary for display/logging.
   * @param {string} [agentId]
   * @returns {string}
   */
  summary(agentId = null) {
    const all = this.getAll(agentId);
    const lines = ['Feature Flags:'];

    const categories = [...new Set(Object.values(all).map(v => v.category))].sort();
    for (const cat of categories) {
      lines.push(`\n[${cat}]`);
      for (const [name, info] of Object.entries(all)) {
        if (info.category !== cat) continue;
        const icon = info.enabled ? '✅' : '❌';
        const override = info.overridden ? ' (override)' : '';
        lines.push(`  ${icon} ${name}${override}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Save current overrides to config.
   */
  save() {
    const configPath = path.join(paths.user, 'feature-flags.json');
    const data = {
      global: Object.fromEntries(this._overrides),
      agents: Object.fromEntries(
        [...this._agentOverrides].map(([agentId, flags]) => [
          agentId,
          Object.fromEntries(flags),
        ])
      ),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(configPath, JSON.stringify(data, null, 2));
  }

  // ── Private ────────────────────────────────────────────────────────────

  _loadFromConfig() {
    try {
      const configPath = path.join(paths.user, 'feature-flags.json');
      if (!existsSync(configPath)) return;

      const data = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Global overrides
      if (data.global) {
        for (const [name, enabled] of Object.entries(data.global)) {
          this._overrides.set(name, Boolean(enabled));
        }
      }

      // Agent overrides
      if (data.agents) {
        for (const [agentId, flags] of Object.entries(data.agents)) {
          const agentFlags = new Map();
          for (const [name, enabled] of Object.entries(flags)) {
            agentFlags.set(name, Boolean(enabled));
          }
          this._agentOverrides.set(agentId, agentFlags);
        }
      }
    } catch {}
  }

  _loadFromEnv() {
    // Environment variables: TAMERCLAW_FEATURE_<NAME>=1|0|true|false
    for (const name of Object.keys(FEATURES)) {
      const envKey = `TAMERCLAW_FEATURE_${name}`;
      const envVal = process.env[envKey];
      if (envVal !== undefined) {
        this._overrides.set(name, envVal === '1' || envVal === 'true');
      }
    }
  }
}

// ── Singleton & Shorthand ────────────────────────────────────────────────
let _instance = null;

/**
 * Get the singleton FeatureFlags instance.
 * @returns {FeatureFlags}
 */
export function getFeatureFlags() {
  if (!_instance) {
    _instance = new FeatureFlags();
  }
  return _instance;
}

/**
 * Quick feature check — the main API most code should use.
 *
 * @param {string} featureName
 * @param {string} [agentId]
 * @returns {boolean}
 *
 * @example
 *   if (feature('SMART_MEMORY_RECALL')) { ... }
 *   if (feature('COORDINATOR_MODE', 'supreme')) { ... }
 */
export function feature(featureName, agentId = null) {
  return getFeatureFlags().isEnabled(featureName, agentId);
}

export default feature;
