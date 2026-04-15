/**
 * auto-dream.js — Background Memory Consolidation for TamerClaw Agents
 *
 * Adapted from Claude Code's autoDream system. Periodically consolidates
 * recent session transcripts into durable, deduplicated long-term memory.
 *
 * The "dream" metaphor: like human sleep consolidation, the agent reviews
 * recent experiences and distills them into lasting knowledge.
 *
 * Lock file: {TAMERCLAW_HOME}/shared/.dream-lock-{agentId}.json
 * State file: {TAMERCLAW_HOME}/shared/.dream-state-{agentId}.json
 *
 * @module auto-dream
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

const SHARED_DIR = path.join(BASE_DIR, 'core', 'shared');
const AGENTS_DIR = path.join(BASE_DIR, 'agents');

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 5;
const MAX_SESSION_FILES = 20;
const MAX_MEMORY_FILES = 40;
const LOCK_STALE_MS = 300_000; // 5 minutes

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} agentId
 * @returns {string}
 */
function lockPath(agentId) {
  return path.join(SHARED_DIR, `.dream-lock-${agentId}.json`);
}

/**
 * @param {string} agentId
 * @returns {string}
 */
function statePath(agentId) {
  return path.join(SHARED_DIR, `.dream-state-${agentId}.json`);
}

/**
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
async function readJSONSafe(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {*} data
 */
async function writeJSONAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

/**
 * Parse YAML frontmatter from a markdown file.
 * @param {string} content
 * @returns {{frontmatter: Object, body: string}}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fmBlock = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of fmBlock.split('\n')) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (kvMatch) {
      let val = kvMatch[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val.startsWith('[') && val.endsWith(']')) {
        try { val = JSON.parse(val); } catch { /* keep as string */ }
      }
      frontmatter[kvMatch[1]] = val;
    }
  }

  return { frontmatter, body };
}

// ── AutoDream Class ─────────────────────────────────────────────────────────

export class AutoDream {
  /**
   * @param {Object} [options]
   * @param {number} [options.minHours=24]      - Minimum hours between consolidations
   * @param {number} [options.minSessions=5]    - Minimum sessions before consolidation
   * @param {number} [options.maxSessionFiles=20] - Max session files to review
   * @param {number} [options.maxMemoryFiles=40]  - Max memory files to read
   * @param {Function} [options.onProgress]     - (message) => void
   * @param {Function} [options.consolidateFn]  - Custom consolidation function
   */
  constructor(options = {}) {
    this.minHours = options.minHours ?? DEFAULT_MIN_HOURS;
    this.minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS;
    this.maxSessionFiles = options.maxSessionFiles ?? MAX_SESSION_FILES;
    this.maxMemoryFiles = options.maxMemoryFiles ?? MAX_MEMORY_FILES;
    this._onProgress = options.onProgress ?? ((msg) => console.log(`[auto-dream] ${msg}`));
    this._consolidateFn = options.consolidateFn ?? null;

    /** @type {{ lastRun: string|null, sessionsReviewed: number, isRunning: boolean }} */
    this._status = { lastRun: null, sessionsReviewed: 0, isRunning: false };
  }

  // ── Gate Checks ─────────────────────────────────────────────────────────

  /**
   * Check all gates (cheapest first). Returns true if all pass.
   *
   * @param {string} agentId
   * @returns {Promise<boolean>}
   */
  async isGateOpen(agentId) {
    // Gate 1: Time since last consolidation
    if (!(await this.checkTimeGate(agentId))) return false;

    // Gate 2: Enough new sessions accumulated
    if (!(await this.checkSessionGate(agentId))) return false;

    return true;
  }

  /**
   * Check if enough time has passed since last consolidation.
   *
   * @param {string} agentId
   * @param {number} [minHours] - Override minimum hours
   * @returns {Promise<boolean>}
   */
  async checkTimeGate(agentId, minHours) {
    const hours = minHours ?? this.minHours;
    const state = await readJSONSafe(statePath(agentId));
    if (!state?.lastRun) return true; // Never run before

    const elapsed = Date.now() - new Date(state.lastRun).getTime();
    const minMs = hours * 60 * 60 * 1000;
    return elapsed >= minMs;
  }

  /**
   * Check if enough new sessions have accumulated.
   *
   * @param {string} agentId
   * @param {number} [minSessions] - Override minimum session count
   * @returns {Promise<boolean>}
   */
  async checkSessionGate(agentId, minSessions) {
    const threshold = minSessions ?? this.minSessions;
    const state = await readJSONSafe(statePath(agentId));
    const sessionsSince = state?.sessionsSinceDream ?? 0;
    return sessionsSince >= threshold;
  }

  // ── Consolidation ─────────────────────────────────────────────────────

  /**
   * Run the full consolidation cycle for an agent.
   *
   * 1. Acquire lock
   * 2. Gather recent sessions and existing memories
   * 3. Build consolidation prompt
   * 4. Execute consolidation (via consolidateFn or return prompt)
   * 5. Update state, release lock
   *
   * @param {string} agentId
   * @returns {Promise<{dreamed: boolean, prompt: string|null, sessionsReviewed: number, duration: number, error: string|null}>}
   */
  async run(agentId) {
    const startTime = Date.now();
    this._status.isRunning = true;

    const result = {
      dreamed: false,
      prompt: null,
      sessionsReviewed: 0,
      duration: 0,
      error: null,
    };

    // Check gates
    const gateOpen = await this.isGateOpen(agentId);
    if (!gateOpen) {
      this._onProgress(`Gates not open for ${agentId}, skipping dream`);
      this._status.isRunning = false;
      result.duration = Date.now() - startTime;
      return result;
    }

    // Acquire lock
    const priorMtime = await this.acquireLock(agentId);
    if (priorMtime === null) {
      this._onProgress(`Could not acquire lock for ${agentId}`);
      this._status.isRunning = false;
      result.duration = Date.now() - startTime;
      result.error = 'Lock acquisition failed';
      return result;
    }

    try {
      this._onProgress(`Starting dream cycle for ${agentId}`);

      // Gather recent session IDs
      const sessionIds = await this._gatherSessionIds(agentId);
      result.sessionsReviewed = sessionIds.length;
      this._status.sessionsReviewed = sessionIds.length;

      if (sessionIds.length === 0) {
        this._onProgress(`No sessions to consolidate for ${agentId}`);
        result.duration = Date.now() - startTime;
        return result;
      }

      // Build the consolidation prompt
      const prompt = await this.buildPrompt(agentId, sessionIds);
      result.prompt = prompt;

      // Execute consolidation if a function is provided
      if (this._consolidateFn) {
        try {
          await this._consolidateFn(agentId, prompt);
          result.dreamed = true;
        } catch (err) {
          result.error = err.message;
          this._onProgress(`Consolidation failed for ${agentId}: ${err.message}`);
          await this.rollbackLock(agentId, priorMtime);
          return result;
        }
      } else {
        // No consolidation function — caller will use the prompt
        result.dreamed = true;
      }

      // Update state
      const state = (await readJSONSafe(statePath(agentId))) || {};
      state.lastRun = new Date().toISOString();
      state.sessionsSinceDream = 0;
      state.totalDreams = (state.totalDreams || 0) + 1;
      state.lastResult = {
        sessionsReviewed: result.sessionsReviewed,
        durationMs: Date.now() - startTime,
      };
      await writeJSONAtomic(statePath(agentId), state);

      this._status.lastRun = state.lastRun;
      this._onProgress(
        `Dream complete for ${agentId}: reviewed ${result.sessionsReviewed} sessions in ${Date.now() - startTime}ms`
      );
    } finally {
      await this.releaseLock(agentId);
      this._status.isRunning = false;
      result.duration = Date.now() - startTime;
    }

    return result;
  }

  /**
   * Build the consolidation prompt for an LLM to process.
   *
   * The prompt instructs the LLM to:
   * 1. Review recent session transcripts
   * 2. Identify key decisions, patterns, preferences
   * 3. Update/consolidate memory files (merge duplicates, remove stale)
   * 4. Keep memory concise and actionable
   *
   * @param {string} agentId
   * @param {string[]} sessionIds - Session file names to review
   * @returns {Promise<string>}
   */
  async buildPrompt(agentId, sessionIds) {
    // Read existing memories
    const memDir = path.join(AGENTS_DIR, agentId, 'memory');
    const existingMemories = await this._readMemories(memDir);

    // Read session contents
    const sessionDir = path.join(AGENTS_DIR, agentId, 'memory', 'sessions');
    const dailyDir = path.join(AGENTS_DIR, agentId, 'memory');
    const sessionContents = [];

    for (const sid of sessionIds.slice(0, this.maxSessionFiles)) {
      // Try sessions/ subdirectory first, then daily logs in memory/
      let content = null;
      for (const dir of [sessionDir, dailyDir]) {
        try {
          content = await fs.readFile(path.join(dir, sid), 'utf-8');
          break;
        } catch { /* try next */ }
      }
      if (content) {
        sessionContents.push({ id: sid, content: content.slice(0, 3000) });
      }
    }

    const memoryList = existingMemories
      .map(m => `- [${m.relativePath}] ${m.name}: ${m.description}`)
      .join('\n') || '(no existing memories)';

    const sessionList = sessionContents
      .map(s => `### ${s.id}\n${s.content}`)
      .join('\n\n---\n\n');

    return `You are a memory consolidation system for agent "${agentId}".
You are "dreaming" — processing recent experiences into long-term memory.

## Current Long-Term Memories
${memoryList}

## Recent Sessions to Process (${sessionContents.length} sessions)
${sessionList || '(no session content available)'}

## Instructions
Review the recent sessions and produce memory operations as valid JSON:

{
  "create": [
    {"title": "...", "type": "fact|decision|preference|context|project", "content": "...", "tags": ["..."]}
  ],
  "update": [
    {"file": "relative/path.md", "reason": "what changed", "newContent": "updated content"}
  ],
  "prune": [
    {"file": "relative/path.md", "reason": "why remove this memory"}
  ]
}

## Rules
1. **Identify key decisions** — What was decided? Why? What were the alternatives?
2. **Spot patterns** — Recurring themes, preferences, workflows the agent follows
3. **Merge duplicates** — If two memories cover the same topic, update one and prune the other
4. **Remove stale info** — If a recent session contradicts an old memory, prune the old one
5. **Keep it concise** — Each memory should be a focused, actionable piece of knowledge
6. **Max operations** — At most 5 creates, 5 updates, 3 prunes per cycle
7. **Preserve important context** — Don't prune memories that are still actively relevant

Return ONLY valid JSON, no markdown fencing or explanation.`;
  }

  // ── Lock Management ───────────────────────────────────────────────────

  /**
   * Acquire an exclusive lock for dream consolidation.
   *
   * @param {string} agentId
   * @returns {Promise<number|null>} The prior mtime (for rollback) or null if lock failed
   */
  async acquireLock(agentId) {
    const lp = lockPath(agentId);

    // Check for stale lock
    try {
      const stat = await fs.stat(lp);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        this._onProgress(`Removing stale lock for ${agentId}`);
        await fs.unlink(lp);
      } else {
        // Lock is held and not stale
        return null;
      }
    } catch {
      // No existing lock — good
    }

    // Get prior state mtime for rollback
    let priorMtime = 0;
    try {
      const stateStat = await fs.stat(statePath(agentId));
      priorMtime = stateStat.mtimeMs;
    } catch {
      // No prior state
    }

    // Attempt exclusive lock creation
    try {
      await fs.writeFile(lp, JSON.stringify({
        pid: process.pid,
        agentId,
        startedAt: new Date().toISOString(),
      }), { flag: 'wx' }); // exclusive create
      return priorMtime;
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      throw err;
    }
  }

  /**
   * Release the dream lock.
   *
   * @param {string} agentId
   * @returns {Promise<void>}
   */
  async releaseLock(agentId) {
    try {
      await fs.unlink(lockPath(agentId));
    } catch {
      // Already released or never acquired
    }
  }

  /**
   * Roll back the lock by restoring the state file's mtime.
   * Used when consolidation fails and we want to allow a retry.
   *
   * @param {string} agentId
   * @param {number} priorMtime - The mtime to restore
   * @returns {Promise<void>}
   */
  async rollbackLock(agentId, priorMtime) {
    await this.releaseLock(agentId);

    // If there was a prior state, touch it back to the old mtime
    // so the time gate doesn't block immediate retry
    if (priorMtime > 0) {
      try {
        const sp = statePath(agentId);
        const state = await readJSONSafe(sp);
        if (state) {
          // Reset lastRun to what it was before
          // (we don't actually modify lastRun — we just didn't save the new state)
          // The rollback means the state file was never updated, so no action needed
        }
      } catch {
        // Best effort
      }
    }
  }

  // ── Status ────────────────────────────────────────────────────────────

  /**
   * Get the current status of the dream system.
   *
   * @returns {{ lastRun: string|null, sessionsReviewed: number, isRunning: boolean }}
   */
  getStatus() {
    return { ...this._status };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Gather session file IDs that have not been consolidated yet.
   *
   * @param {string} agentId
   * @returns {Promise<string[]>}
   * @private
   */
  async _gatherSessionIds(agentId) {
    const ids = [];

    // Check sessions/ subdirectory
    const sessionDir = path.join(AGENTS_DIR, agentId, 'memory', 'sessions');
    try {
      const entries = await fs.readdir(sessionDir);
      const mdFiles = entries.filter(f => f.endsWith('.md')).sort();
      ids.push(...mdFiles.slice(-this.maxSessionFiles));
    } catch { /* no sessions dir */ }

    // Also check daily log files (YYYY-MM-DD.md)
    const memDir = path.join(AGENTS_DIR, agentId, 'memory');
    try {
      const entries = await fs.readdir(memDir);
      const dailyFiles = entries
        .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort();
      // Only include recent daily files (last 7 days)
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const recent = dailyFiles.filter(f => f.replace('.md', '') >= cutoff);
      ids.push(...recent);
    } catch { /* no memory dir */ }

    return ids;
  }

  /**
   * Read all memory files from an agent's memory directory.
   *
   * @param {string} memDir
   * @returns {Promise<Array<{relativePath: string, name: string, description: string}>>}
   * @private
   */
  async _readMemories(memDir) {
    const results = [];

    const scanDir = async (dir, prefix = '') => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (results.length >= this.maxMemoryFiles) break;

        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'sessions') continue;
          await scanDir(path.join(dir, entry.name), path.join(prefix, entry.name));
          continue;
        }

        if (!entry.name.endsWith('.md')) continue;
        // Skip daily logs
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue;

        try {
          const content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);
          results.push({
            relativePath: path.join(prefix, entry.name),
            name: frontmatter.name || entry.name.replace('.md', ''),
            description: frontmatter.description || body.slice(0, 150).replace(/\n/g, ' '),
          });
        } catch { /* skip unreadable */ }
      }
    };

    await scanDir(memDir);
    return results;
  }
}

// ── Convenience: record a session for gate tracking ─────────────────────────

/**
 * Increment the session counter so the session gate knows when to trigger.
 * Call this at the end of each agent session.
 *
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export async function recordSession(agentId) {
  const sp = statePath(agentId);
  const state = (await readJSONSafe(sp)) || {
    lastRun: null,
    sessionsSinceDream: 0,
    totalDreams: 0,
  };
  state.sessionsSinceDream = (state.sessionsSinceDream || 0) + 1;
  await writeJSONAtomic(sp, state);
}

export default AutoDream;
