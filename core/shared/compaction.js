/**
 * Multi-Tier Compaction System for TamerClaw Agent Ecosystem
 *
 * Manages context window pressure across long-running agent sessions by
 * progressively compacting conversation history through multiple tiers:
 *
 *   Tier 1 — Microcompact: Clears large tool results from old messages
 *   Tier 2 — Autocompact:  Summarizes via Claude Haiku side-query when tokens exceed threshold
 *   Tier 3 — Snip:         Brute-force middle removal, keeps head + tail
 *   Tier 4 — Memory:       Extracts key facts to persistent session memory file
 *
 * Token estimation uses chars / 3.5 as a rough heuristic.
 *
 * Usage:
 *   import { compactSession, shouldCompact, microcompact } from './compaction.js';
 *   const result = await compactSession(history, 'myagent');
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import paths from './paths.js';

// -- Constants -----------------------------------------------------------------

const AGENTS_DIR = paths.agents;
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/root/.local/bin/claude';
const LOG_PREFIX = '[compaction]';

const CHARS_PER_TOKEN = 3.5;

const DEFAULTS = {
  // Microcompact
  microcompactTailKeep: 15,         // keep last N messages untouched
  microcompactMinChars: 500,        // only clear results longer than this
  // Autocompact
  autocompactTokenThreshold: 80000, // trigger autocompact above this
  autocompactTailKeep: 5,           // keep last N messages after summary
  autocompactMaxFailures: 3,        // circuit breaker
  autocompactTimeoutMs: 30000,      // haiku side-query timeout
  // Snip
  snipHeadKeep: 3,                  // keep first N messages
  snipTailKeep: 10,                 // keep last N messages
  // General
  microcompactThreshold: 40000,     // suggest microcompact above this
  snipThreshold: 120000,            // suggest snip above this
};

// Tool result patterns to target for microcompact clearing
const TOOL_RESULT_NAMES = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'read', 'bash', 'grep', 'glob', 'web_search', 'web_fetch',
]);

// -- Helpers -------------------------------------------------------------------

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function estimateHistoryTokens(history) {
  if (!Array.isArray(history)) return 0;
  let total = 0;
  for (const msg of history) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') {
          total += estimateTokens(block);
        } else if (block?.text) {
          total += estimateTokens(block.text);
        } else if (block?.content) {
          total += estimateTokens(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        }
      }
    } else if (msg.content && typeof msg.content === 'object') {
      total += estimateTokens(JSON.stringify(msg.content));
    }
  }
  return total;
}

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

function getMemoryDir(agentId) {
  const memDir = paths.memory(agentId);
  if (fs.existsSync(memDir)) return memDir;
  // Fallback: try agent dir directly
  const fallback = path.join(AGENTS_DIR, agentId, 'memory');
  if (fs.existsSync(fallback)) return fallback;
  return memDir;
}

function todayDateStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Deep-clone a history array to avoid mutating the original.
 */
function cloneHistory(history) {
  return JSON.parse(JSON.stringify(history));
}

// -- Tier 1: Microcompact ------------------------------------------------------

/**
 * Scans older messages and replaces large tool results with a cleared marker.
 * Only targets messages beyond `tailKeep` from the end.
 *
 * @param {Array} history - Array of {role, content} messages
 * @param {object} [opts]
 * @param {number} [opts.tailKeep=15] - Number of recent messages to leave untouched
 * @param {number} [opts.minChars=500] - Minimum result size to trigger clearing
 * @returns {{ history: Array, tokensSaved: number }}
 */
export function microcompact(history, opts = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { history: history || [], tokensSaved: 0 };
  }

  const tailKeep = opts.tailKeep ?? DEFAULTS.microcompactTailKeep;
  const minChars = opts.minChars ?? DEFAULTS.microcompactMinChars;
  const result = cloneHistory(history);
  let charsSaved = 0;

  const cutoff = Math.max(0, result.length - tailKeep);

  for (let i = 0; i < cutoff; i++) {
    const msg = result[i];
    if (!msg) continue;

    // Handle content as array of blocks (Claude format)
    if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block) continue;

        const isToolResult = (
          block.type === 'tool_result' ||
          block.type === 'tool_use_result' ||
          (block.tool_use_id && block.content) ||
          (block.name && TOOL_RESULT_NAMES.has(block.name))
        );

        if (isToolResult) {
          const text = typeof block.content === 'string'
            ? block.content
            : (block.text || (block.content ? JSON.stringify(block.content) : ''));

          if (text.length > minChars) {
            charsSaved += text.length;
            const marker = `[Cleared: was ${text.length} chars]`;
            if (typeof block.content === 'string') {
              msg.content[j] = { ...block, content: marker };
            } else if (block.text) {
              msg.content[j] = { ...block, text: marker };
            } else {
              msg.content[j] = { ...block, content: marker };
            }
          }
        }
      }
    }

    // Handle content as plain string with embedded tool output markers
    if (typeof msg.content === 'string' && msg.role === 'assistant') {
      // Look for large code blocks or tool output in assistant messages
      const content = msg.content;
      if (content.length > minChars * 2) {
        // Replace large fenced code blocks (likely tool outputs pasted inline)
        const replaced = content.replace(
          /```[\s\S]{500,}?```/g,
          (match) => {
            charsSaved += match.length;
            return `[Cleared: code block was ${match.length} chars]`;
          }
        );
        if (replaced !== content) {
          result[i] = { ...msg, content: replaced };
        }
      }
    }
  }

  const tokensSaved = Math.floor(charsSaved / CHARS_PER_TOKEN);
  if (tokensSaved > 0) {
    log(`Microcompact: cleared ${tokensSaved} tokens from ${cutoff} older messages`);
  }

  return { history: result, tokensSaved };
}

// -- Tier 2: Autocompact (Claude Haiku Summary) --------------------------------

// Circuit breaker state (module-level, resets on process restart)
let _autocompactFailures = 0;

/**
 * Runs a Claude Haiku side-query to produce a structured summary prompt.
 * Returns the summary text or null on failure.
 */
async function claudeSummarize(text, timeoutMs = 30000) {
  const prompt = `You are a conversation compactor. Summarize the following conversation history into a structured format. Be concise but preserve all actionable details.

FORMAT:
## Primary Request
<What the user originally asked for>

## Key Concepts
<Bullet list of important technical concepts, decisions, patterns>

## Files & Code
<List of files mentioned/modified with brief notes>

## Errors & Fixes
<Any errors encountered and how they were resolved>

## Pending Tasks
<Anything left incomplete or promised for later>

## Current Work
<What was being actively worked on at the end>

---
CONVERSATION:
${text}`;

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p', prompt,
      '--model', 'haiku',
      '--output-format', 'text',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        logError('Autocompact: Haiku side-query timed out');
        resolve(null);
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0 || !stdout.trim()) {
        logError(`Autocompact: Haiku exited with code ${code}`, stderr.slice(0, 200));
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      logError('Autocompact: spawn error', err.message);
      resolve(null);
    });
  });
}

/**
 * Replaces older messages with a Haiku-generated structured summary.
 * Keeps the last `tailKeep` messages intact.
 *
 * Circuit breaker: stops attempting after `maxFailures` consecutive failures.
 *
 * @param {Array} history - Session message history
 * @param {string} agentId - Agent identifier (for logging)
 * @param {object} [opts]
 * @param {number} [opts.tailKeep=5] - Recent messages to preserve
 * @param {number} [opts.tokenThreshold=80000] - Only compact if above this
 * @param {number} [opts.maxFailures=3] - Circuit breaker limit
 * @param {number} [opts.timeoutMs=30000] - Haiku query timeout
 * @returns {Promise<{ history: Array, summary: string|null, tokensSaved: number }>}
 */
export async function autocompact(history, agentId, opts = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { history: history || [], summary: null, tokensSaved: 0 };
  }

  const tailKeep = opts.tailKeep ?? DEFAULTS.autocompactTailKeep;
  const tokenThreshold = opts.tokenThreshold ?? DEFAULTS.autocompactTokenThreshold;
  const maxFailures = opts.maxFailures ?? DEFAULTS.autocompactMaxFailures;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.autocompactTimeoutMs;

  const currentTokens = estimateHistoryTokens(history);

  if (currentTokens < tokenThreshold) {
    log(`Autocompact: ${currentTokens} tokens below threshold ${tokenThreshold}, skipping`);
    return { history, summary: null, tokensSaved: 0 };
  }

  // Circuit breaker check
  if (_autocompactFailures >= maxFailures) {
    logError(`Autocompact: circuit breaker open (${_autocompactFailures} consecutive failures), falling back`);
    return { history, summary: null, tokensSaved: 0 };
  }

  // Build text from messages to summarize (everything except tail)
  const cutoff = Math.max(0, history.length - tailKeep);
  if (cutoff <= 1) {
    return { history, summary: null, tokensSaved: 0 };
  }

  const toSummarize = history.slice(0, cutoff);
  const conversationText = toSummarize.map((msg, i) => {
    const role = (msg.role || 'unknown').toUpperCase();
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(b => b?.text || b?.content || '').join('\n');
    } else if (msg.content) {
      content = JSON.stringify(msg.content);
    }
    // Truncate very long individual messages for the summary input
    if (content.length > 2000) {
      content = content.slice(0, 2000) + `... [truncated, was ${content.length} chars]`;
    }
    return `[${role}] ${content}`;
  }).join('\n\n');

  // Cap summary input to ~30K tokens worth of chars
  const maxSummaryChars = 30000 * CHARS_PER_TOKEN;
  const summaryInput = conversationText.length > maxSummaryChars
    ? conversationText.slice(0, maxSummaryChars) + '\n\n[... earlier messages truncated for summary ...]'
    : conversationText;

  log(`Autocompact: summarizing ${cutoff} messages (${currentTokens} tokens) for ${agentId}`);

  const summary = await claudeSummarize(summaryInput, timeoutMs);

  if (!summary) {
    _autocompactFailures++;
    logError(`Autocompact: failed (${_autocompactFailures}/${maxFailures})`);
    return { history, summary: null, tokensSaved: 0 };
  }

  // Reset circuit breaker on success
  _autocompactFailures = 0;

  // Build compacted history: summary system message + tail messages
  const summaryMessage = {
    role: 'user',
    content: `[Session Compacted — Autocompact Summary]\n\nThe earlier part of this conversation was compacted to save context. Here is a structured summary of what happened:\n\n${summary}\n\n---\n[${cutoff} messages were compacted into this summary]`,
  };

  const tail = history.slice(cutoff);
  const compacted = [summaryMessage, ...tail];

  const newTokens = estimateHistoryTokens(compacted);
  const tokensSaved = Math.max(0, currentTokens - newTokens);

  log(`Autocompact: saved ${tokensSaved} tokens (${currentTokens} -> ${newTokens}) for ${agentId}`);

  return { history: compacted, summary, tokensSaved };
}

// -- Tier 3: Snip Compaction ---------------------------------------------------

/**
 * Brute-force middle removal. Keeps the first `headKeep` and last `tailKeep`
 * messages, replacing everything in between with a snip marker.
 *
 * @param {Array} history - Session message history
 * @param {object} [opts]
 * @param {number} [opts.headKeep=3] - Messages to keep from start
 * @param {number} [opts.tailKeep=10] - Messages to keep from end
 * @returns {{ history: Array, messagesRemoved: number }}
 */
export function snipCompact(history, opts = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { history: history || [], messagesRemoved: 0 };
  }

  const headKeep = opts.headKeep ?? DEFAULTS.snipHeadKeep;
  const tailKeep = opts.tailKeep ?? DEFAULTS.snipTailKeep;

  const totalKeep = headKeep + tailKeep;
  if (history.length <= totalKeep) {
    return { history, messagesRemoved: 0 };
  }

  const head = history.slice(0, headKeep);
  const tail = history.slice(-tailKeep);
  const removedCount = history.length - totalKeep;

  const snipMarker = {
    role: 'user',
    content: `[Snipped ${removedCount} messages to save context]`,
  };

  const compacted = [...head, snipMarker, ...tail];

  log(`Snip: removed ${removedCount} messages (kept ${headKeep} head + ${tailKeep} tail)`);

  return { history: compacted, messagesRemoved: removedCount };
}

// -- Tier 4: Session Memory Extraction -----------------------------------------

/**
 * Extracts key facts and decisions from conversation history into a
 * persistent session memory markdown file with YAML frontmatter.
 *
 * Writes to: agents/{agentId}/memory/session-{date}.md
 * Appends if the file already exists for today.
 *
 * @param {Array} history - Session message history
 * @param {string} agentId - Agent identifier
 * @returns {Promise<string|null>} Path to written memory file, or null on failure
 */
export async function extractSessionMemory(history, agentId) {
  if (!Array.isArray(history) || history.length === 0 || !agentId) {
    return null;
  }

  try {
    const memDir = getMemoryDir(agentId);
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }

    const dateStr = todayDateStr();
    const filePath = path.join(memDir, `session-${dateStr}.md`);

    // Extract facts from message content
    const facts = extractFacts(history);

    if (facts.length === 0) {
      log(`Memory: no extractable facts from ${history.length} messages for ${agentId}`);
      return null;
    }

    const timestamp = new Date().toISOString();
    let content;

    if (fs.existsSync(filePath)) {
      // Append to existing file
      const existing = fs.readFileSync(filePath, 'utf-8');
      const newSection = `\n\n## Session Update — ${timestamp.slice(11, 19)}\n\n${facts.map(f => `- ${f}`).join('\n')}\n`;
      content = existing + newSection;
    } else {
      // Create new file with YAML frontmatter
      content = `---
agent: ${agentId}
date: ${dateStr}
created: ${timestamp}
type: session-memory
compaction: auto-extracted
---

# Session Memory — ${dateStr}

## Key Facts & Decisions

${facts.map(f => `- ${f}`).join('\n')}
`;
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    log(`Memory: wrote ${facts.length} facts to ${filePath}`);
    return filePath;
  } catch (err) {
    logError(`Memory extraction failed for ${agentId}:`, err.message);
    return null;
  }
}

/**
 * Extract notable facts, decisions, file paths, and errors from history.
 * Simple heuristic extraction — no LLM needed.
 */
function extractFacts(history) {
  const facts = new Set();
  const filesMentioned = new Set();
  const errorsSeen = new Set();
  const decisionsKeywords = ['decided', 'chose', 'going with', 'switched to', 'using', 'will use', 'let\'s go with', 'settled on'];

  for (const msg of history) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : (Array.isArray(msg.content)
        ? msg.content.map(b => b?.text || (typeof b?.content === 'string' ? b.content : '')).join(' ')
        : '');

    if (!content || content.length < 10) continue;

    // Extract file paths
    const filePaths = content.match(/(?:\/[\w.-]+){2,}/g);
    if (filePaths) {
      for (const fp of filePaths.slice(0, 10)) {
        if (fp.length < 100 && !fp.includes('node_modules')) {
          filesMentioned.add(fp);
        }
      }
    }

    // Extract errors
    if (msg.role === 'assistant' || msg.role === 'tool') {
      const errorMatch = content.match(/(?:Error|error|ERROR|FAIL|failed|Failed):?\s*(.{10,80})/);
      if (errorMatch) {
        const errText = errorMatch[1].replace(/\s+/g, ' ').trim();
        if (errText.length > 15) {
          errorsSeen.add(`Error encountered: ${errText}`);
        }
      }
    }

    // Extract decisions from user messages
    if (msg.role === 'user') {
      const lower = content.toLowerCase();
      for (const kw of decisionsKeywords) {
        if (lower.includes(kw)) {
          // Grab sentence containing the keyword
          const sentences = content.split(/[.!?\n]/).filter(s => s.toLowerCase().includes(kw));
          for (const s of sentences.slice(0, 2)) {
            const trimmed = s.trim();
            if (trimmed.length > 15 && trimmed.length < 200) {
              facts.add(`Decision: ${trimmed}`);
            }
          }
          break;
        }
      }
    }
  }

  // Compile file list
  if (filesMentioned.size > 0) {
    const fileList = Array.from(filesMentioned).slice(0, 15);
    facts.add(`Files referenced: ${fileList.join(', ')}`);
  }

  // Add errors
  for (const err of Array.from(errorsSeen).slice(0, 5)) {
    facts.add(err);
  }

  // Add message count context
  const userMsgCount = history.filter(m => m.role === 'user').length;
  const assistantMsgCount = history.filter(m => m.role === 'assistant').length;
  facts.add(`Session had ${userMsgCount} user messages and ${assistantMsgCount} assistant responses`);

  return Array.from(facts);
}

// -- Decision Engine -----------------------------------------------------------

/**
 * Determines whether compaction is needed and which tier to use.
 *
 * @param {Array} history - Session message history
 * @param {object} [opts] - Override thresholds
 * @returns {{ needed: boolean, tier: string, currentTokens: number, reason: string }}
 */
export function shouldCompact(history, opts = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { needed: false, tier: 'none', currentTokens: 0, reason: 'empty history' };
  }

  const currentTokens = estimateHistoryTokens(history);
  const microThreshold = opts.microcompactThreshold ?? DEFAULTS.microcompactThreshold;
  const autoThreshold = opts.autocompactTokenThreshold ?? DEFAULTS.autocompactTokenThreshold;
  const snipThreshold = opts.snipThreshold ?? DEFAULTS.snipThreshold;

  if (currentTokens >= snipThreshold) {
    return {
      needed: true,
      tier: 'snip',
      currentTokens,
      reason: `${currentTokens} tokens exceeds snip threshold (${snipThreshold})`,
    };
  }

  if (currentTokens >= autoThreshold) {
    // Check circuit breaker
    if (_autocompactFailures >= (opts.autocompactMaxFailures ?? DEFAULTS.autocompactMaxFailures)) {
      return {
        needed: true,
        tier: 'snip',
        currentTokens,
        reason: `${currentTokens} tokens exceeds autocompact threshold but circuit breaker is open, falling back to snip`,
      };
    }
    return {
      needed: true,
      tier: 'autocompact',
      currentTokens,
      reason: `${currentTokens} tokens exceeds autocompact threshold (${autoThreshold})`,
    };
  }

  if (currentTokens >= microThreshold) {
    return {
      needed: true,
      tier: 'microcompact',
      currentTokens,
      reason: `${currentTokens} tokens exceeds microcompact threshold (${microThreshold})`,
    };
  }

  return {
    needed: false,
    tier: 'none',
    currentTokens,
    reason: `${currentTokens} tokens is within limits`,
  };
}

// -- Unified Compaction API ----------------------------------------------------

/**
 * Auto-selects and applies the best compaction tier for the current session.
 * Also extracts session memory after compaction.
 *
 * @param {Array} history - Session message history
 * @param {string} agentId - Agent identifier
 * @param {object} [opts] - Override any threshold or tier option
 * @returns {Promise<{ history: Array, tier: string, tokensSaved: number, messagesRemoved: number, memoryFile: string|null }>}
 */
export async function compactSession(history, agentId, opts = {}) {
  const check = shouldCompact(history, opts);

  if (!check.needed) {
    return {
      history,
      tier: 'none',
      tokensSaved: 0,
      messagesRemoved: 0,
      memoryFile: null,
    };
  }

  log(`Compacting session for ${agentId}: ${check.reason}`);

  let result;

  switch (check.tier) {
    case 'microcompact': {
      const mc = microcompact(history, opts);
      result = {
        history: mc.history,
        tier: 'microcompact',
        tokensSaved: mc.tokensSaved,
        messagesRemoved: 0,
      };
      break;
    }

    case 'autocompact': {
      // Try autocompact first, fall through to snip on failure
      const ac = await autocompact(history, agentId, opts);
      if (ac.summary) {
        result = {
          history: ac.history,
          tier: 'autocompact',
          tokensSaved: ac.tokensSaved,
          messagesRemoved: history.length - ac.history.length,
        };
      } else {
        // Autocompact failed, apply microcompact + snip as fallback
        log(`Autocompact failed for ${agentId}, falling back to microcompact + snip`);
        const mc = microcompact(history, opts);
        const sn = snipCompact(mc.history, opts);
        result = {
          history: sn.history,
          tier: 'snip (fallback)',
          tokensSaved: mc.tokensSaved,
          messagesRemoved: sn.messagesRemoved,
        };
      }
      break;
    }

    case 'snip': {
      // Apply microcompact first, then snip
      const mc = microcompact(history, opts);
      const sn = snipCompact(mc.history, opts);
      result = {
        history: sn.history,
        tier: 'snip',
        tokensSaved: mc.tokensSaved,
        messagesRemoved: sn.messagesRemoved,
      };
      break;
    }

    default: {
      return {
        history,
        tier: 'none',
        tokensSaved: 0,
        messagesRemoved: 0,
        memoryFile: null,
      };
    }
  }

  // Extract session memory after any compaction
  let memoryFile = null;
  try {
    memoryFile = await extractSessionMemory(history, agentId);
  } catch (err) {
    logError(`Memory extraction error for ${agentId}:`, err.message);
  }

  log(`Compaction complete for ${agentId}: tier=${result.tier}, saved=${result.tokensSaved} tokens, removed=${result.messagesRemoved} messages`);

  return { ...result, memoryFile };
}

// -- Utility Exports -----------------------------------------------------------

/**
 * Reset the autocompact circuit breaker (for testing or manual recovery).
 */
export function resetCircuitBreaker() {
  _autocompactFailures = 0;
  log('Circuit breaker reset');
}

/**
 * Get current estimated token count for a history array.
 */
export { estimateHistoryTokens };

// -- Default Export ------------------------------------------------------------

export default {
  microcompact,
  autocompact,
  snipCompact,
  shouldCompact,
  compactSession,
  extractSessionMemory,
  estimateHistoryTokens,
  resetCircuitBreaker,
};
