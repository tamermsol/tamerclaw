/**
 * @file Reactive store — direct port of Claude Code's state/store.ts.
 *
 * Zero-dependency, minimal reactive container.  Components subscribe to
 * state changes and are notified synchronously when `setState` produces
 * a new reference (uses `Object.is` for identity comparison).
 *
 * @module store
 */

/**
 * @template T
 * @typedef {Object} Store
 * @property {() => T}                           getState  - Return current state.
 * @property {(updater: (prev: T) => T) => void} setState  - Update state via updater fn.
 * @property {(listener: () => void) => () => void} subscribe - Register listener; returns unsubscribe fn.
 */

/**
 * @template T
 * @typedef {Object} StateChange
 * @property {T} newState
 * @property {T} oldState
 */

/**
 * Create a reactive store.
 *
 * @template T
 * @param {T} initialState - The initial state value.
 * @param {((change: StateChange<T>) => void)|undefined} [onChange]
 *   Optional callback invoked on every state transition (before per-listener
 *   notifications).  Useful for global side-effects like persistence.
 * @returns {Store<T>}
 */
export function createStore(initialState, onChange) {
  let state = initialState;

  /** @type {Set<() => void>} */
  const listeners = new Set();

  return {
    getState: () => state,

    setState: (updater) => {
      const prev = state;
      const next = updater(prev);
      if (Object.is(next, prev)) return;
      state = next;
      onChange?.({ newState: next, oldState: prev });
      for (const listener of listeners) {
        listener();
      }
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export default createStore;
