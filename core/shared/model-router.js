/**
 * model-router.js — Smart Model Router for TamerClaw
 *
 * Routes requests to the best available model based on:
 *   - Task complexity (simple → Haiku, medium → Sonnet, hard → Opus)
 *   - Online/offline status (Claude API → local Ollama fallback)
 *   - Cost optimization (auto-downshift on rate limits)
 *   - Agent-specific preferences
 *   - Mac Mini local models as fallback
 *
 * Usage:
 *   import { route, selectModel, ModelRouter } from '../shared/model-router.js';
 *
 *   const model = await route('Fix this complex bug in the auth system');
 *   // → { provider: 'anthropic', model: 'claude-opus-4-6', reason: 'complex-task' }
 *
 *   const model = await route('What time is it?');
 *   // → { provider: 'anthropic', model: 'claude-haiku-4-5', reason: 'simple-query' }
 */

import { chat, classify, resolveModel, getModelInfo, healthCheck as anthropicHealth, MODELS } from './anthropic-client.js';
import { isNodeAvailable, compute } from './compute.js';
import { feature } from './feature-flags.js';

// ── Complexity Patterns ─────────────────────────────────────────────────

const COMPLEXITY_PATTERNS = {
  opus: [
    // Architecture & planning
    /\b(architect|design.*system|design.*architecture|plan|strategy|refactor entire|migration plan)\b/i,
    // Deep analysis
    /\b(analyze.*code|debug.*complex|investigate|research|deep dive)\b/i,
    // Multi-step reasoning
    /\b(step by step|chain of thought|reason through|think carefully)\b/i,
    // Large scope
    /\b(rewrite|rebuild|overhaul|redesign|from scratch|entire|microservice)\b/i,
    // Security & performance
    /\b(security audit|performance.*optim|vulnerability|exploit)\b/i,
    // Complexity keywords
    /\b(complex|comprehensive|full.*stack|end.to.end|production.ready)\b/i,
  ],
  sonnet: [
    // Coding
    /\b(write|implement|create|build|code|function|class|component)\b/i,
    // Fixing
    /\b(fix|patch|resolve|update|modify|change|edit)\b/i,
    // Explanation
    /\b(explain|describe|how does|what is|tell me about)\b/i,
    // General tasks
    /\b(test|deploy|setup|configure|install)\b/i,
  ],
  haiku: [
    // Simple queries
    /\b(yes or no|true or false|which one|pick|choose)\b/i,
    // Classification
    /\b(classify|categorize|label|tag|sort)\b/i,
    // Short answers
    /\b(what time|what date|how many|count|list)\b/i,
    // Translations
    /\b(translate|convert|format)\b/i,
    // Greetings
    /^(hi|hello|hey|ping|test|ok|thanks|bye)/i,
  ],
};

// ── Provider Configs ────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic Claude API',
    type: 'online',
    priority: 1,
    models: Object.keys(MODELS),
    healthCheck: anthropicHealth,
    _lastHealth: null,
    _healthTTL: 60_000, // Cache health for 1 min
  },

  ollama_local: {
    name: 'Ollama (Server Local)',
    type: 'local',
    priority: 2,
    models: ['qwen2.5:7b', 'deepseek-coder:6.7b'],
    baseUrl: 'http://127.0.0.1:11434',
    async healthCheck() {
      try {
        const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        const data = await resp.json();
        return { online: true, models: data.models?.map(m => m.name) || [] };
      } catch {
        return { online: false, models: [] };
      }
    },
    _lastHealth: null,
    _healthTTL: 30_000,
  },

  ollama_mac: {
    name: 'Ollama (Mac Mini M1)',
    type: 'remote-local',
    priority: 3,
    models: [], // populated dynamically
    async healthCheck() {
      try {
        const available = await isNodeAvailable('mac-mini');
        if (!available) return { online: false, models: [] };
        const result = await compute('mac-mini', 'ollama list 2>/dev/null | tail -n +2 | awk \'{print $1}\'', { timeout: 10000 });
        const models = result.stdout?.trim().split('\n').filter(Boolean) || [];
        return { online: true, models };
      } catch {
        return { online: false, models: [] };
      }
    },
    _lastHealth: null,
    _healthTTL: 30_000,
  },
};

// ── Complexity Classifier ───────────────────────────────────────────────

/**
 * Classify message complexity: 'simple', 'medium', 'complex'
 * @param {string} text
 * @param {object} [context]
 * @returns {string}
 */
function classifyComplexity(text, context = {}) {
  if (!text) return 'medium';

  const length = text.length;

  // Short messages → likely simple, unless they match higher patterns
  if (length < 30) {
    if (COMPLEXITY_PATTERNS.opus.some(p => p.test(text))) return 'complex';
    if (COMPLEXITY_PATTERNS.sonnet.some(p => p.test(text))) return 'medium';
    return 'simple';
  }

  // Check opus patterns
  const opusScore = COMPLEXITY_PATTERNS.opus.filter(p => p.test(text)).length;
  if (opusScore >= 2) return 'complex';

  // Check haiku patterns
  const haikuScore = COMPLEXITY_PATTERNS.haiku.filter(p => p.test(text)).length;
  if (haikuScore >= 1 && length < 100) return 'simple';

  // Long messages are likely medium+
  if (length > 500) return 'complex';
  if (length > 200) return 'medium';

  // Check sonnet patterns
  const sonnetScore = COMPLEXITY_PATTERNS.sonnet.filter(p => p.test(text)).length;
  if (sonnetScore >= 1) return 'medium';

  return 'medium';
}

/**
 * AI-powered complexity classification (uses Haiku side-query).
 * Only used when SMART_MODEL_ROUTING feature is enabled.
 *
 * @param {string} text
 * @returns {Promise<string>} 'simple' | 'medium' | 'complex'
 */
async function aiClassifyComplexity(text) {
  try {
    const result = await classify(
      `Classify this user message complexity for AI model routing.
Reply with ONLY one word: simple, medium, or complex.

- simple: greetings, yes/no questions, translations, simple lookups
- medium: coding tasks, explanations, standard questions, bug fixes
- complex: architecture, multi-step analysis, security audits, rewrites, research

Message: "${text.slice(0, 500)}"`,
      { maxTokens: 10 }
    );
    const level = result.toLowerCase().trim();
    if (['simple', 'medium', 'complex'].includes(level)) return level;
    return 'medium';
  } catch {
    // Fallback to pattern matching
    return classifyComplexity(text);
  }
}

// ── Provider Health ─────────────────────────────────────────────────────

async function checkProviderHealth(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { online: false };

  // Cache
  if (provider._lastHealth && (Date.now() - provider._lastHealth.timestamp) < provider._healthTTL) {
    return provider._lastHealth.result;
  }

  const result = await provider.healthCheck();
  provider._lastHealth = { result, timestamp: Date.now() };
  return result;
}

/**
 * Get all provider statuses.
 */
export async function getProviderStatus() {
  const statuses = {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    statuses[id] = {
      name: provider.name,
      type: provider.type,
      priority: provider.priority,
      ...(await checkProviderHealth(id)),
    };
  }
  return statuses;
}

// ── Model Selection ─────────────────────────────────────────────────────

/**
 * Map complexity to model tier.
 */
function complexityToModel(complexity) {
  switch (complexity) {
    case 'simple': return 'haiku';
    case 'complex': return 'opus';
    default: return 'sonnet';
  }
}

/**
 * Map Claude model to Ollama equivalent.
 */
function claudeToOllama(claudeModel, availableModels = []) {
  // Best available fallbacks
  if (availableModels.includes('qwen2.5:7b')) return 'qwen2.5:7b';
  if (availableModels.includes('deepseek-coder:6.7b')) return 'deepseek-coder:6.7b';
  return availableModels[0] || null;
}

// ── Router Class ────────────────────────────────────────────────────────

export class ModelRouter {
  constructor(opts = {}) {
    this._agentPreferences = new Map(); // agentId → { defaultModel, routing }
    this._fallbackChain = opts.fallbackChain || ['anthropic', 'ollama_local', 'ollama_mac'];
    this._rateLimitUntil = null; // Timestamp when rate limit expires
    this._downshifted = false;
  }

  /**
   * Set model preferences for an agent.
   */
  setAgentPreferences(agentId, prefs) {
    this._agentPreferences.set(agentId, prefs);
  }

  /**
   * Smart route: determine best model + provider for a message.
   *
   * @param {string} text - User message
   * @param {object} [opts]
   * @param {string} [opts.agentId]
   * @param {string} [opts.forceModel] - Force specific model
   * @param {string} [opts.forceProvider] - Force specific provider
   * @param {boolean} [opts.useAI=false] - Use AI classification
   * @returns {Promise<{provider: string, model: string, complexity: string, reason: string}>}
   */
  async route(text, opts = {}) {
    // Force model override
    if (opts.forceModel) {
      return {
        provider: opts.forceProvider || 'anthropic',
        model: resolveModel(opts.forceModel),
        complexity: 'forced',
        reason: 'force-override',
      };
    }

    // Classify complexity
    const complexity = (opts.useAI && feature('SMART_MODEL_ROUTING'))
      ? await aiClassifyComplexity(text)
      : classifyComplexity(text);

    // Determine target model
    let targetModel = complexityToModel(complexity);

    // Agent preferences override
    if (opts.agentId) {
      const prefs = this._agentPreferences.get(opts.agentId);
      if (prefs?.routing) {
        const routeConfig = prefs.routing[complexity] || prefs.routing.default;
        if (routeConfig) targetModel = routeConfig;
      }
    }

    // Rate limit downshift
    if (this._rateLimitUntil && Date.now() < this._rateLimitUntil) {
      if (targetModel === 'opus') targetModel = 'sonnet';
      this._downshifted = true;
    }

    // Try providers in fallback chain order
    for (const providerId of this._fallbackChain) {
      if (opts.forceProvider && opts.forceProvider !== providerId) continue;

      const health = await checkProviderHealth(providerId);
      if (!health.online) continue;

      if (providerId === 'anthropic') {
        return {
          provider: 'anthropic',
          model: resolveModel(targetModel),
          complexity,
          reason: `${complexity}-task`,
          downshifted: this._downshifted,
        };
      }

      // Ollama providers
      if (providerId.startsWith('ollama')) {
        const ollamaModel = claudeToOllama(targetModel, health.models);
        if (ollamaModel) {
          return {
            provider: providerId,
            model: ollamaModel,
            complexity,
            reason: `fallback-${providerId}`,
            originalModel: resolveModel(targetModel),
          };
        }
      }
    }

    // Everything offline — return best guess anyway
    return {
      provider: 'anthropic',
      model: resolveModel(targetModel),
      complexity,
      reason: 'all-offline-best-effort',
    };
  }

  /**
   * Execute a routed call — sends to the right provider.
   *
   * @param {string} text
   * @param {object} [opts]
   * @returns {Promise<{text: string, route: object, usage?: object}>}
   */
  async execute(text, opts = {}) {
    const route = await this.route(text, opts);

    if (route.provider === 'anthropic') {
      try {
        const result = await chat(text, {
          model: route.model,
          system: opts.system,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
        });
        return { text: result.text, route, usage: result.usage };
      } catch (error) {
        if (error?.status === 429) {
          // Rate limited — downshift for 60s
          this._rateLimitUntil = Date.now() + 60_000;
          console.log('[router] Rate limited, downshifting for 60s');
        }
        throw error;
      }
    }

    if (route.provider === 'ollama_local') {
      return this._callOllamaLocal(text, route, opts);
    }

    if (route.provider === 'ollama_mac') {
      return this._callOllamaMac(text, route, opts);
    }

    throw new Error(`Unknown provider: ${route.provider}`);
  }

  /**
   * Execute streaming routed call.
   */
  async *executeStream(text, opts = {}) {
    const route = await this.route(text, opts);

    if (route.provider === 'anthropic') {
      const { stream: streamFn } = await import('./anthropic-client.js');
      for await (const chunk of streamFn(text, {
        model: route.model,
        system: opts.system,
        maxTokens: opts.maxTokens,
      })) {
        yield { ...chunk, route };
      }
      return;
    }

    // Ollama streaming
    if (route.provider.startsWith('ollama')) {
      const result = await this.execute(text, opts);
      yield { type: 'text', text: result.text, delta: result.text, route };
      yield { type: 'done', route };
    }
  }

  // ── Private: Ollama Calls ──────────────────────────────────────────────

  async _callOllamaLocal(text, route, opts) {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: route.model,
          prompt: opts.system ? `${opts.system}\n\nUser: ${text}` : text,
          stream: false,
          options: {
            temperature: opts.temperature ?? 0.7,
            num_predict: opts.maxTokens ?? 4096,
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await response.json();
      return { text: data.response, route, usage: { input_tokens: 0, output_tokens: 0 } };
    } catch (error) {
      throw new Error(`Ollama local error: ${error.message}`);
    }
  }

  async _callOllamaMac(text, route, opts) {
    try {
      const prompt = opts.system ? `${opts.system}\\n\\nUser: ${text}` : text;
      const escaped = prompt.replace(/'/g, "'\\''");
      const result = await compute('mac-mini',
        `ollama run ${route.model} '${escaped}'`,
        { timeout: 120_000 }
      );
      return { text: result.stdout?.trim() || '', route, usage: { input_tokens: 0, output_tokens: 0 } };
    } catch (error) {
      throw new Error(`Ollama Mac Mini error: ${error.message}`);
    }
  }

  /**
   * Get router status for monitoring.
   */
  getStatus() {
    return {
      rateLimited: this._rateLimitUntil ? Date.now() < this._rateLimitUntil : false,
      downshifted: this._downshifted,
      agentPreferences: Object.fromEntries(this._agentPreferences),
      fallbackChain: this._fallbackChain,
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────────
let _router = null;

export function getRouter() {
  if (!_router) {
    _router = new ModelRouter();
  }
  return _router;
}

/**
 * Quick route helper — main API for most code.
 */
export async function route(text, opts = {}) {
  return getRouter().route(text, opts);
}

/**
 * Quick execute helper — route + call in one.
 */
export async function execute(text, opts = {}) {
  return getRouter().execute(text, opts);
}

// ── Re-exports ──────────────────────────────────────────────────────────
export { classifyComplexity };

export default ModelRouter;
