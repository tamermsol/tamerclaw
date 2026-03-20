/**
 * Proactive Rate Limit Tracker
 *
 * Tracks Claude CLI invocations per model in a sliding window.
 * When usage approaches the configured threshold, proactively downshifts
 * to a lower-tier model BEFORE hitting a 429.
 *
 * Downshift chain: opus → sonnet → haiku
 *
 * Usage:
 *   import { recordUsage, resolveModelWithRateCheck } from './rate-tracker.js';
 *
 *   // Before invoking Claude CLI:
 *   const { model, downshifted, reason } = resolveModelWithRateCheck('opus');
 *   // model = 'opus' (if within budget) or 'sonnet'/'haiku' (if approaching limit)
 *
 *   // After invocation completes:
 *   recordUsage('opus');  // record against the REQUESTED model, not the resolved one
 */

import fs from 'fs';
import { paths } from './paths.js';

const TRACKER_FILE = paths.rateUsage;
const CONFIG_FILE = paths.config;

// ── Downshift Chain ──────────────────────────────────────────────────────────
// Order matters: first = highest tier, last = lowest tier
const MODEL_CHAIN = ['opus', 'sonnet', 'haiku'];

// ── Default Rate Limits ──────────────────────────────────────────────────────
// These are conservative defaults. Override in config.json under "rateLimits".
// windowMs: sliding window size in milliseconds
// maxRequests: max requests allowed in that window per model
// threshold: fraction (0-1) at which to start downshifting (e.g., 0.8 = 80%)
const DEFAULT_LIMITS = {
  opus:   { windowMs: 60000, maxRequests: 10, threshold: 0.75 },
  sonnet: { windowMs: 60000, maxRequests: 20, threshold: 0.80 },
  haiku:  { windowMs: 60000, maxRequests: 40, threshold: 0.85 }
};

// ── State Management ─────────────────────────────────────────────────────────

function loadUsage() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8'));
    }
  } catch {}
  return { opus: [], sonnet: [], haiku: [] };
}

function saveUsage(usage) {
  try {
    const tmp = TRACKER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(usage));
    fs.renameSync(tmp, TRACKER_FILE);
  } catch (e) {
    console.error('[rate-tracker] Failed to save:', e.message);
  }
}

function loadRateLimits() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const configured = config.rateLimits || {};
    // Merge with defaults
    const limits = {};
    for (const model of MODEL_CHAIN) {
      limits[model] = { ...DEFAULT_LIMITS[model], ...(configured[model] || {}) };
    }
    return limits;
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Prune timestamps outside the sliding window.
 */
function pruneWindow(timestamps, windowMs) {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

/**
 * Record a usage event for a model.
 * Call this AFTER a Claude CLI invocation completes (or starts).
 *
 * @param {string} model - CLI flag: 'opus', 'sonnet', or 'haiku'
 */
export function recordUsage(model) {
  const normalizedModel = normalizeModel(model);
  if (!normalizedModel) return;

  const usage = loadUsage();
  if (!usage[normalizedModel]) usage[normalizedModel] = [];
  usage[normalizedModel].push(Date.now());

  // Prune old entries while we're here
  const limits = loadRateLimits();
  for (const m of MODEL_CHAIN) {
    if (usage[m]) {
      const windowMs = limits[m]?.windowMs || 60000;
      usage[m] = pruneWindow(usage[m], windowMs);
    }
  }

  saveUsage(usage);
  console.log(`[rate-tracker] Recorded ${normalizedModel} usage (${usage[normalizedModel].length} in window)`);
}

/**
 * Get current usage stats for all models.
 * @returns {{ opus: { count, max, threshold, pct }, sonnet: {...}, haiku: {...} }}
 */
export function getUsageStats() {
  const usage = loadUsage();
  const limits = loadRateLimits();
  const stats = {};

  for (const model of MODEL_CHAIN) {
    const windowMs = limits[model]?.windowMs || 60000;
    const active = pruneWindow(usage[model] || [], windowMs);
    const max = limits[model]?.maxRequests || 999;
    const threshold = limits[model]?.threshold || 0.8;
    stats[model] = {
      count: active.length,
      max,
      threshold,
      pct: active.length / max,
      nearLimit: active.length >= Math.floor(max * threshold),
      atLimit: active.length >= max,
      windowMs
    };
  }

  return stats;
}

/**
 * Check if a model is approaching its rate limit.
 * @param {string} model - CLI flag
 * @returns {{ nearLimit: boolean, atLimit: boolean, count: number, max: number, pct: number }}
 */
export function checkModelHealth(model) {
  const normalizedModel = normalizeModel(model);
  if (!normalizedModel) return { nearLimit: false, atLimit: false, count: 0, max: 999, pct: 0 };

  const stats = getUsageStats();
  return stats[normalizedModel] || { nearLimit: false, atLimit: false, count: 0, max: 999, pct: 0 };
}

/**
 * Proactively resolve the best available model, downshifting if needed.
 *
 * This is the main function to call BEFORE invoking Claude CLI.
 * It checks if the requested model is approaching its rate limit,
 * and if so, returns a lower-tier model.
 *
 * @param {string} requestedModel - The model you WANT to use (CLI flag: 'opus', 'sonnet', 'haiku')
 * @param {object} [options] - Optional overrides
 * @param {boolean} [options.forceOriginal=false] - Never downshift (for critical agents like trading)
 * @returns {{ model: string, downshifted: boolean, reason: string|null, stats: object }}
 */
export function resolveModelWithRateCheck(requestedModel, options = {}) {
  const normalizedRequested = normalizeModel(requestedModel);
  if (!normalizedRequested || options.forceOriginal) {
    return { model: requestedModel, downshifted: false, reason: null, stats: {} };
  }

  const stats = getUsageStats();
  const requestedStats = stats[normalizedRequested];

  // If we're within budget, use requested model
  if (!requestedStats?.nearLimit) {
    return {
      model: requestedModel,
      downshifted: false,
      reason: null,
      stats: requestedStats
    };
  }

  // Need to downshift — find next available model in the chain
  const requestedIndex = MODEL_CHAIN.indexOf(normalizedRequested);

  for (let i = requestedIndex + 1; i < MODEL_CHAIN.length; i++) {
    const candidate = MODEL_CHAIN[i];
    const candidateStats = stats[candidate];

    if (!candidateStats?.nearLimit) {
      const reason = `${normalizedRequested} at ${Math.round(requestedStats.pct * 100)}% capacity (${requestedStats.count}/${requestedStats.max}) → downshifted to ${candidate}`;
      console.log(`[rate-tracker] Proactive downshift: ${reason}`);
      return {
        model: candidate,
        downshifted: true,
        reason,
        stats: { requested: requestedStats, resolved: candidateStats }
      };
    }
  }

  // All models near limit — use the lowest tier anyway (haiku has highest limits)
  const lastModel = MODEL_CHAIN[MODEL_CHAIN.length - 1];
  const reason = `All models near limit — using ${lastModel} as last resort`;
  console.log(`[rate-tracker] ${reason}`);
  return {
    model: lastModel,
    downshifted: normalizedRequested !== lastModel,
    reason,
    stats
  };
}

/**
 * Get recommended wait time if all models are at capacity.
 * Returns 0 if at least one model is available.
 * @returns {number} milliseconds to wait
 */
export function getRecommendedWait() {
  const usage = loadUsage();
  const limits = loadRateLimits();

  for (const model of MODEL_CHAIN) {
    const windowMs = limits[model]?.windowMs || 60000;
    const max = limits[model]?.maxRequests || 999;
    const active = pruneWindow(usage[model] || [], windowMs);
    if (active.length < max) return 0; // This model has capacity
  }

  // All models at capacity — find earliest expiring entry
  let earliestExpiry = Infinity;
  for (const model of MODEL_CHAIN) {
    const windowMs = limits[model]?.windowMs || 60000;
    const timestamps = usage[model] || [];
    if (timestamps.length > 0) {
      const oldest = Math.min(...timestamps);
      const expiry = oldest + windowMs;
      if (expiry < earliestExpiry) earliestExpiry = expiry;
    }
  }

  return Math.max(0, earliestExpiry - Date.now());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeModel(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  // Direct match
  if (MODEL_CHAIN.includes(m)) return m;
  return null;
}

/**
 * Reset usage data (for testing or manual recovery).
 */
export function resetUsage() {
  saveUsage({ opus: [], sonnet: [], haiku: [] });
  console.log('[rate-tracker] Usage data reset');
}

/**
 * Format a human-readable status string.
 */
export function formatStatus() {
  const stats = getUsageStats();
  const lines = ['Rate Limit Status:'];
  for (const model of MODEL_CHAIN) {
    const s = stats[model];
    const indicator = s.atLimit ? '[RED]' : s.nearLimit ? '[YEL]' : '[GRN]';
    lines.push(`${indicator} ${model}: ${s.count}/${s.max} (${Math.round(s.pct * 100)}%) in ${s.windowMs / 1000}s window`);
  }
  return lines.join('\n');
}
