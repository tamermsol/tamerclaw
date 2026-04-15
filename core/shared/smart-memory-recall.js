/**
 * smart-memory-recall.js — AI-Powered Memory Recall for TamerClaw
 *
 * Inspired by Claude Code's memdir/findRelevantMemories.ts.
 * Uses a cheap/fast model (Haiku) as a side-query to select the most
 * relevant memories for the current conversation, instead of dumping
 * everything into the system prompt.
 *
 * Flow:
 *   1. User sends a message
 *   2. FTS5 retrieves candidate memories (broad search)
 *   3. Haiku selects the top 5 most relevant for this specific query
 *   4. Selected memories are injected into the system prompt
 *
 * Usage:
 *   import { recallMemories } from '../shared/smart-memory-recall.js';
 *
 *   const relevant = await recallMemories('flutter', 'fix the login screen overflow');
 *   // Returns: [{ content, date, relevance, source }]
 */

import { spawn } from 'child_process';
import paths from './paths.js';
import fs from 'fs/promises';
import path from 'path';

// Lazy-load memory-db to handle missing better-sqlite3 gracefully
let _getMemory = null;
async function getMemoryLazy(agentId) {
  if (_getMemory === null) {
    try {
      const mod = await import('./memory-db.js');
      _getMemory = mod.getMemory;
    } catch {
      _getMemory = false; // Mark as unavailable
    }
  }
  return _getMemory ? _getMemory(agentId) : null;
}

// ── Config ───────────────────────────────────────────────────────────────
const MAX_CANDIDATES = 30;      // Max FTS5 results to consider
const MAX_SELECTED = 5;         // Max memories to inject
const MAX_CANDIDATE_LENGTH = 500; // Truncate each candidate for the selector
const RECALL_TIMEOUT = 15000;    // 15s timeout for side-query
const CACHE_TTL = 60000;        // 1 minute cache for same queries

// ── Cache ────────────────────────────────────────────────────────────────
const _cache = new Map();

function getCacheKey(agentId, query) {
  return `${agentId}:${query.toLowerCase().trim().slice(0, 100)}`;
}

function getCached(agentId, query) {
  const key = getCacheKey(agentId, query);
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) {
    return entry.result;
  }
  _cache.delete(key);
  return null;
}

function setCache(agentId, query, result) {
  const key = getCacheKey(agentId, query);
  _cache.set(key, { ts: Date.now(), result });

  // Evict old entries
  if (_cache.size > 100) {
    const oldest = [..._cache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, 50);
    for (const [k] of oldest) _cache.delete(k);
  }
}

// ── Memory Sources ───────────────────────────────────────────────────────

/**
 * Gather candidate memories from multiple sources.
 * @param {string} agentId
 * @param {string} query
 * @returns {Promise<Array<{ content: string, date: string, source: string, score?: number }>>}
 */
async function gatherCandidates(agentId, query) {
  const candidates = [];

  // Source 1: SQLite FTS5 search
  try {
    const mem = await getMemoryLazy(agentId);
    if (!mem) throw new Error('SQLite not available');
    const ftsResults = mem.search(query, MAX_CANDIDATES);
    for (const r of ftsResults) {
      candidates.push({
        content: r.content.slice(0, MAX_CANDIDATE_LENGTH),
        date: r.date,
        source: 'sqlite-fts',
        role: r.role,
        score: r.rank || 0,
      });
    }
  } catch (err) {
    // SQLite may not be initialized for this agent
  }

  // Source 2: MEMORY.md (long-term memory file)
  try {
    const memMdPath = paths.agentMemoryMd(agentId);
    const content = await fs.readFile(memMdPath, 'utf-8');
    if (content.trim()) {
      // Split into sections (by ## headers or --- dividers)
      const sections = content.split(/(?=^##\s|\n---\n)/m).filter(s => s.trim());
      for (const section of sections.slice(0, 20)) {
        candidates.push({
          content: section.trim().slice(0, MAX_CANDIDATE_LENGTH),
          date: 'persistent',
          source: 'memory-md',
          role: 'system',
        });
      }
    }
  } catch {}

  // Source 3: Recent daily memory files (last 7 days)
  try {
    const memDir = paths.memory(agentId);
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today - i * 86400000).toISOString().slice(0, 10);
      const filePath = path.join(memDir, `${date}.md`);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        if (content.trim()) {
          // Extract conversation entries
          const entries = content.split(/\n\[/).filter(s => s.trim());
          for (const entry of entries.slice(-10)) {
            const cleaned = entry.startsWith('[') ? entry : '[' + entry;
            candidates.push({
              content: cleaned.trim().slice(0, MAX_CANDIDATE_LENGTH),
              date,
              source: `daily-${date}`,
              role: 'log',
            });
          }
        }
      } catch {}
    }
  } catch {}

  // Deduplicate by content similarity (simple exact-prefix match)
  const seen = new Set();
  return candidates.filter(c => {
    const key = c.content.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── AI Selection ─────────────────────────────────────────────────────────

/**
 * Use a fast model (Haiku) to select the most relevant memories.
 * Falls back to simple keyword scoring if the side-query fails.
 *
 * @param {string} query       - User's current message
 * @param {Array} candidates   - Candidate memories
 * @returns {Promise<number[]>} - Indices of selected candidates
 */
async function aiSelectMemories(query, candidates) {
  if (candidates.length <= MAX_SELECTED) {
    return candidates.map((_, i) => i);
  }

  // Build the selection prompt
  const candidateList = candidates
    .map((c, i) => `[${i}] (${c.date}, ${c.source}) ${c.content.slice(0, 200)}`)
    .join('\n');

  const prompt = `You are a memory selector. Given a user query and candidate memories, select the ${MAX_SELECTED} most relevant memory indices.

USER QUERY: ${query}

CANDIDATE MEMORIES:
${candidateList}

Respond with ONLY a JSON array of indices, e.g. [0, 3, 7, 12, 15]. Select the memories most likely to help answer the query. Prefer recent and specific memories over old/generic ones.`;

  try {
    const result = await runSideQuery(prompt);
    if (result) {
      // Parse the JSON array from response
      const match = result.match(/\[[\d,\s]+\]/);
      if (match) {
        const indices = JSON.parse(match[0]);
        return indices
          .filter(i => typeof i === 'number' && i >= 0 && i < candidates.length)
          .slice(0, MAX_SELECTED);
      }
    }
  } catch (err) {
    console.error('[smart-recall] AI selection failed, falling back to scoring:', err.message);
  }

  // Fallback: simple keyword scoring
  return keywordSelect(query, candidates);
}

/**
 * Run a side-query using Claude Haiku (cheap + fast).
 * @param {string} prompt
 * @returns {Promise<string|null>}
 */
function runSideQuery(prompt) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve(null);
    }, RECALL_TIMEOUT);

    const proc = spawn('claude', [
      '--model', 'haiku',
      '--max-turns', '1',
      '--output-format', 'text',
      '-p', prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(stdout.trim() || null);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Fallback: keyword-based memory selection.
 * @param {string} query
 * @param {Array} candidates
 * @returns {number[]}
 */
function keywordSelect(query, candidates) {
  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  );

  const scored = candidates.map((c, i) => {
    const words = c.content.toLowerCase().split(/\s+/);
    let score = 0;

    // Keyword overlap
    for (const w of words) {
      if (queryWords.has(w)) score += 2;
    }

    // Recency bonus
    if (c.date === new Date().toISOString().slice(0, 10)) score += 3;
    else if (c.date === 'persistent') score += 1;

    // Source bonus
    if (c.source === 'sqlite-fts') score += 1;

    return { index: i, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SELECTED)
    .map(s => s.index);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Recall the most relevant memories for a given query.
 *
 * @param {string} agentId - Agent ID
 * @param {string} query   - User's current message
 * @param {object} [opts]
 * @param {number} [opts.maxResults=5]
 * @param {boolean} [opts.useAI=true]   - Use AI selection (set false for faster, keyword-only)
 * @param {boolean} [opts.useCache=true]
 * @returns {Promise<Array<{ content: string, date: string, source: string, relevance: string }>>}
 */
export async function recallMemories(agentId, query, opts = {}) {
  const maxResults = opts.maxResults ?? MAX_SELECTED;
  const useAI = opts.useAI ?? true;
  const useCache = opts.useCache ?? true;

  // Check cache
  if (useCache) {
    const cached = getCached(agentId, query);
    if (cached) return cached;
  }

  // Gather candidates
  const candidates = await gatherCandidates(agentId, query);
  if (candidates.length === 0) return [];

  // Select best matches
  let selectedIndices;
  if (useAI && candidates.length > maxResults) {
    selectedIndices = await aiSelectMemories(query, candidates);
  } else {
    selectedIndices = keywordSelect(query, candidates).slice(0, maxResults);
  }

  const result = selectedIndices.map(i => ({
    content: candidates[i].content,
    date: candidates[i].date,
    source: candidates[i].source,
    relevance: 'selected',
  }));

  // Cache result
  if (useCache) setCache(agentId, query, result);

  return result;
}

/**
 * Format recalled memories as a system prompt section.
 *
 * @param {Array} memories - From recallMemories()
 * @returns {string}
 */
export function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';

  const lines = ['# Recalled Memories\n'];
  for (const mem of memories) {
    lines.push(`## ${mem.source} (${mem.date})`);
    lines.push(mem.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Enhanced system prompt builder that integrates smart recall.
 * Drop-in replacement for the flat file memory injection.
 *
 * @param {string} agentId
 * @param {string} userMessage - Current user message for context
 * @param {object} [opts]
 * @returns {Promise<string>} Memory section for system prompt
 */
export async function buildMemorySection(agentId, userMessage, opts = {}) {
  const parts = [];

  // Always include MEMORY.md header (persistent context)
  try {
    const memMdPath = paths.agentMemoryMd(agentId);
    const content = await fs.readFile(memMdPath, 'utf-8');
    if (content.trim()) {
      parts.push('# Long-term Memory\n' + content.slice(0, 3000));
    }
  } catch {}

  // Smart recall: relevant memories for this specific query
  if (userMessage) {
    try {
      const recalled = await recallMemories(agentId, userMessage, {
        useAI: opts.useAI ?? true,
        maxResults: opts.maxResults ?? 5,
      });

      if (recalled.length > 0) {
        parts.push(formatMemoriesForPrompt(recalled));
      }
    } catch (err) {
      console.error(`[smart-recall] Failed for ${agentId}:`, err.message);
    }
  }

  // Fallback: still include today's memory for recency
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayPath = path.join(paths.memory(agentId), `${today}.md`);
    const content = await fs.readFile(todayPath, 'utf-8');
    if (content.trim()) {
      parts.push(`# Today (${today})\n` + content.slice(-2000));
    }
  } catch {}

  return parts.join('\n\n---\n\n');
}

export default recallMemories;
