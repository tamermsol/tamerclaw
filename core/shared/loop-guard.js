/**
 * Loop Guard v1.0 — Detect and break agent looping patterns
 *
 * Monitors Claude's streamed output for repetitive attempts at the same operation.
 * When a loop is detected (same keyword pattern N times in a window), it injects
 * a hard stop message into the conversation to break the cycle.
 *
 * Usage in bot.js — wrap your streaming output handler:
 *
 *   import { createLoopGuard } from '../../shared/loop-guard.js';
 *
 *   const loopGuard = createLoopGuard({
 *     maxRetries: 3,
 *     onLoop: (pattern, count) => {
 *       bot.sendMessage(chatId, `Loop detected: "${pattern}" attempted ${count} times. Stopping.`);
 *       killActiveProcess();
 *     }
 *   });
 *
 *   // In your streaming output handler:
 *   loopGuard.observe(outputChunk);  // feed each output line
 *   loopGuard.reset();               // call on new message/session start
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_WINDOW_SIZE = 50; // lines to keep in rolling window

// Patterns that indicate a retry/loop attempt
const LOOP_PATTERNS = [
  { key: 'flutter_build',    regex: /flutter\s+build\s+ios/i },
  { key: 'pod_install',      regex: /pod\s+install/i },
  { key: 'flutter_clean',    regex: /flutter\s+clean/i },
  { key: 'pub_get',          regex: /flutter\s+pub\s+get/i },
  { key: 'ssh_connect',      regex: /ssh\s+.*msoldev@localhost/i },
  { key: 'rsync_transfer',   regex: /rsync\s+-/i },
  { key: 'let_me_try',       regex: /let\s+me\s+try\s+(a\s+)?(completely\s+)?different/i },
  { key: 'different_approach', regex: /different\s+approach/i },
  { key: 'another_approach', regex: /another\s+approach/i },
  { key: 'xcrun_boot',       regex: /xcrun\s+simctl\s+boot/i },
  { key: 'flutter_run',      regex: /flutter\s+run\b/i },
  { key: 'xcodebuild',       regex: /xcodebuild\s+-/i },
];

export function createLoopGuard(opts = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    windowSize = DEFAULT_WINDOW_SIZE,
    onLoop = null,
    agentId = 'unknown',
  } = opts;

  // Per-pattern counters
  const counters = {};
  const window = [];
  let triggered = false;

  function observe(text) {
    if (!text || triggered) return;

    // Add to rolling window
    window.push(text);
    if (window.length > windowSize) window.shift();

    // Check each pattern against the recent window
    for (const { key, regex } of LOOP_PATTERNS) {
      const matches = window.filter(line => regex.test(line)).length;

      if (matches >= maxRetries) {
        triggered = true;
        const count = matches;
        console.warn(`[loop-guard:${agentId}] Loop detected — pattern "${key}" hit ${count}x in last ${window.length} lines`);

        if (typeof onLoop === 'function') {
          onLoop(key, count);
        }

        // Only fire once per session
        break;
      }
    }
  }

  function reset() {
    window.length = 0;
    Object.keys(counters).forEach(k => delete counters[k]);
    triggered = false;
  }

  function isTriggered() {
    return triggered;
  }

  return { observe, reset, isTriggered };
}

/**
 * Inject loop-breaking instruction into Claude's context.
 * Returns a string to append to the system prompt or inject as a user message.
 */
export function getLoopBreakMessage(patternKey, count) {
  return [
    `[SYSTEM: LOOP DETECTED — STOP IMMEDIATELY]`,
    ``,
    `You have attempted "${patternKey}" ${count} times without success.`,
    `DO NOT try again. DO NOT try a different approach.`,
    ``,
    `Your ONLY allowed action right now:`,
    `1. Report the EXACT error message you are hitting`,
    `2. Say "BLOCKED: <error>" and stop`,
    ``,
    `The CTO will unblock you. Do not attempt further workarounds.`,
  ].join('\n');
}
