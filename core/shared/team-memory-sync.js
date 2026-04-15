/**
 * team-memory-sync.js — Shared Memory Synchronization for TamerClaw Teams
 *
 * Provides team-level shared memory so agents within a team can share knowledge.
 * When the CTO learns something important, all tech-team members can access it.
 *
 * Features:
 *   - Team shared memory stored as JSON with atomic writes
 *   - Secret scanning to prevent accidental credential leaks
 *   - TTL-based expiry with automatic cleanup
 *   - FIFO eviction with pinned entry protection (max 500 per team)
 *   - Advisory file locking for concurrent access safety
 *   - Fuzzy search across team memory entries
 *
 * Usage:
 *   import { writeTeamMemory, readTeamMemory, syncToAgent } from '../shared/team-memory-sync.js';
 *   await writeTeamMemory('tech-team', 'deploy-policy', 'Always use blue-green', 'cto');
 *   const policy = await readTeamMemory('tech-team', 'deploy-policy');
 *   await syncToAgent('tech-team', 'flutter');
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ── Dynamic path resolution ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

// ── Constants ────────────────────────────────────────────────────────────────

const TEAMS_BASE = path.join(BASE_DIR, 'teams');
const AGENTS_BASE = path.join(BASE_DIR, 'agents');
const MAX_ENTRIES = 500;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 150;
const LOCK_MAX_RETRIES = 20;

// ── Secret Scanning Patterns ─────────────────────────────────────────────────

const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, label: 'OpenAI/Stripe API key (sk-...)' },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/, label: 'GitHub personal access token (ghp_...)' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/, label: 'GitHub OAuth token (gho_...)' },
  { pattern: /ghs_[a-zA-Z0-9]{36,}/, label: 'GitHub server token (ghs_...)' },
  { pattern: /github_pat_[a-zA-Z0-9_]{20,}/, label: 'GitHub fine-grained PAT' },
  { pattern: /Bearer\s+[a-zA-Z0-9_.~+/=-]{20,}/, label: 'Bearer token' },
  { pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/, label: 'Private key' },
  { pattern: /xox[boaprs]-[a-zA-Z0-9-]+/, label: 'Slack token' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, label: 'JWT token' },
  { pattern: /password\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded password' },
  { pattern: /secret\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded secret' },
];

// ── File Helpers ─────────────────────────────────────────────────────────────

function memoryPath(teamName) {
  return path.join(TEAMS_BASE, teamName, 'shared-memory.json');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Atomic JSON write: write to temp file then rename.
 */
async function writeJSONAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

/**
 * Safe JSON read with fallback.
 */
async function readJSONSafe(filePath, fallback = null) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

// ── Advisory File Locking ────────────────────────────────────────────────────

/**
 * Acquire an advisory lock using exclusive file creation.
 * Returns a release function.
 */
async function acquireLock(filePath) {
  const lockPath = filePath + '.lock';
  const lockContent = `${process.pid}:${Date.now()}`;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      await fs.writeFile(lockPath, lockContent, { flag: 'wx' });
      return async () => {
        try { await fs.unlink(lockPath); } catch {}
      };
    } catch (e) {
      if (e.code === 'EEXIST') {
        // Check for stale lock
        try {
          const lockStat = await fs.stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_TIMEOUT_MS) {
            await fs.unlink(lockPath);
            continue;
          }
        } catch {}
        await new Promise(r => setTimeout(r, LOCK_RETRY_MS + Math.random() * 100));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock on ${filePath} after ${LOCK_MAX_RETRIES} retries`);
}

/**
 * Execute a function while holding a file lock.
 */
async function withLock(filePath, fn) {
  const release = await acquireLock(filePath);
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ── Secret Scanning ──────────────────────────────────────────────────────────

/**
 * Scan a string for secret patterns.
 * @param {string} text
 * @returns {{ detected: boolean, matches: string[] }}
 */
function scanForSecrets(text) {
  if (typeof text !== 'string') return { detected: false, matches: [] };
  const matches = [];
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      matches.push(label);
    }
  }
  return { detected: matches.length > 0, matches };
}

// ── Memory Store Operations ──────────────────────────────────────────────────

/**
 * Load the team memory store, creating an empty one if it doesn't exist.
 */
async function loadStore(teamName) {
  const fp = memoryPath(teamName);
  const data = await readJSONSafe(fp, null);
  if (data && data.version === 1 && Array.isArray(data.entries)) {
    return data;
  }
  return { version: 1, teamName, entries: [], meta: { created: Date.now(), lastModified: Date.now() } };
}

/**
 * Save the team memory store atomically.
 */
async function saveStore(teamName, store) {
  store.meta.lastModified = Date.now();
  await writeJSONAtomic(memoryPath(teamName), store);
}

/**
 * Remove expired entries from the store (mutates in place).
 */
function cleanExpired(store) {
  const now = Date.now();
  const before = store.entries.length;
  store.entries = store.entries.filter(entry => {
    if (!entry.ttl) return true;
    return (entry.timestamp + entry.ttl) > now;
  });
  return before - store.entries.length;
}

/**
 * Enforce the max entries limit via FIFO eviction of non-pinned entries.
 */
function enforceLimit(store) {
  if (store.entries.length <= MAX_ENTRIES) return 0;

  // Sort: pinned entries first, then by timestamp descending (newest first)
  const pinned = store.entries.filter(e => e.pinned);
  const unpinned = store.entries.filter(e => !e.pinned);

  // Sort unpinned by timestamp descending so we keep the newest
  unpinned.sort((a, b) => b.timestamp - a.timestamp);

  const slotsForUnpinned = MAX_ENTRIES - pinned.length;
  const evicted = unpinned.length - Math.max(0, slotsForUnpinned);

  store.entries = [...pinned, ...unpinned.slice(0, Math.max(0, slotsForUnpinned))];
  return Math.max(0, evicted);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Write a key-value pair to team shared memory.
 *
 * @param {string} teamName - Team identifier (e.g. 'tech-team')
 * @param {string} key - Memory key
 * @param {string} value - Memory value
 * @param {string} author - Agent name that authored this entry
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.tags] - Tags for categorization
 * @param {number} [options.ttl] - Time-to-live in ms (null = permanent)
 * @param {boolean} [options.pinned] - Pin to prevent eviction
 * @returns {Promise<{ ok: boolean, entry?: object, error?: string }>}
 */
export async function writeTeamMemory(teamName, key, value, author, options = {}) {
  // Secret scan the value before writing
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  const scan = scanForSecrets(valueStr);
  if (scan.detected) {
    return {
      ok: false,
      error: `Secret detected in value — write rejected. Found: ${scan.matches.join(', ')}. ` +
             `Never store credentials in team memory.`,
    };
  }

  // Also scan the key
  const keyScan = scanForSecrets(key);
  if (keyScan.detected) {
    return {
      ok: false,
      error: `Secret detected in key — write rejected. Found: ${keyScan.matches.join(', ')}.`,
    };
  }

  const fp = memoryPath(teamName);
  await ensureDir(path.dirname(fp));

  return withLock(fp, async () => {
    const store = await loadStore(teamName);

    // Clean expired entries first
    cleanExpired(store);

    // Upsert: update existing key or add new entry
    const existing = store.entries.findIndex(e => e.key === key);
    const entry = {
      key,
      value: valueStr,
      author,
      timestamp: Date.now(),
      tags: options.tags || [],
      ttl: options.ttl || null,
      pinned: options.pinned || false,
    };

    if (existing >= 0) {
      store.entries[existing] = entry;
    } else {
      store.entries.push(entry);
    }

    // Enforce limit
    enforceLimit(store);

    await saveStore(teamName, store);
    return { ok: true, entry };
  });
}

/**
 * Read a specific key from team memory.
 *
 * @param {string} teamName
 * @param {string} key
 * @returns {Promise<object|null>} The entry or null if not found / expired
 */
export async function readTeamMemory(teamName, key) {
  const store = await loadStore(teamName);
  const entry = store.entries.find(e => e.key === key);
  if (!entry) return null;

  // Check TTL
  if (entry.ttl && (entry.timestamp + entry.ttl) < Date.now()) {
    return null;
  }

  return entry;
}

/**
 * Get all entries for a team (excluding expired ones).
 *
 * @param {string} teamName
 * @returns {Promise<object[]>}
 */
export async function getAllTeamMemory(teamName) {
  const store = await loadStore(teamName);
  const now = Date.now();
  return store.entries.filter(entry => {
    if (!entry.ttl) return true;
    return (entry.timestamp + entry.ttl) > now;
  });
}

/**
 * Push relevant team knowledge to an agent's context directory.
 * Writes a `team-shared.md` file into the agent's memory folder.
 *
 * @param {string} teamName
 * @param {string} agentName
 * @returns {Promise<{ ok: boolean, entriesWritten: number, path: string }>}
 */
export async function syncToAgent(teamName, agentName) {
  const entries = await getAllTeamMemory(teamName);
  if (entries.length === 0) {
    return { ok: true, entriesWritten: 0, path: '' };
  }

  const agentMemoryDir = path.join(AGENTS_BASE, agentName, 'memory');
  await ensureDir(agentMemoryDir);

  const lines = [
    `# Team Shared Memory: ${teamName}`,
    `<!-- Auto-synced at ${new Date().toISOString()} — do not edit manually -->`,
    '',
  ];

  for (const entry of entries) {
    const age = humanAge(Date.now() - entry.timestamp);
    const tagStr = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
    const pinStr = entry.pinned ? ' (pinned)' : '';
    lines.push(`## ${entry.key}${tagStr}${pinStr}`);
    lines.push(`*By ${entry.author}, ${age} ago*`);
    lines.push('');
    lines.push(entry.value);
    lines.push('');
  }

  const outPath = path.join(agentMemoryDir, `team-shared-${teamName}.md`);
  await fs.writeFile(outPath, lines.join('\n'));

  return { ok: true, entriesWritten: entries.length, path: outPath };
}

/**
 * Agent contributes knowledge back to team memory.
 * Batch-writes multiple entries from an agent.
 *
 * @param {string} agentName - The contributing agent
 * @param {string} teamName - Target team
 * @param {Array<{ key: string, value: string, tags?: string[], ttl?: number, pinned?: boolean }>} entries
 * @returns {Promise<{ written: number, rejected: Array<{ key: string, error: string }> }>}
 */
export async function syncFromAgent(agentName, teamName, entries) {
  const results = { written: 0, rejected: [] };

  for (const entry of entries) {
    const result = await writeTeamMemory(
      teamName,
      entry.key,
      entry.value,
      agentName,
      { tags: entry.tags, ttl: entry.ttl, pinned: entry.pinned },
    );

    if (result.ok) {
      results.written++;
    } else {
      results.rejected.push({ key: entry.key, error: result.error });
    }
  }

  return results;
}

/**
 * Fuzzy search across team memory entries.
 * Matches against key, value, author, and tags.
 *
 * @param {string} teamName
 * @param {string} query
 * @returns {Promise<object[]>} Matching entries sorted by relevance score
 */
export async function searchTeamMemory(teamName, query) {
  const entries = await getAllTeamMemory(teamName);
  if (!query || !query.trim()) return entries;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = entries.map(entry => {
    let score = 0;
    const keyLower = entry.key.toLowerCase();
    const valueLower = entry.value.toLowerCase();
    const authorLower = entry.author.toLowerCase();
    const tagsLower = entry.tags.map(t => t.toLowerCase());

    for (const term of terms) {
      // Exact key match is highest priority
      if (keyLower === term) score += 10;
      else if (keyLower.includes(term)) score += 5;

      // Value contains term
      if (valueLower.includes(term)) score += 3;

      // Author match
      if (authorLower.includes(term)) score += 2;

      // Tag match
      for (const tag of tagsLower) {
        if (tag === term) score += 4;
        else if (tag.includes(term)) score += 2;
      }

      // Fuzzy: check for partial matches with edit distance tolerance
      if (score === 0) {
        if (fuzzyMatch(term, keyLower)) score += 2;
        if (fuzzyMatch(term, valueLower)) score += 1;
      }
    }

    return { ...entry, _score: score };
  });

  return scored
    .filter(e => e._score > 0)
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...entry }) => entry);
}

/**
 * Get entries that changed since a given timestamp.
 *
 * @param {string} teamName
 * @param {number} sinceTimestamp - Unix ms timestamp
 * @returns {Promise<{ added: object[], updated: object[], count: number }>}
 */
export async function getMemoryDiff(teamName, sinceTimestamp) {
  const entries = await getAllTeamMemory(teamName);
  const changed = entries.filter(e => e.timestamp > sinceTimestamp);

  return {
    added: changed,
    updated: [], // All entries returned as "added" — callers can diff by key if needed
    count: changed.length,
    since: sinceTimestamp,
    asOf: Date.now(),
  };
}

// ── Utility Helpers ──────────────────────────────────────────────────────────

/**
 * Simple fuzzy match: checks if characters of needle appear in order in haystack.
 */
function fuzzyMatch(needle, haystack) {
  if (needle.length > haystack.length) return false;
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni++;
  }
  return ni === needle.length && needle.length >= 3;
}

/**
 * Convert ms duration to human-readable age string.
 */
function humanAge(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ── Default Export ───────────────────────────────────────────────────────────

export default {
  writeTeamMemory,
  readTeamMemory,
  getAllTeamMemory,
  syncToAgent,
  syncFromAgent,
  searchTeamMemory,
  getMemoryDiff,
  scanForSecrets,
};
