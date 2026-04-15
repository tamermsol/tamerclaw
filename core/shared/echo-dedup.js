/**
 * echo-dedup.js — Bounded Ring Buffer for Message Deduplication
 *
 * Inspired by Claude Code's BoundedUUIDSet in bridgeMessaging.ts.
 * Prevents processing your own echoed messages in bidirectional bridges.
 *
 * Uses a fixed-size ring buffer to track recently-seen message IDs.
 * When the buffer is full, the oldest entries are automatically evicted.
 * This provides O(1) lookup and constant memory usage.
 *
 * Usage:
 *   import { EchoDedup } from '../shared/echo-dedup.js';
 *
 *   const dedup = new EchoDedup(1000);  // Track last 1000 messages
 *
 *   // When sending a message, mark it
 *   dedup.mark(messageId);
 *
 *   // When receiving a message, check if it's an echo
 *   if (dedup.isEcho(messageId)) {
 *     return; // Skip — this is our own message
 *   }
 *
 *   // Content-based dedup (for messages without stable IDs)
 *   if (dedup.isDuplicate(content, chatId)) {
 *     return; // Skip — duplicate content in same chat
 *   }
 */

import crypto from 'crypto';

// ── BoundedSet (Ring Buffer) ─────────────────────────────────────────────
export class BoundedSet {
  /**
   * @param {number} maxSize - Maximum entries to keep
   */
  constructor(maxSize = 1000) {
    this._maxSize = maxSize;
    this._set = new Set();
    this._ring = new Array(maxSize);
    this._cursor = 0;
  }

  /**
   * Add an entry. If at capacity, evict the oldest.
   * @param {string} value
   * @returns {boolean} true if newly added, false if already present
   */
  add(value) {
    if (this._set.has(value)) return false;

    // Evict the oldest if at capacity
    if (this._set.size >= this._maxSize) {
      const evicted = this._ring[this._cursor];
      if (evicted !== undefined) {
        this._set.delete(evicted);
      }
    }

    this._ring[this._cursor] = value;
    this._set.add(value);
    this._cursor = (this._cursor + 1) % this._maxSize;
    return true;
  }

  /**
   * Check if a value exists in the set.
   * @param {string} value
   * @returns {boolean}
   */
  has(value) {
    return this._set.has(value);
  }

  /**
   * Remove a value.
   * @param {string} value
   * @returns {boolean}
   */
  delete(value) {
    return this._set.delete(value);
  }

  /**
   * Current number of entries.
   * @returns {number}
   */
  get size() {
    return this._set.size;
  }

  /**
   * Clear all entries.
   */
  clear() {
    this._set.clear();
    this._ring.fill(undefined);
    this._cursor = 0;
  }
}

// ── Echo Deduplication ───────────────────────────────────────────────────
export class EchoDedup {
  /**
   * @param {number} [maxSize=1000] - Max tracked message IDs
   * @param {object} [opts]
   * @param {number} [opts.contentTTL=30000] - Content hash TTL in ms (30s default)
   * @param {number} [opts.maxContentHashes=500] - Max content hashes to track
   */
  constructor(maxSize = 1000, opts = {}) {
    // ID-based dedup (for Telegram message_id, etc.)
    this._sentIds = new BoundedSet(maxSize);

    // Content-based dedup (for detecting same content in rapid succession)
    this._contentHashes = new Map(); // hash → timestamp
    this._contentTTL = opts.contentTTL ?? 30000;
    this._maxContentHashes = opts.maxContentHashes ?? 500;

    // Stats
    this._stats = {
      marked: 0,
      echoesBlocked: 0,
      duplicatesBlocked: 0,
    };
  }

  /**
   * Mark a message ID as sent (so we can detect its echo).
   * Call this when YOU send a message.
   *
   * @param {string|number} messageId
   */
  mark(messageId) {
    this._sentIds.add(String(messageId));
    this._stats.marked++;
  }

  /**
   * Check if a message ID is an echo of one we sent.
   * Call this when you RECEIVE a message.
   *
   * @param {string|number} messageId
   * @returns {boolean} true if this is an echo (should be skipped)
   */
  isEcho(messageId) {
    const isEcho = this._sentIds.has(String(messageId));
    if (isEcho) this._stats.echoesBlocked++;
    return isEcho;
  }

  /**
   * Mark content as sent for content-based dedup.
   * @param {string} content
   * @param {string} [chatId] - Scope dedup to a specific chat
   */
  markContent(content, chatId = '') {
    const hash = this._hashContent(content, chatId);
    this._contentHashes.set(hash, Date.now());
    this._pruneContentHashes();
  }

  /**
   * Check if content is a duplicate (sent recently in same chat).
   * @param {string} content
   * @param {string} [chatId]
   * @returns {boolean}
   */
  isDuplicate(content, chatId = '') {
    const hash = this._hashContent(content, chatId);
    const ts = this._contentHashes.get(hash);
    if (ts && Date.now() - ts < this._contentTTL) {
      this._stats.duplicatesBlocked++;
      return true;
    }
    return false;
  }

  /**
   * Combined check: is this message an echo OR a duplicate?
   * @param {string|number} messageId
   * @param {string} content
   * @param {string} [chatId]
   * @returns {boolean}
   */
  shouldSkip(messageId, content, chatId = '') {
    if (messageId && this.isEcho(messageId)) return true;
    if (content && this.isDuplicate(content, chatId)) return true;
    return false;
  }

  /**
   * Get dedup statistics.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      trackedIds: this._sentIds.size,
      trackedHashes: this._contentHashes.size,
    };
  }

  /**
   * Clear all tracked state.
   */
  clear() {
    this._sentIds.clear();
    this._contentHashes.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────

  _hashContent(content, chatId) {
    const input = `${chatId}:${(content || '').trim().slice(0, 200)}`;
    return crypto.createHash('md5').update(input).digest('hex');
  }

  _pruneContentHashes() {
    const now = Date.now();

    // Prune expired entries
    for (const [hash, ts] of this._contentHashes) {
      if (now - ts > this._contentTTL) {
        this._contentHashes.delete(hash);
      }
    }

    // Hard cap
    if (this._contentHashes.size > this._maxContentHashes) {
      const sorted = [...this._contentHashes.entries()]
        .sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, sorted.length - this._maxContentHashes);
      for (const [hash] of toRemove) {
        this._contentHashes.delete(hash);
      }
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────
let _instance = null;

/**
 * Get the global EchoDedup instance.
 * @returns {EchoDedup}
 */
export function getDedup() {
  if (!_instance) {
    _instance = new EchoDedup();
  }
  return _instance;
}

export default EchoDedup;
