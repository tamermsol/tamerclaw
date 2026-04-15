/**
 * Account Rate Limit — Shared module for real Claude API rate limit tracking
 *
 * Persists account-level rate limit data to disk so ALL agents (bridge + standalone)
 * share the same data. Updated from rate_limit_event events in Claude CLI stream output.
 *
 * Usage:
 *   import { updateAccountRateLimit, getAccountRateLimit, formatAccountRateLimit, formatRateLineCompact } from '../../shared/account-ratelimit.js';
 *
 *   // When processing stream events:
 *   if (event.type === 'rate_limit_event' && event.rate_limit_info) {
 *     updateAccountRateLimit(event.rate_limit_info, agentId);
 *   }
 *
 *   // In /usage or /ratelimit command:
 *   const formatted = formatAccountRateLimit();
 *
 *   // In streaming progress:
 *   const line = formatRateLineCompact();
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Store rate limit data under user/ (runtime state) — resolve from paths if available, else sibling dir
let RATELIMIT_FILE;
try {
  const { default: paths } = await import('./paths.js');
  RATELIMIT_FILE = path.join(paths.user, 'account-ratelimit.json');
} catch {
  RATELIMIT_FILE = path.join(__dirname, '..', '..', 'user', 'account-ratelimit.json');
}

// In-memory cache (avoids disk reads on every format call)
let cache = null;
let cacheAge = 0;

function loadFromDisk() {
  try {
    if (fs.existsSync(RATELIMIT_FILE)) {
      const data = JSON.parse(fs.readFileSync(RATELIMIT_FILE, 'utf-8'));
      cache = data;
      cacheAge = Date.now();
      return data;
    }
  } catch {}
  return null;
}

function saveToDisk(data) {
  try {
    const tmp = RATELIMIT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, RATELIMIT_FILE);
  } catch (e) {
    console.error('[account-ratelimit] Failed to save:', e.message);
  }
}

/**
 * Get current account rate limit data.
 * Reads from memory cache, falls back to disk.
 */
export function getAccountRateLimit() {
  // Use cache if fresh (< 5s old)
  if (cache && (Date.now() - cacheAge) < 5000) return { ...cache };
  const fromDisk = loadFromDisk();
  if (fromDisk) return { ...fromDisk };
  return {
    lastUpdated: 0,
    status: null,
    resetsAt: null,
    rateLimitType: null,
    utilization: null,
    overageStatus: null,
    overageResetsAt: null,
    isUsingOverage: null,
    surpassedThreshold: null,
    overageDisabledReason: null,
    updatedBy: null,
  };
}

/**
 * Update account rate limit from a rate_limit_event.
 * Writes to both memory cache and disk.
 *
 * @param {object} rateLimitInfo - The rate_limit_info from a rate_limit_event
 * @param {string} [agentId] - Which agent triggered this update
 */
export function updateAccountRateLimit(rateLimitInfo, agentId = null) {
  if (!rateLimitInfo) return;

  const current = getAccountRateLimit();
  const rl = rateLimitInfo;

  current.lastUpdated = Date.now();
  current.status = rl.status || current.status;
  current.resetsAt = rl.resetsAt ?? current.resetsAt;
  current.rateLimitType = rl.rateLimitType ?? current.rateLimitType;
  current.utilization = rl.utilization ?? current.utilization;
  current.overageStatus = rl.overageStatus ?? current.overageStatus;
  current.overageResetsAt = rl.overageResetsAt ?? current.overageResetsAt;
  current.isUsingOverage = rl.isUsingOverage ?? current.isUsingOverage;
  current.surpassedThreshold = rl.surpassedThreshold ?? current.surpassedThreshold;
  current.overageDisabledReason = rl.overageDisabledReason ?? current.overageDisabledReason;
  if (agentId) current.updatedBy = agentId;

  cache = current;
  cacheAge = Date.now();
  saveToDisk(current);
}

/**
 * Visual progress bar: ▓▓▓▓▓▓▓▓░░ 80%
 */
function makeProgressBar(pct, width = 12) {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Human-readable reset time from unix timestamp (seconds)
 */
function formatResetTime(resetsAtSec) {
  if (!resetsAtSec) return '';
  const now = Date.now();
  const resetMs = resetsAtSec * 1000;
  if (resetMs <= now) return 'now';
  const diffMs = resetMs - now;
  const totalMins = Math.ceil(diffMs / 60000);
  if (totalMins < 60) return `${totalMins}m`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

/**
 * Format account rate limit as readable multi-line text.
 */
export function formatAccountRateLimit() {
  const rl = getAccountRateLimit();

  if (!rl.lastUpdated) {
    return '⚪ No data yet (send a message to any agent first)\n';
  }

  const age = Date.now() - rl.lastUpdated;
  const ageMins = Math.floor(age / 60000);
  const stale = ageMins > 30 ? ` ⚠️ ${ageMins}m ago` : ` (${ageMins < 1 ? 'just now' : ageMins + 'm ago'})`;

  let msg = '';

  // Status indicator
  const statusIcons = { allowed: '🟢', allowed_warning: '🟡', rejected: '🔴' };
  const icon = statusIcons[rl.status] || '⚪';
  msg += `${icon} ${rl.status || 'unknown'}`;
  if (rl.rateLimitType) {
    const typeLabels = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus', seven_day_sonnet: '7d sonnet', overage: 'overage' };
    msg += ` (${typeLabels[rl.rateLimitType] || rl.rateLimitType})`;
  }
  msg += stale + '\n';

  // Utilization bar
  if (rl.utilization != null) {
    const pct = Math.round(rl.utilization * 100);
    msg += `${makeProgressBar(rl.utilization)} ${pct}% used\n`;
  }

  // Reset time
  if (rl.resetsAt) {
    const resetStr = formatResetTime(rl.resetsAt);
    if (resetStr && resetStr !== 'now') {
      msg += `↻ Resets in: ${resetStr}\n`;
    }
  }

  // Overage info
  if (rl.isUsingOverage) {
    msg += `📈 Overage: ${rl.overageStatus || 'active'}`;
    if (rl.overageResetsAt) {
      msg += ` (resets ${formatResetTime(rl.overageResetsAt)})`;
    }
    msg += '\n';
  } else if (rl.overageDisabledReason) {
    msg += `📈 Overage: disabled (${rl.overageDisabledReason})\n`;
  }

  // Updated by
  if (rl.updatedBy) {
    msg += `📡 Via: ${rl.updatedBy}\n`;
  }

  return msg;
}

/**
 * Compact one-line rate limit for streaming progress bars.
 * Example: "🟢 42% used ↻2h 15m"
 *
 * @param {string} [fallbackText] - Fallback text if no API data available
 * @returns {string}
 */
export function formatRateLineCompact(fallbackText = '') {
  const rl = getAccountRateLimit();

  if (!rl.lastUpdated || (Date.now() - rl.lastUpdated) > 1800000) {
    return fallbackText;
  }

  const pct = rl.utilization != null ? Math.round(rl.utilization * 100) : null;
  const icon = !pct ? '⚪' : pct >= 90 ? '🔴' : pct >= 60 ? '🟡' : '🟢';
  let line = '';
  if (pct != null) {
    line = `${icon} ${pct}% used`;
  } else {
    line = `${icon} ${rl.status || '?'}`;
  }
  if (rl.resetsAt) {
    const resetStr = formatResetTime(rl.resetsAt);
    if (resetStr && resetStr !== 'now') line += ` ↻${resetStr}`;
  }
  return line;
}
