/**
 * reactive-store.js — Reactive State Store for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's internal createStore pattern.
 * A minimal pub-sub state system that replaces ad-hoc Maps with
 * proper state-driven behavior:
 *   - Type-safe getState/setState/subscribe
 *   - Middleware pipeline (logging, persistence, validation)
 *   - Computed/derived values
 *   - Selective subscriptions (watch specific keys)
 *   - Optional persistence to disk
 *   - Namespaced stores for agent isolation
 *
 * Usage:
 *   import { createStore, getGlobalStore } from './reactive-store.js';
 *
 *   const store = createStore('agent-state', {
 *     status: 'idle',
 *     messages: 0,
 *     lastActivity: null,
 *   });
 *
 *   // Subscribe to changes
 *   store.subscribe((state, prev) => {
 *     console.log('State changed:', state.status);
 *   });
 *
 *   // Watch specific key
 *   store.watch('status', (newVal, oldVal) => {
 *     console.log(`Status: ${oldVal} → ${newVal}`);
 *   });
 *
 *   // Update state
 *   store.setState({ status: 'running', messages: state.messages + 1 });
 */

import fs from 'fs';
import path from 'path';
import paths from './paths.js';

// ── ReactiveStore ───────────────────────────────────────────────────────
export class ReactiveStore {
  /**
   * @param {string} name - Store name (for debugging/persistence)
   * @param {object} initialState
   * @param {object} [opts]
   * @param {boolean} [opts.persist] - Auto-save to disk
   * @param {string} [opts.persistPath] - Custom persistence path
   * @param {number} [opts.persistDebounce] - Debounce ms for writes (default 1000)
   * @param {boolean} [opts.immutable] - Return frozen state objects
   * @param {Function[]} [opts.middleware] - Middleware pipeline
   */
  constructor(name, initialState = {}, opts = {}) {
    this.name = name;
    this._state = { ...initialState };
    this._subscribers = new Set();
    this._watchers = new Map();     // key → Set<callback>
    this._middleware = opts.middleware || [];
    this._computed = new Map();     // key → deriveFn
    this._persist = opts.persist || false;
    this._persistPath = opts.persistPath || null;
    this._persistDebounce = opts.persistDebounce || 1000;
    this._persistTimer = null;
    this._immutable = opts.immutable ?? false;
    this._history = [];             // State change history (bounded)
    this._maxHistory = opts.maxHistory || 50;
    this._stats = {
      sets: 0,
      gets: 0,
      notifications: 0,
    };

    // Load persisted state if available
    if (this._persist) {
      this._loadPersisted();
    }
  }

  /**
   * Get current state (full or specific key).
   * @param {string} [key] - Optional specific key
   * @returns {any}
   */
  getState(key) {
    this._stats.gets++;

    if (key !== undefined) {
      // Check computed values first
      if (this._computed.has(key)) {
        return this._computed.get(key)(this._state);
      }
      return this._state[key];
    }

    // Return full state with computed values merged in
    const state = { ...this._state };
    for (const [computedKey, deriveFn] of this._computed) {
      state[computedKey] = deriveFn(this._state);
    }

    return this._immutable ? Object.freeze(state) : state;
  }

  /**
   * Update state (shallow merge).
   * @param {object|Function} updater - Object to merge, or (prevState) => newPartial
   * @returns {object} New state
   */
  setState(updater) {
    const prev = { ...this._state };

    // Run updater
    const partial = typeof updater === 'function'
      ? updater(prev)
      : updater;

    if (!partial || typeof partial !== 'object') return this._state;

    // Run middleware pipeline
    let finalPartial = partial;
    for (const mw of this._middleware) {
      const result = mw(finalPartial, prev, this.name);
      if (result === false) return this._state; // Middleware blocked the update
      if (result && typeof result === 'object') finalPartial = result;
    }

    // Apply changes
    Object.assign(this._state, finalPartial);
    this._stats.sets++;

    // Record history
    this._history.push({
      at: Date.now(),
      changed: Object.keys(finalPartial),
      prev: Object.fromEntries(Object.keys(finalPartial).map(k => [k, prev[k]])),
    });
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    // Notify subscribers
    this._notifySubscribers(this._state, prev);

    // Notify key watchers
    for (const key of Object.keys(finalPartial)) {
      if (prev[key] !== this._state[key]) {
        this._notifyWatchers(key, this._state[key], prev[key]);
      }
    }

    // Persist (debounced)
    if (this._persist) {
      this._debouncedPersist();
    }

    return this._state;
  }

  /**
   * Subscribe to all state changes.
   * @param {Function} callback - (newState, prevState) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Watch a specific key for changes.
   * @param {string} key
   * @param {Function} callback - (newValue, oldValue) => void
   * @returns {Function} Unsubscribe function
   */
  watch(key, callback) {
    if (!this._watchers.has(key)) {
      this._watchers.set(key, new Set());
    }
    this._watchers.get(key).add(callback);
    return () => this._watchers.get(key)?.delete(callback);
  }

  /**
   * Register a computed/derived value.
   * @param {string} key - Computed key name
   * @param {Function} deriveFn - (state) => computedValue
   */
  computed(key, deriveFn) {
    this._computed.set(key, deriveFn);
  }

  /**
   * Add middleware to the pipeline.
   * @param {Function} mw - (partial, prevState, storeName) => partial | false
   */
  use(mw) {
    this._middleware.push(mw);
  }

  /**
   * Reset state to initial or provided values.
   * @param {object} [newState]
   */
  reset(newState = {}) {
    const prev = { ...this._state };
    this._state = { ...newState };
    this._notifySubscribers(this._state, prev);
    if (this._persist) this._debouncedPersist();
  }

  /**
   * Get state change history.
   * @param {number} [n] - Last N changes
   * @returns {Array}
   */
  getHistory(n) {
    return n ? this._history.slice(-n) : [...this._history];
  }

  /**
   * Get store stats.
   * @returns {object}
   */
  getStats() {
    return {
      name: this.name,
      keys: Object.keys(this._state).length,
      computedKeys: this._computed.size,
      subscribers: this._subscribers.size,
      watchers: [...this._watchers.entries()].reduce((s, [, set]) => s + set.size, 0),
      historySize: this._history.length,
      ...this._stats,
    };
  }

  /**
   * Snapshot current state (for debugging/serialization).
   * @returns {object}
   */
  snapshot() {
    return {
      name: this.name,
      state: this.getState(),
      at: Date.now(),
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _notifySubscribers(state, prev) {
    for (const cb of this._subscribers) {
      try {
        cb(state, prev);
        this._stats.notifications++;
      } catch (err) {
        console.warn(`[store:${this.name}] Subscriber error: ${err.message}`);
      }
    }
  }

  _notifyWatchers(key, newVal, oldVal) {
    const watchers = this._watchers.get(key);
    if (!watchers) return;
    for (const cb of watchers) {
      try {
        cb(newVal, oldVal);
        this._stats.notifications++;
      } catch (err) {
        console.warn(`[store:${this.name}] Watcher error for '${key}': ${err.message}`);
      }
    }
  }

  _debouncedPersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._savePersisted(), this._persistDebounce);
  }

  _getPersistPath() {
    if (this._persistPath) return this._persistPath;
    const storeDir = path.join(paths.home, 'user', 'stores');
    if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
    return path.join(storeDir, `${this.name}.json`);
  }

  _savePersisted() {
    try {
      const filePath = this._getPersistPath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this._state, null, 2));
    } catch (err) {
      console.warn(`[store:${this.name}] Persist failed: ${err.message}`);
    }
  }

  _loadPersisted() {
    try {
      const filePath = this._getPersistPath();
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        Object.assign(this._state, data);
      }
    } catch (err) {
      console.warn(`[store:${this.name}] Load persisted failed: ${err.message}`);
    }
  }
}

// ── Store Registry ──────────────────────────────────────────────────────
const _stores = new Map();

/**
 * Create a named store.
 * @param {string} name
 * @param {object} initialState
 * @param {object} [opts]
 * @returns {ReactiveStore}
 */
export function createStore(name, initialState = {}, opts = {}) {
  if (_stores.has(name)) {
    return _stores.get(name);
  }
  const store = new ReactiveStore(name, initialState, opts);
  _stores.set(name, store);
  return store;
}

/**
 * Get an existing store by name.
 * @param {string} name
 * @returns {ReactiveStore|null}
 */
export function getStore(name) {
  return _stores.get(name) || null;
}

/**
 * Get or create the global engine store.
 * @returns {ReactiveStore}
 */
export function getGlobalStore() {
  return createStore('global', {
    engineVersion: '1.17.0',
    codename: 'Phoenix',
    activeAgents: [],
    totalMessages: 0,
    lastActivity: null,
    systemHealth: 'unknown',
  });
}

/**
 * Create a namespaced store for an agent.
 * @param {string} agentId
 * @param {object} [initialState]
 * @returns {ReactiveStore}
 */
export function createAgentStore(agentId, initialState = {}) {
  return createStore(`agent:${agentId}`, {
    status: 'idle',
    messages: 0,
    lastMessage: null,
    errors: 0,
    ...initialState,
  }, {
    persist: true,
    persistPath: path.join(paths.agentDir(agentId), 'state.json'),
  });
}

/**
 * List all stores.
 * @returns {Array<{name: string, keys: number}>}
 */
export function listStores() {
  return [..._stores.entries()].map(([name, store]) => ({
    name,
    keys: Object.keys(store._state).length,
    subscribers: store._subscribers.size,
  }));
}

// ── Built-in Middleware ──────────────────────────────────────────────────

/**
 * Logging middleware — logs every state change.
 */
export function loggingMiddleware(partial, prev, storeName) {
  const keys = Object.keys(partial).join(', ');
  console.log(`[store:${storeName}] setState: ${keys}`);
  return partial;
}

/**
 * Validation middleware factory — validates state changes against a schema.
 * @param {object} schema - { key: (value) => boolean }
 */
export function validationMiddleware(schema) {
  return (partial, prev, storeName) => {
    for (const [key, value] of Object.entries(partial)) {
      if (schema[key] && !schema[key](value)) {
        console.warn(`[store:${storeName}] Validation failed for '${key}'`);
        delete partial[key];
      }
    }
    return Object.keys(partial).length > 0 ? partial : false;
  };
}

/**
 * Timestamp middleware — auto-adds updatedAt on every change.
 */
export function timestampMiddleware(partial) {
  return { ...partial, updatedAt: Date.now() };
}

export default ReactiveStore;
