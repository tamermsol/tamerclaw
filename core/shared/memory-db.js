/**
 * memory-db.js — SQLite-backed memory store for TamerClaw agents.
 *
 * Each agent gets its own memory.db inside user/agents/{name}/.
 * Stores conversation entries (role, content, metadata) with timestamps.
 * Provides FTS5 full-text search for recall across past conversations.
 *
 * Usage:
 *   import { MemoryDB } from '../shared/memory-db.js';
 *   const mem = new MemoryDB('flutter');  // or new MemoryDB('flutter', { basePath: '/custom' })
 *   mem.addEntry({ role: 'user', content: '...', metadata: { source: 'telegram' } });
 *   const hits = mem.search('APK deploy', 10);
 *   const recent = mem.getRecent(20);
 *   mem.close();
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { paths } from './paths.js';

const DEFAULT_BASE = paths.agents;

// ---------------------------------------------------------------------------
// Schema version — bump when migrations change
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// DDL executed on first open (idempotent via IF NOT EXISTS)
// ---------------------------------------------------------------------------
const INIT_SQL = `
  -- Core entries table
  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    date        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
    role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'summary')),
    content     TEXT    NOT NULL,
    metadata    TEXT             DEFAULT '{}',
    source_file TEXT,
    tokens_est  INTEGER          DEFAULT 0
  );

  -- Indexes for common access patterns
  CREATE INDEX IF NOT EXISTS idx_entries_date      ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_entries_role      ON entries(role);
  CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);

  -- FTS5 virtual table mirroring content for full-text search
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    content,
    role       UNINDEXED,
    date       UNINDEXED,
    metadata   UNINDEXED,
    content=entries,
    content_rowid=id,
    tokenize='porter unicode61 remove_diacritics 2'
  );

  -- Triggers to keep FTS in sync with entries table
  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, content, role, date, metadata)
    VALUES (new.id, new.content, new.role, new.date, new.metadata);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, role, date, metadata)
    VALUES ('delete', old.id, old.content, old.role, old.date, old.metadata);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, role, date, metadata)
    VALUES ('delete', old.id, old.content, old.role, old.date, old.metadata);
    INSERT INTO entries_fts(rowid, content, role, date, metadata)
    VALUES (new.id, new.content, new.role, new.date, new.metadata);
  END;

  -- Meta key-value store for schema version, stats, etc.
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------
export class MemoryDB {
  /**
   * @param {string} agentId   — agent directory name (e.g. 'flutter', 'mark')
   * @param {object} [opts]
   * @param {string} [opts.basePath]  — override base agents directory
   * @param {string} [opts.dbPath]    — provide a full path to the .db file directly
   * @param {boolean} [opts.readonly] — open in readonly mode
   */
  constructor(agentId, opts = {}) {
    this.agentId = agentId;

    const dbPath = opts.dbPath
      || join(opts.basePath || DEFAULT_BASE, agentId, 'memory.db');

    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.dbPath = dbPath;
    this.db = new Database(dbPath, {
      readonly: opts.readonly || false,
      fileMustExist: false,
    });

    // Performance pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -8000');       // 8 MB
    this.db.pragma('busy_timeout = 5000');

    this._initSchema();
    this._prepareStatements();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  _initSchema() {
    this.db.exec(INIT_SQL);

    const row = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    ).get();

    if (!row) {
      this.db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
      ).run(String(SCHEMA_VERSION));
    }
    // Future: compare row.value with SCHEMA_VERSION and run migrations
  }

  _prepareStatements() {
    this._stmtInsert = this.db.prepare(`
      INSERT INTO entries (timestamp, date, role, content, metadata, source_file, tokens_est)
      VALUES (@timestamp, @date, @role, @content, @metadata, @sourceFile, @tokensEst)
    `);

    this._stmtRecent = this.db.prepare(`
      SELECT id, timestamp, date, role, content, metadata, source_file AS sourceFile, tokens_est AS tokensEst
      FROM entries
      ORDER BY id DESC
      LIMIT ?
    `);

    this._stmtRecentByDate = this.db.prepare(`
      SELECT id, timestamp, date, role, content, metadata, source_file AS sourceFile, tokens_est AS tokensEst
      FROM entries
      WHERE date = ?
      ORDER BY id DESC
      LIMIT ?
    `);

    this._stmtSearch = this.db.prepare(`
      SELECT
        e.id,
        e.timestamp,
        e.date,
        e.role,
        e.content,
        e.metadata,
        e.source_file AS sourceFile,
        e.tokens_est  AS tokensEst,
        rank
      FROM entries_fts f
      JOIN entries e ON e.id = f.rowid
      WHERE entries_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this._stmtSearchByRole = this.db.prepare(`
      SELECT
        e.id,
        e.timestamp,
        e.date,
        e.role,
        e.content,
        e.metadata,
        e.source_file AS sourceFile,
        e.tokens_est  AS tokensEst,
        rank
      FROM entries_fts f
      JOIN entries e ON e.id = f.rowid
      WHERE entries_fts MATCH ? AND e.role = ?
      ORDER BY rank
      LIMIT ?
    `);

    this._stmtCount = this.db.prepare('SELECT COUNT(*) AS cnt FROM entries');

    this._stmtDateRange = this.db.prepare(`
      SELECT id, timestamp, date, role, content, metadata, source_file AS sourceFile, tokens_est AS tokensEst
      FROM entries
      WHERE date BETWEEN ? AND ?
      ORDER BY id ASC
    `);

    this._stmtDelete = this.db.prepare('DELETE FROM entries WHERE id = ?');

    this._stmtGetById = this.db.prepare(`
      SELECT id, timestamp, date, role, content, metadata, source_file AS sourceFile, tokens_est AS tokensEst
      FROM entries WHERE id = ?
    `);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add a memory entry.
   * @param {object} entry
   * @param {string} entry.role        — 'user' | 'assistant' | 'system' | 'tool' | 'summary'
   * @param {string} entry.content     — the text content
   * @param {string} [entry.timestamp] — ISO-8601; defaults to now
   * @param {string} [entry.date]      — YYYY-MM-DD; derived from timestamp if absent
   * @param {object} [entry.metadata]  — arbitrary JSON metadata
   * @param {string} [entry.sourceFile]— original .md file if imported
   * @param {number} [entry.tokensEst] — estimated token count
   * @returns {{ id: number }}
   */
  addEntry(entry) {
    const ts = entry.timestamp || new Date().toISOString();
    const date = entry.date || ts.slice(0, 10);
    const metadata = typeof entry.metadata === 'string'
      ? entry.metadata
      : JSON.stringify(entry.metadata || {});

    const info = this._stmtInsert.run({
      timestamp: ts,
      date,
      role: entry.role,
      content: entry.content,
      metadata,
      sourceFile: entry.sourceFile || null,
      tokensEst: entry.tokensEst || Math.ceil((entry.content || '').length / 4),
    });

    return { id: Number(info.lastInsertRowid) };
  }

  /**
   * Add multiple entries in a single transaction.
   * @param {Array<object>} entries
   * @returns {number} count of inserted entries
   */
  addEntries(entries) {
    const tx = this.db.transaction((items) => {
      let count = 0;
      for (const entry of items) {
        this.addEntry(entry);
        count++;
      }
      return count;
    });
    return tx(entries);
  }

  /**
   * Full-text search across memory.
   * @param {string} query   — FTS5 query (supports AND, OR, NOT, "phrase", prefix*)
   * @param {number} [limit=20]
   * @param {object} [opts]
   * @param {string} [opts.role] — filter to specific role
   * @returns {Array<object>}
   */
  search(query, limit = 20, opts = {}) {
    if (!query || !query.trim()) return [];

    // Sanitize: escape double quotes, wrap bare terms for safety
    const sanitized = this._sanitizeFtsQuery(query);

    try {
      if (opts.role) {
        return this._stmtSearchByRole.all(sanitized, opts.role, limit)
          .map(this._parseRow);
      }
      return this._stmtSearch.all(sanitized, limit).map(this._parseRow);
    } catch (err) {
      // If FTS query syntax is invalid, fall back to simple LIKE search
      if (err.message.includes('fts5')) {
        return this._fallbackSearch(query, limit, opts);
      }
      throw err;
    }
  }

  /**
   * Get the most recent entries.
   * @param {number} [count=20]
   * @returns {Array<object>}
   */
  getRecent(count = 20) {
    return this._stmtRecent.all(count).map(this._parseRow).reverse();
  }

  /**
   * Get entries for a specific date.
   * @param {string} date — YYYY-MM-DD
   * @param {number} [limit=100]
   * @returns {Array<object>}
   */
  getByDate(date, limit = 100) {
    return this._stmtRecentByDate.all(date, limit).map(this._parseRow).reverse();
  }

  /**
   * Get entries within a date range (inclusive).
   * @param {string} from — YYYY-MM-DD
   * @param {string} to   — YYYY-MM-DD
   * @returns {Array<object>}
   */
  getDateRange(from, to) {
    return this._stmtDateRange.all(from, to).map(this._parseRow);
  }

  /**
   * Get a single entry by ID.
   * @param {number} id
   * @returns {object|null}
   */
  getById(id) {
    const row = this._stmtGetById.get(id);
    return row ? this._parseRow(row) : null;
  }

  /**
   * Delete an entry by ID.
   * @param {number} id
   * @returns {boolean} true if deleted
   */
  deleteEntry(id) {
    const info = this._stmtDelete.run(id);
    return info.changes > 0;
  }

  /**
   * Get total entry count.
   * @returns {number}
   */
  count() {
    return this._stmtCount.get().cnt;
  }

  /**
   * Get database stats.
   * @returns {object}
   */
  stats() {
    const count = this.count();
    const dates = this.db.prepare(
      'SELECT MIN(date) AS earliest, MAX(date) AS latest, COUNT(DISTINCT date) AS days FROM entries'
    ).get();
    const byRole = this.db.prepare(
      'SELECT role, COUNT(*) AS cnt FROM entries GROUP BY role ORDER BY cnt DESC'
    ).all();
    const sizeBytes = this.db.prepare(
      "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()"
    ).get();

    return {
      agentId: this.agentId,
      dbPath: this.dbPath,
      totalEntries: count,
      earliest: dates?.earliest || null,
      latest: dates?.latest || null,
      uniqueDays: dates?.days || 0,
      byRole: Object.fromEntries((byRole || []).map(r => [r.role, r.cnt])),
      sizeBytes: sizeBytes?.size || 0,
    };
  }

  /**
   * Optimize the FTS index (call periodically or after large imports).
   */
  optimize() {
    this.db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('optimize')");
    this.db.pragma('optimize');
  }

  /**
   * Close the database connection.
   */
  close() {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  _parseRow(row) {
    if (!row) return row;
    try {
      row.metadata = JSON.parse(row.metadata || '{}');
    } catch {
      row.metadata = {};
    }
    return row;
  }

  /**
   * Make a raw user query safe for FTS5.
   * Wraps each token in quotes to prevent syntax errors from special characters.
   */
  _sanitizeFtsQuery(query) {
    // If user explicitly used FTS5 operators, pass through
    if (/\b(AND|OR|NOT|NEAR)\b/.test(query) || query.includes('"')) {
      return query;
    }
    // Split into words, wrap each in quotes, join with space (implicit AND)
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '""';
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
  }

  /**
   * Fallback LIKE-based search when FTS query is invalid.
   */
  _fallbackSearch(query, limit, opts = {}) {
    const pattern = `%${query}%`;
    let sql = `
      SELECT id, timestamp, date, role, content, metadata,
             source_file AS sourceFile, tokens_est AS tokensEst
      FROM entries
      WHERE content LIKE ?
    `;
    const params = [pattern];
    if (opts.role) {
      sql += ' AND role = ?';
      params.push(opts.role);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params).map(this._parseRow);
  }
}

// ---------------------------------------------------------------------------
// Convenience: module-level functions for quick usage
// ---------------------------------------------------------------------------
const _instances = new Map();

/**
 * Get or create a MemoryDB instance for an agent (cached).
 * @param {string} agentId
 * @param {object} [opts]
 * @returns {MemoryDB}
 */
export function getMemory(agentId, opts = {}) {
  const key = opts.dbPath || agentId;
  if (!_instances.has(key)) {
    _instances.set(key, new MemoryDB(agentId, opts));
  }
  return _instances.get(key);
}

/**
 * Add a memory entry for an agent.
 */
export function addEntry(agentId, entry, opts = {}) {
  return getMemory(agentId, opts).addEntry(entry);
}

/**
 * Search an agent's memory.
 */
export function search(agentId, query, limit = 20, opts = {}) {
  return getMemory(agentId, opts).search(query, limit, opts);
}

/**
 * Get recent entries for an agent.
 */
export function getRecent(agentId, count = 20, opts = {}) {
  return getMemory(agentId, opts).getRecent(count);
}

/**
 * Close all cached instances.
 */
export function closeAll() {
  for (const mem of _instances.values()) {
    mem.close();
  }
  _instances.clear();
}

export default MemoryDB;
