/**
 * claude-engine.js — Unified Claude Code Engine for TamerClaw
 *
 * This is the integration layer that wires together all Claude Code-inspired
 * systems into a single coherent engine:
 *   - Tool Registry (structured tool definitions)
 *   - Command Registry (slash command framework)
 *   - Hook System (lifecycle hooks)
 *   - Smart Memory Recall (AI-powered context selection)
 *   - Feature Flags (conditional feature loading)
 *   - Echo Dedup (message deduplication)
 *
 * The engine provides a single entry point for the bridge to process
 * messages through the full pipeline.
 *
 * Usage:
 *   import { ClaudeEngine } from '../shared/claude-engine.js';
 *
 *   const engine = new ClaudeEngine();
 *   await engine.initialize(config);
 *
 *   // Process a message
 *   const result = await engine.processMessage({
 *     agentId: 'flutter',
 *     chatId: '12345',
 *     text: '/help',
 *     bot: telegramBot,
 *   });
 */

import { ToolRegistry, getRegistry, buildTool, TOOL_PROFILES } from './tool-registry.js';
import { CommandRegistry, getCommandRegistry } from './command-registry.js';
import { HookManager, getHookManager, HOOK_EVENTS } from './hooks.js';
import { recallMemories, buildMemorySection, formatMemoriesForPrompt } from './smart-memory-recall.js';
import { FeatureFlags, getFeatureFlags, feature } from './feature-flags.js';
import { EchoDedup, getDedup } from './echo-dedup.js';

// v1.16.0 "Titan" — Direct API + Model Router + Compute Tools
import * as anthropic from './anthropic-client.js';
import { ModelRouter, getRouter, route as routeModel, getProviderStatus } from './model-router.js';
import { registerComputeTools, executeComputeTool, getComputeToolStatus, listComputeTools } from './compute-tools.js';

// v1.17.0 "Phoenix" Phase 1 — Token Budget + Extract Memories + Session Compact + Skills
import { TokenBudget, createBudget, getActiveBudget, clearBudget, budgetFromEffort, getAllBudgets } from './token-budget.js';
import { MemoryExtractor, getExtractor, extractMemories } from './extract-memories.js';
import { SessionCompactor, getCompactor, compactSession } from './session-compact.js';
import { SkillsEngine, getSkillsEngine, loadAgentSkills } from './skills.js';

// v1.17.0 "Phoenix" Phase 2 — Coordinator + Reactive Store + Task Framework
import { Coordinator, createCoordinator, getCoordinator, getAllCoordinators } from './coordinator-mode.js';
import { ReactiveStore, createStore, getStore, getGlobalStore, createAgentStore, listStores } from './reactive-store.js';
import { TaskRegistry, getTaskRegistry, startTask, runTask, Task, TASK_STATE } from './task-framework.js';

// ── Engine ───────────────────────────────────────────────────────────────
export class ClaudeEngine {
  constructor() {
    this.tools = getRegistry();
    this.commands = getCommandRegistry();
    this.hooks = getHookManager();
    this.features = getFeatureFlags();
    this.dedup = getDedup();

    // v1.16.0 "Titan" — API + Router + Compute
    this.api = anthropic;
    this.router = getRouter();
    this.computeTools = null; // Initialized in initialize()

    // v1.17.0 "Phoenix" Phase 1 — Budget + Memories + Compact + Skills
    this.skills = getSkillsEngine();
    this.memoryExtractor = getExtractor();
    this._compactors = new Map(); // Per-agent compactors

    // v1.17.0 "Phoenix" Phase 2 — Coordinator + Store + Tasks
    this.store = getGlobalStore();
    this.tasks = getTaskRegistry();

    this._initialized = false;
    this._config = null;
  }

  /**
   * Initialize the engine with config.
   * @param {object} config - TamerClaw config
   */
  async initialize(config) {
    this._config = config;

    // Load tool permissions from config
    if (config.tools?.permissions) {
      this.tools.loadPermissions(config.tools.permissions);
    }

    // Register custom tools from config
    if (config.tools?.custom) {
      for (const toolDef of config.tools.custom) {
        this.tools.register(buildTool(toolDef));
      }
    }

    // Wire feature flags to tool registry
    for (const [featureName] of Object.entries(this.features.getAll())) {
      if (this.features.isEnabled(featureName)) {
        this.tools.enableFeature(featureName);
      }
    }

    // Register hook middleware on commands
    this.commands.use(async (ctx) => {
      const { blocked, reason } = await this.hooks.emit(HOOK_EVENTS.BEFORE_MESSAGE, {
        agentId: ctx.agentId,
        chatId: ctx.chatId,
        text: ctx.rawText,
        isCommand: true,
      });
      if (blocked) {
        console.log(`[engine] Command blocked: ${reason}`);
        return false;
      }
      return true;
    });

    // v1.16.0 — Register compute tools
    if (feature('COMPUTE_TOOLS')) {
      try {
        this.computeTools = registerComputeTools(this.tools);
        console.log(`[engine] Compute tools: ${this.computeTools} registered`);
      } catch (err) {
        console.warn(`[engine] Compute tools failed to register: ${err.message}`);
      }
    }

    // v1.16.0 — Initialize model router with agent preferences
    if (feature('SMART_MODEL_ROUTING')) {
      const agents = config?.agents || {};
      for (const [agentId, agentConfig] of Object.entries(agents)) {
        if (agentConfig.model?.routing) {
          this.router.setAgentPreferences(agentId, {
            defaultModel: agentConfig.model?.default || 'sonnet',
            routing: agentConfig.model.routing,
          });
        }
      }
      console.log('[engine] Model router initialized');
    }

    // v1.16.0 — Verify API connectivity (non-blocking)
    if (feature('DIRECT_API')) {
      anthropic.healthCheck().then(status => {
        console.log(`[engine] Anthropic API: ${status.online ? 'ONLINE' : 'OFFLINE'} (${status.latency}ms)`);
      }).catch(() => {
        console.warn('[engine] Anthropic API health check failed');
      });
    }

    // v1.17.0 — Register skills as commands
    if (feature('SKILLS_ENGINE')) {
      const skillList = this.skills.list();
      for (const skill of skillList) {
        // Skills are accessible via /skillname — wire into command registry
        this.commands.register({
          name: skill.name,
          description: skill.description,
          category: 'skill',
          hidden: false,
          execute: async (ctx) => {
            const result = await this.skills.execute(`/${skill.name} ${ctx.args || ''}`.trim(), ctx);
            return result;
          },
        });
      }
      console.log(`[engine] Skills: ${skillList.length} registered`);

      // Load per-agent custom skills
      const agents = config?.agents || {};
      for (const agentId of Object.keys(agents)) {
        try { await loadAgentSkills(agentId); } catch {}
      }
    }

    // v1.17.0 — Wire memory extraction into after-response hook
    if (feature('EXTRACT_MEMORIES') && feature('HOOK_SYSTEM')) {
      this.hooks.on(HOOK_EVENTS.AFTER_RESPONSE, async (ctx) => {
        // Non-blocking memory extraction after each response
        const messages = [
          { role: 'user', content: ctx.text || '' },
          { role: 'assistant', content: ctx.response || '' },
        ];
        extractMemories(ctx.agentId, messages).catch(err => {
          console.warn(`[engine] Memory extraction error: ${err.message}`);
        });
      });
      console.log('[engine] Memory extraction: wired to after-response hook');
    }

    // v1.17.0 Phase 2 — Initialize reactive store with agent tracking
    if (feature('REACTIVE_STORE')) {
      const agents = config?.agents || {};
      for (const agentId of Object.keys(agents)) {
        createAgentStore(agentId);
      }
      this.store.setState({ activeAgents: Object.keys(agents) });
      console.log(`[engine] Reactive stores: ${listStores().length} created`);
    }

    // v1.17.0 Phase 2 — Task framework monitoring
    if (feature('TASK_FRAMEWORK')) {
      this.tasks.on('task:complete', (task) => {
        console.log(`[engine] Task completed: ${task.name} (${task.getDuration()}ms)`);
      });
      this.tasks.on('task:failed', (task) => {
        console.warn(`[engine] Task failed: ${task.name} — ${task.error}`);
      });
      console.log('[engine] Task framework: active');
    }

    this._initialized = true;
    console.log('[engine] Claude Engine v1.17.0 "Phoenix" initialized');
    console.log(`[engine] Tools: ${this.tools.getAll().length} registered`);
    console.log(`[engine] Commands: ${this.commands.getAll().length} registered`);
    console.log(`[engine] Hooks: ${Object.keys(this.hooks.listEvents()).length} events`);
  }

  /**
   * Process an incoming message through the full pipeline.
   *
   * @param {object} ctx
   * @param {string} ctx.agentId
   * @param {string} ctx.chatId
   * @param {string} ctx.text
   * @param {object} ctx.bot
   * @param {string} [ctx.mediaPath]
   * @param {object} [ctx.session]
   * @returns {Promise<{ type: string, result?: any, error?: string }>}
   */
  async processMessage(ctx) {
    const { agentId, chatId, text } = ctx;

    // Echo dedup check
    if (feature('ECHO_DEDUP') && this.dedup.isDuplicate(text, `${agentId}:${chatId}`)) {
      return { type: 'skipped', reason: 'duplicate' };
    }

    // Fire before-message hook
    if (feature('HOOK_SYSTEM')) {
      const hookResult = await this.hooks.emit(HOOK_EVENTS.BEFORE_MESSAGE, {
        agentId, chatId, text, mediaPath: ctx.mediaPath,
      });
      if (hookResult.blocked) {
        return { type: 'blocked', reason: hookResult.reason };
      }
    }

    // Check if it's a skill first (skills are context-aware, commands are simple)
    if (feature('SKILLS_ENGINE')) {
      const matchedSkill = this.skills.match(text);
      if (matchedSkill) {
        const skillResult = await this.skills.execute(text, {
          agentId, chatId, bot: ctx.bot,
          recentMessages: ctx.session?.messages || [],
        });
        if (skillResult.handled) {
          return { type: 'skill', result: skillResult.result };
        }
      }
    }

    // Check if it's a command
    if (feature('COMMAND_REGISTRY') && this.commands.isCommand(text)) {
      const cmdResult = await this.commands.execute(text, {
        agentId,
        chatId,
        bot: ctx.bot,
        config: this._config,
        session: ctx.session,
      });

      if (cmdResult.handled) {
        // Fire after-message hook
        if (feature('HOOK_SYSTEM')) {
          await this.hooks.emit(HOOK_EVENTS.AFTER_MESSAGE, {
            agentId, chatId, text, result: cmdResult,
          });
        }
        return { type: 'command', result: cmdResult.result, error: cmdResult.error };
      }
    }

    // Not a command — route and return context
    const routeInfo = feature('SMART_MODEL_ROUTING')
      ? await this.router.route(text, { agentId }).catch(() => null)
      : null;

    return {
      type: 'message',
      context: {
        agentId,
        chatId,
        text,
        mediaPath: ctx.mediaPath,
        allowedTools: this.getToolsForAgent(agentId),
        route: routeInfo,
      },
    };
  }

  /**
   * Execute a direct API call (bypasses CLI for speed).
   * v1.16.0 "Titan" feature.
   *
   * @param {string|Array} messages
   * @param {object} [opts]
   * @returns {Promise<{text: string, usage?: object, route?: object}>}
   */
  async directCall(messages, opts = {}) {
    if (!feature('DIRECT_API')) {
      throw new Error('DIRECT_API feature is disabled');
    }

    if (feature('SMART_MODEL_ROUTING') && !opts.model) {
      // Use router for model selection
      const text = typeof messages === 'string' ? messages : messages[messages.length - 1]?.content || '';
      return this.router.execute(text, opts);
    }

    return anthropic.chat(messages, opts);
  }

  /**
   * Stream a direct API response.
   * v1.16.0 "Titan" feature.
   */
  async *directStream(messages, opts = {}) {
    if (!feature('DIRECT_API')) {
      throw new Error('DIRECT_API feature is disabled');
    }

    if (feature('SMART_MODEL_ROUTING') && !opts.model) {
      const text = typeof messages === 'string' ? messages : messages[messages.length - 1]?.content || '';
      for await (const chunk of this.router.executeStream(text, opts)) {
        yield chunk;
      }
      return;
    }

    for await (const chunk of anthropic.stream(messages, opts)) {
      yield chunk;
    }
  }

  /**
   * Execute a compute tool.
   * v1.16.0 "Titan" feature.
   *
   * @param {string} toolName - e.g. 'compute-transcribe'
   * @param {object} input
   * @returns {Promise<object>}
   */
  async computeTool(toolName, input) {
    if (!feature('COMPUTE_TOOLS')) {
      throw new Error('COMPUTE_TOOLS feature is disabled');
    }
    return executeComputeTool(toolName, input);
  }

  /**
   * Quick classify/route using Haiku (cheapest model).
   * v1.16.0 "Titan" feature.
   */
  async classify(prompt, opts = {}) {
    if (!feature('DIRECT_API')) {
      throw new Error('DIRECT_API feature is disabled');
    }
    return anthropic.classify(prompt, opts);
  }

  /**
   * Get the --allowedTools list for an agent.
   * @param {string} agentId
   * @returns {string[]}
   */
  getToolsForAgent(agentId) {
    if (!feature('TOOL_REGISTRY')) {
      return []; // Fall back to default behavior
    }

    // Check if agent has a specific tool profile
    const agentConfig = this._config?.agents?.[agentId];
    const profileName = agentConfig?.toolProfile || 'developer';
    const profile = TOOL_PROFILES[profileName];

    if (profile) {
      return this.tools.assembleToolPool(profile);
    }

    return this.tools.assembleToolPool();
  }

  /**
   * Build an enhanced system prompt with smart memory recall.
   * @param {string} agentId
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
  async buildMemoryPrompt(agentId, userMessage) {
    if (feature('SMART_MEMORY_RECALL', agentId)) {
      return buildMemorySection(agentId, userMessage, {
        useAI: true,
        maxResults: 5,
      });
    }

    // Fallback to basic memory section
    return buildMemorySection(agentId, userMessage, {
      useAI: false,
      maxResults: 3,
    });
  }

  /**
   * Classify risk for a tool usage.
   * @param {string} toolName
   * @param {object} input
   * @returns {{ risk: string, reason: string }}
   */
  classifyToolRisk(toolName, input) {
    if (!feature('TOOL_RISK_CLASSIFICATION')) {
      return { risk: 'unknown', reason: 'Risk classification disabled' };
    }
    return this.tools.classifyRisk(toolName, input);
  }

  /**
   * Run before-tool hooks and check permissions.
   * @param {string} agentId
   * @param {string} toolName
   * @param {object} input
   * @returns {Promise<{ allowed: boolean, reason?: string }>}
   */
  async checkToolPermission(agentId, toolName, input) {
    // Feature gate
    if (!feature('HOOK_SYSTEM')) return { allowed: true };

    const hookResult = await this.hooks.emit(HOOK_EVENTS.BEFORE_TOOL_EXECUTE, {
      agentId,
      toolName,
      input,
    });

    if (hookResult.blocked) {
      return { allowed: false, reason: hookResult.reason };
    }

    // Risk classification
    if (feature('TOOL_RISK_CLASSIFICATION')) {
      const risk = this.tools.classifyRisk(toolName, input);
      if (risk.risk === 'dangerous') {
        return { allowed: false, reason: risk.reason };
      }
    }

    return { allowed: true };
  }

  /**
   * Mark a sent message for echo dedup.
   * @param {string|number} messageId
   * @param {string} content
   * @param {string} chatId
   */
  markSent(messageId, content, chatId) {
    if (feature('ECHO_DEDUP')) {
      if (messageId) this.dedup.mark(messageId);
      if (content) this.dedup.markContent(content, chatId);
    }
  }

  /**
   * Create a token budget for a task.
   * v1.17.0 "Phoenix" feature.
   *
   * @param {string} agentId
   * @param {string|object} effortOrOpts - 'quick'|'normal'|'thorough'|'exhaustive' or custom opts
   * @returns {TokenBudget}
   */
  createBudget(agentId, effortOrOpts = 'normal') {
    if (!feature('TOKEN_BUDGET')) {
      throw new Error('TOKEN_BUDGET feature is disabled');
    }
    if (typeof effortOrOpts === 'string') {
      return budgetFromEffort(agentId, effortOrOpts);
    }
    return createBudget(agentId, effortOrOpts);
  }

  /**
   * Compact a session's message history.
   * v1.17.0 "Phoenix" feature.
   *
   * @param {string} agentId
   * @param {Array} messages
   * @param {object} [opts]
   * @returns {Promise<{summary: string, recent: Array, compacted: number}>}
   */
  async compactSession(agentId, messages, opts = {}) {
    if (!feature('SESSION_COMPACT')) {
      return { summary: null, recent: messages, compacted: 0, saved: false };
    }
    return compactSession(agentId, messages, opts);
  }

  /**
   * Create a coordinator for multi-agent task orchestration.
   * v1.17.0 "Phoenix" Phase 2.
   *
   * @param {object} task - { description, subtasks: [{id, agent, prompt, dependencies?}] }
   * @param {object} [opts]
   * @returns {Promise<object>} Aggregated results
   */
  async coordinate(task, opts = {}) {
    if (!feature('COORDINATOR_MODE')) {
      throw new Error('COORDINATOR_MODE feature is disabled');
    }
    const coord = createCoordinator(task.coordinator || 'engine', {
      ...opts,
      dispatchFn: opts.dispatchFn || null,
    });
    return coord.dispatch(task);
  }

  /**
   * Run a function as a tracked background task.
   * v1.17.0 "Phoenix" Phase 2.
   *
   * @param {object} taskOpts - { name, agent, description, timeout }
   * @param {Function} fn - async (task) => result
   * @returns {Promise<any>}
   */
  async runTask(taskOpts, fn) {
    if (!feature('TASK_FRAMEWORK')) {
      return fn({ reportProgress: () => {}, signal: new AbortController().signal });
    }
    return runTask(taskOpts, fn);
  }

  /**
   * Get engine status for monitoring.
   * @returns {object}
   */
  getStatus() {
    return {
      initialized: this._initialized,
      version: '1.17.0',
      codename: 'Phoenix',
      tools: {
        registered: this.tools.getAll().length,
        features: [...this.tools._enabledFeatures || []],
        computeTools: listComputeTools(),
      },
      commands: {
        registered: this.commands.getAll({ includeHidden: true }).length,
      },
      hooks: this.hooks.listEvents(),
      features: this.features.summary(),
      dedup: this.dedup.getStats(),
      api: {
        directApiEnabled: feature('DIRECT_API'),
        costStats: feature('COST_TRACKING') ? anthropic.getCostStats() : null,
        models: anthropic.listModels(),
      },
      router: this.router.getStatus(),
      // v1.17.0 "Phoenix" systems
      skills: {
        registered: this.skills.list().length,
        stats: this.skills.getStats(),
      },
      memoryExtractor: this.memoryExtractor.getStats(),
      tokenBudgets: {
        active: getAllBudgets().size,
        budgets: [...getAllBudgets().entries()].map(([id, b]) => ({
          agentId: id, state: b.state, usage: b.statusLine(),
        })),
      },
      // v1.17.0 Phase 2 systems
      coordinator: {
        active: getAllCoordinators().size,
      },
      store: {
        stores: listStores(),
        global: this.store.getStats(),
      },
      tasks: this.tasks.getStats(),
    };
  }

  /**
   * Get comprehensive system health.
   * v1.16.0 "Titan" feature.
   */
  async getHealth() {
    const [apiHealth, providerStatus, computeStatus] = await Promise.allSettled([
      feature('DIRECT_API') ? anthropic.healthCheck() : { online: 'disabled' },
      feature('SMART_MODEL_ROUTING') ? getProviderStatus() : {},
      feature('COMPUTE_TOOLS') ? getComputeToolStatus() : { tools: [] },
    ]);

    return {
      engine: this._initialized ? 'running' : 'not-initialized',
      api: apiHealth.value || apiHealth.reason?.message,
      providers: providerStatus.value || providerStatus.reason?.message,
      compute: computeStatus.value || computeStatus.reason?.message,
      features: this.features.summary(),
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────
let _engine = null;

/**
 * Get or create the global engine instance.
 * @returns {ClaudeEngine}
 */
export function getEngine() {
  if (!_engine) {
    _engine = new ClaudeEngine();
  }
  return _engine;
}

// ── Re-exports for convenience ───────────────────────────────────────────
export {
  // v1.15.0 systems
  ToolRegistry, buildTool, getRegistry, TOOL_PROFILES,
  CommandRegistry, getCommandRegistry,
  HookManager, getHookManager, HOOK_EVENTS,
  recallMemories, buildMemorySection, formatMemoriesForPrompt,
  FeatureFlags, getFeatureFlags, feature,
  EchoDedup, getDedup,
  // v1.16.0 "Titan" systems
  anthropic,
  ModelRouter, getRouter, routeModel, getProviderStatus,
  registerComputeTools, executeComputeTool, getComputeToolStatus, listComputeTools,
  // v1.17.0 "Phoenix" Phase 1 systems
  TokenBudget, createBudget, getActiveBudget, clearBudget, budgetFromEffort, getAllBudgets,
  MemoryExtractor, getExtractor, extractMemories,
  SessionCompactor, getCompactor, compactSession,
  SkillsEngine, getSkillsEngine, loadAgentSkills,
  // v1.17.0 "Phoenix" Phase 2 systems
  Coordinator, createCoordinator, getCoordinator, getAllCoordinators,
  ReactiveStore, createStore, getStore, getGlobalStore, createAgentStore, listStores,
  TaskRegistry, getTaskRegistry, startTask, runTask, Task, TASK_STATE,
};

export default ClaudeEngine;
