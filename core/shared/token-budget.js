/**
 * token-budget.js — Token Budget Tracker for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's auto-continue / token budget system.
 * Gives agents "use X effort on this" capability by:
 *   - Tracking tokens spent per conversation turn
 *   - Auto-continuing the model until a budget is exhausted
 *   - Detecting diminishing returns (< threshold tokens/turn for N turns)
 *   - Supporting per-agent and per-task budgets
 *   - Providing budget exhaustion callbacks
 *
 * Usage:
 *   import { TokenBudget, createBudget, getActiveBudget } from './token-budget.js';
 *
 *   const budget = createBudget('agent-id', {
 *     maxTokens: 50000,           // Total budget
 *     diminishingThreshold: 500,  // Min useful tokens per turn
 *     diminishingStreak: 3,       // Streak length to trigger stop
 *     autoExtend: false,          // Don't auto-extend
 *   });
 *
 *   budget.recordTurn({ inputTokens: 1200, outputTokens: 3500 });
 *   budget.shouldContinue(); // true/false
 */

// ── Budget States ───────────────────────────────────────────────────────
export const BUDGET_STATE = {
  ACTIVE: 'active',
  EXHAUSTED: 'exhausted',
  DIMINISHED: 'diminished',   // Stopped due to diminishing returns
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};

// ── Defaults ────────────────────────────────────────────────────────────
const DEFAULT_OPTS = {
  maxTokens: 100000,           // 100k token budget
  maxTurns: 50,                // Safety cap on turns
  diminishingThreshold: 500,   // If output < 500 tokens
  diminishingStreak: 3,        // ...for 3 consecutive turns → stop
  warningAt: 0.8,              // Warn at 80% usage
  autoExtend: false,           // Don't auto-extend by default
  autoExtendAmount: 25000,     // If auto-extend, add 25k
  maxExtensions: 2,            // Max 2 auto-extensions
  costLimit: null,             // Optional $ cost limit (uses model pricing)
};

// ── Model Pricing (per 1M tokens) ──────────────────────────────────────
const PRICING = {
  'opus':   { input: 15.00, output: 75.00 },
  'sonnet': { input: 3.00,  output: 15.00 },
  'haiku':  { input: 0.25,  output: 1.25 },
};

// ── TokenBudget Class ───────────────────────────────────────────────────
export class TokenBudget {
  /**
   * @param {string} agentId
   * @param {object} opts
   */
  constructor(agentId, opts = {}) {
    this.agentId = agentId;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.state = BUDGET_STATE.ACTIVE;

    // Counters
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalTokens = 0;
    this.turns = [];
    this.extensions = 0;
    this.estimatedCost = 0;

    // Tracking
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.taskDescription = opts.taskDescription || null;

    // Callbacks
    this._onWarning = opts.onWarning || null;
    this._onExhausted = opts.onExhausted || null;
    this._onDiminished = opts.onDiminished || null;
  }

  /**
   * Record a completed turn.
   * @param {object} usage
   * @param {number} usage.inputTokens
   * @param {number} usage.outputTokens
   * @param {string} [usage.model] - For cost calculation
   * @returns {{ continued: boolean, reason?: string, remaining: number }}
   */
  recordTurn(usage) {
    const { inputTokens = 0, outputTokens = 0, model = 'sonnet' } = usage;
    const turnTotal = inputTokens + outputTokens;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalTokens += turnTotal;
    this.updatedAt = Date.now();

    // Calculate cost
    const pricing = PRICING[model] || PRICING.sonnet;
    const turnCost = (inputTokens / 1_000_000 * pricing.input) +
                     (outputTokens / 1_000_000 * pricing.output);
    this.estimatedCost += turnCost;

    this.turns.push({
      index: this.turns.length,
      inputTokens,
      outputTokens,
      total: turnTotal,
      cost: turnCost,
      model,
      timestamp: Date.now(),
    });

    // Check diminishing returns
    const diminished = this._checkDiminishing(outputTokens);
    if (diminished) {
      this.state = BUDGET_STATE.DIMINISHED;
      this._onDiminished?.({
        streak: this.opts.diminishingStreak,
        avgOutput: this._recentAvgOutput(),
        budget: this,
      });
      return { continued: false, reason: 'diminishing_returns', remaining: this._remaining() };
    }

    // Check budget exhaustion
    if (this.totalTokens >= this.opts.maxTokens) {
      // Try auto-extend
      if (this.opts.autoExtend && this.extensions < this.opts.maxExtensions) {
        this.opts.maxTokens += this.opts.autoExtendAmount;
        this.extensions++;
        return { continued: true, reason: 'auto_extended', remaining: this._remaining() };
      }

      this.state = BUDGET_STATE.EXHAUSTED;
      this._onExhausted?.({ budget: this });
      return { continued: false, reason: 'budget_exhausted', remaining: 0 };
    }

    // Check cost limit
    if (this.opts.costLimit && this.estimatedCost >= this.opts.costLimit) {
      this.state = BUDGET_STATE.EXHAUSTED;
      this._onExhausted?.({ budget: this, reason: 'cost_limit' });
      return { continued: false, reason: 'cost_limit', remaining: this._remaining() };
    }

    // Check turn limit
    if (this.turns.length >= this.opts.maxTurns) {
      this.state = BUDGET_STATE.EXHAUSTED;
      return { continued: false, reason: 'max_turns', remaining: this._remaining() };
    }

    // Warning check
    if (this._usagePercent() >= this.opts.warningAt && this.turns.length > 1) {
      this._onWarning?.({
        percentUsed: this._usagePercent(),
        remaining: this._remaining(),
        budget: this,
      });
    }

    return { continued: true, remaining: this._remaining() };
  }

  /**
   * Should the agent continue working?
   * @returns {boolean}
   */
  shouldContinue() {
    return this.state === BUDGET_STATE.ACTIVE;
  }

  /**
   * Mark the budget as completed (task finished within budget).
   */
  complete() {
    this.state = BUDGET_STATE.COMPLETED;
    this.updatedAt = Date.now();
  }

  /**
   * Cancel the budget (user/system cancellation).
   */
  cancel() {
    this.state = BUDGET_STATE.CANCELLED;
    this.updatedAt = Date.now();
  }

  /**
   * Get a human-readable status.
   * @returns {string}
   */
  statusLine() {
    const pct = Math.round(this._usagePercent() * 100);
    const remaining = this._remaining();
    const turns = this.turns.length;
    const cost = this.estimatedCost.toFixed(4);

    return `[Budget ${this.state}] ${pct}% used | ${remaining} tokens left | ${turns} turns | ~$${cost}`;
  }

  /**
   * Get comprehensive stats.
   * @returns {object}
   */
  getStats() {
    return {
      agentId: this.agentId,
      state: this.state,
      totalTokens: this.totalTokens,
      maxTokens: this.opts.maxTokens,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      turns: this.turns.length,
      maxTurns: this.opts.maxTurns,
      extensions: this.extensions,
      estimatedCost: this.estimatedCost,
      costLimit: this.opts.costLimit,
      usagePercent: this._usagePercent(),
      remaining: this._remaining(),
      avgOutputPerTurn: this.turns.length > 0
        ? Math.round(this.totalOutputTokens / this.turns.length)
        : 0,
      duration: Date.now() - this.createdAt,
      taskDescription: this.taskDescription,
    };
  }

  /**
   * Suggest an effort level for a task.
   * @param {string} effort - 'quick', 'normal', 'thorough', 'exhaustive'
   * @returns {object} Budget configuration
   */
  static effortPreset(effort) {
    const presets = {
      quick:      { maxTokens: 10000,  maxTurns: 5,   diminishingStreak: 2 },
      normal:     { maxTokens: 50000,  maxTurns: 20,  diminishingStreak: 3 },
      thorough:   { maxTokens: 150000, maxTurns: 40,  diminishingStreak: 4 },
      exhaustive: { maxTokens: 500000, maxTurns: 100, diminishingStreak: 5, autoExtend: true },
    };
    return presets[effort] || presets.normal;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _remaining() {
    return Math.max(0, this.opts.maxTokens - this.totalTokens);
  }

  _usagePercent() {
    return this.totalTokens / this.opts.maxTokens;
  }

  _recentAvgOutput() {
    const n = this.opts.diminishingStreak;
    const recent = this.turns.slice(-n);
    if (recent.length === 0) return 0;
    return recent.reduce((s, t) => s + t.outputTokens, 0) / recent.length;
  }

  _checkDiminishing(outputTokens) {
    if (this.turns.length < this.opts.diminishingStreak) return false;

    const n = this.opts.diminishingStreak;
    const recent = this.turns.slice(-n);

    return recent.every(t => t.outputTokens < this.opts.diminishingThreshold);
  }
}

// ── Budget Manager (active budgets per agent) ───────────────────────────
const _activeBudgets = new Map();

/**
 * Create a new token budget for an agent.
 * @param {string} agentId
 * @param {object} opts
 * @returns {TokenBudget}
 */
export function createBudget(agentId, opts = {}) {
  const budget = new TokenBudget(agentId, opts);
  _activeBudgets.set(agentId, budget);
  return budget;
}

/**
 * Get the active budget for an agent (if any).
 * @param {string} agentId
 * @returns {TokenBudget|null}
 */
export function getActiveBudget(agentId) {
  const budget = _activeBudgets.get(agentId);
  if (budget && budget.shouldContinue()) return budget;
  return null;
}

/**
 * Clear the active budget for an agent.
 * @param {string} agentId
 */
export function clearBudget(agentId) {
  _activeBudgets.delete(agentId);
}

/**
 * Get all active budgets.
 * @returns {Map<string, TokenBudget>}
 */
export function getAllBudgets() {
  return new Map(_activeBudgets);
}

/**
 * Create a budget from an effort level string.
 * @param {string} agentId
 * @param {string} effort - 'quick', 'normal', 'thorough', 'exhaustive'
 * @param {object} [extra] - Additional overrides
 * @returns {TokenBudget}
 */
export function budgetFromEffort(agentId, effort, extra = {}) {
  const preset = TokenBudget.effortPreset(effort);
  return createBudget(agentId, { ...preset, ...extra });
}

export default TokenBudget;
