/**
 * task-framework.js — Background Task Framework for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's background task system.
 * A unified task registry that replaces bare activeCalls tracking with:
 *   - Typed task states with lifecycle transitions
 *   - Abort controllers for cancellation
 *   - Progress tracking with percentage/step reporting
 *   - Lifecycle hooks (onStart, onProgress, onComplete, onError)
 *   - Task timeout handling
 *   - Parent-child task relationships
 *   - Task history with retention
 *
 * Usage:
 *   import { TaskRegistry, getTaskRegistry } from './task-framework.js';
 *
 *   const registry = getTaskRegistry();
 *
 *   const task = registry.create({
 *     name: 'transcribe-audio',
 *     agent: 'david',
 *     description: 'Transcribe voice recording with Whisper',
 *     timeout: 300000,
 *   });
 *
 *   task.start();
 *   task.progress(0.5, 'Processed 3 of 6 chunks');
 *   task.complete({ transcript: '...' });
 */

import { EventEmitter } from 'events';

// ── Task States ─────────────────────────────────────────────────────────
export const TASK_STATE = {
  CREATED: 'created',
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
};

// Valid state transitions
const TRANSITIONS = {
  [TASK_STATE.CREATED]:   [TASK_STATE.QUEUED, TASK_STATE.RUNNING, TASK_STATE.CANCELLED],
  [TASK_STATE.QUEUED]:    [TASK_STATE.RUNNING, TASK_STATE.CANCELLED],
  [TASK_STATE.RUNNING]:   [TASK_STATE.COMPLETED, TASK_STATE.FAILED, TASK_STATE.PAUSED, TASK_STATE.CANCELLED, TASK_STATE.TIMEOUT],
  [TASK_STATE.PAUSED]:    [TASK_STATE.RUNNING, TASK_STATE.CANCELLED],
  [TASK_STATE.COMPLETED]: [],
  [TASK_STATE.FAILED]:    [TASK_STATE.QUEUED],  // Can retry
  [TASK_STATE.CANCELLED]: [],
  [TASK_STATE.TIMEOUT]:   [TASK_STATE.QUEUED],  // Can retry
};

// ── Task ────────────────────────────────────────────────────────────────
export class Task extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} [opts.agent]
   * @param {string} [opts.description]
   * @param {number} [opts.timeout] - ms
   * @param {string} [opts.parentId]
   * @param {object} [opts.metadata]
   */
  constructor(opts) {
    super();
    this.id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.name = opts.name;
    this.agent = opts.agent || null;
    this.description = opts.description || '';
    this.state = TASK_STATE.CREATED;
    this.parentId = opts.parentId || null;
    this.childIds = [];
    this.metadata = opts.metadata || {};

    // Progress tracking
    this.progress = { percent: 0, step: null, steps: [], startedAt: null, updatedAt: null };

    // Timing
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.timeout = opts.timeout || 0;
    this._timer = null;

    // Result/Error
    this.result = null;
    this.error = null;

    // Abort
    this.abortController = new AbortController();

    // Retry tracking
    this.retries = 0;
    this.maxRetries = opts.maxRetries || 0;

    // Hooks
    this._hooks = {
      onStart: opts.onStart || null,
      onProgress: opts.onProgress || null,
      onComplete: opts.onComplete || null,
      onError: opts.onError || null,
    };
  }

  /**
   * Transition to a new state.
   * @param {string} newState
   */
  _transition(newState) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid transition: ${this.state} → ${newState} for task ${this.id}`);
    }
    const prev = this.state;
    this.state = newState;
    this.emit('transition', { from: prev, to: newState });
  }

  /**
   * Start the task.
   */
  start() {
    this._transition(TASK_STATE.RUNNING);
    this.startedAt = Date.now();
    this.progress.startedAt = Date.now();

    // Start timeout timer
    if (this.timeout > 0) {
      this._timer = setTimeout(() => {
        if (this.state === TASK_STATE.RUNNING) {
          this._transition(TASK_STATE.TIMEOUT);
          this.error = `Task timed out after ${this.timeout}ms`;
          this.completedAt = Date.now();
          this.abortController.abort();
          this.emit('timeout');
          this._hooks.onError?.({ task: this, error: this.error });
        }
      }, this.timeout);
    }

    this.emit('start');
    this._hooks.onStart?.(this);
    return this;
  }

  /**
   * Report progress.
   * @param {number} percent - 0 to 1
   * @param {string} [step] - Current step description
   */
  reportProgress(percent, step) {
    if (this.state !== TASK_STATE.RUNNING) return;

    this.progress.percent = Math.max(0, Math.min(1, percent));
    this.progress.updatedAt = Date.now();

    if (step) {
      this.progress.step = step;
      this.progress.steps.push({ step, percent, at: Date.now() });
    }

    this.emit('progress', { percent: this.progress.percent, step });
    this._hooks.onProgress?.({ task: this, percent, step });
  }

  /**
   * Complete the task with a result.
   * @param {any} result
   */
  complete(result) {
    if (this._timer) clearTimeout(this._timer);
    this._transition(TASK_STATE.COMPLETED);
    this.result = result;
    this.completedAt = Date.now();
    this.progress.percent = 1;

    this.emit('complete', result);
    this._hooks.onComplete?.({ task: this, result });
  }

  /**
   * Fail the task.
   * @param {string|Error} error
   */
  fail(error) {
    if (this._timer) clearTimeout(this._timer);
    this._transition(TASK_STATE.FAILED);
    this.error = typeof error === 'string' ? error : error.message;
    this.completedAt = Date.now();

    this.emit('failed', this.error);
    this._hooks.onError?.({ task: this, error: this.error });
  }

  /**
   * Cancel the task.
   */
  cancel() {
    if (this._timer) clearTimeout(this._timer);
    this._transition(TASK_STATE.CANCELLED);
    this.completedAt = Date.now();
    this.abortController.abort();
    this.emit('cancelled');
  }

  /**
   * Pause the task.
   */
  pause() {
    this._transition(TASK_STATE.PAUSED);
    this.emit('paused');
  }

  /**
   * Resume a paused task.
   */
  resume() {
    this._transition(TASK_STATE.RUNNING);
    this.emit('resumed');
  }

  /**
   * Retry a failed/timed-out task.
   * @returns {boolean} Whether retry was possible
   */
  retry() {
    if (this.retries >= this.maxRetries) return false;
    if (this.state !== TASK_STATE.FAILED && this.state !== TASK_STATE.TIMEOUT) return false;

    this.retries++;
    this._transition(TASK_STATE.QUEUED);
    this.result = null;
    this.error = null;
    this.completedAt = null;
    this.emit('retry', this.retries);
    return true;
  }

  /**
   * Get the abort signal for this task.
   * @returns {AbortSignal}
   */
  get signal() {
    return this.abortController.signal;
  }

  /**
   * Get task duration in ms.
   * @returns {number}
   */
  getDuration() {
    if (!this.startedAt) return 0;
    return (this.completedAt || Date.now()) - this.startedAt;
  }

  /**
   * Is the task terminal (done, can't be progressed)?
   * @returns {boolean}
   */
  isTerminal() {
    return [TASK_STATE.COMPLETED, TASK_STATE.CANCELLED].includes(this.state);
  }

  /**
   * Is the task active (running or paused)?
   * @returns {boolean}
   */
  isActive() {
    return [TASK_STATE.RUNNING, TASK_STATE.PAUSED, TASK_STATE.QUEUED].includes(this.state);
  }

  /**
   * Human-readable status line.
   * @returns {string}
   */
  statusLine() {
    const pct = Math.round(this.progress.percent * 100);
    const dur = this.getDuration();
    const durStr = dur > 60000 ? `${Math.round(dur / 60000)}m` : `${Math.round(dur / 1000)}s`;
    const step = this.progress.step ? ` — ${this.progress.step}` : '';
    return `[${this.state}] ${this.name} ${pct}% (${durStr})${step}`;
  }

  /**
   * Serialize for JSON.
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      agent: this.agent,
      state: this.state,
      progress: this.progress.percent,
      step: this.progress.step,
      duration: this.getDuration(),
      retries: this.retries,
      error: this.error,
      hasResult: this.result !== null,
      parentId: this.parentId,
      childCount: this.childIds.length,
    };
  }
}

// ── TaskRegistry ────────────────────────────────────────────────────────
export class TaskRegistry extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._tasks = new Map();
    this._history = [];
    this._maxHistory = opts.maxHistory || 200;
    this._stats = {
      created: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
    };
  }

  /**
   * Create and register a new task.
   * @param {object} opts
   * @returns {Task}
   */
  create(opts) {
    const task = new Task(opts);
    this._tasks.set(task.id, task);
    this._stats.created++;

    // Wire up lifecycle events
    task.on('complete', () => {
      this._stats.completed++;
      this.emit('task:complete', task);
      this._archiveIfTerminal(task);
    });

    task.on('failed', () => {
      this._stats.failed++;
      this.emit('task:failed', task);
      this._archiveIfTerminal(task);
    });

    task.on('cancelled', () => {
      this._stats.cancelled++;
      this.emit('task:cancelled', task);
      this._archiveIfTerminal(task);
    });

    task.on('timeout', () => {
      this._stats.timedOut++;
      this.emit('task:timeout', task);
    });

    // If parent specified, link them
    if (opts.parentId) {
      const parent = this._tasks.get(opts.parentId);
      if (parent) parent.childIds.push(task.id);
    }

    this.emit('task:created', task);
    return task;
  }

  /**
   * Get a task by ID.
   * @param {string} id
   * @returns {Task|null}
   */
  get(id) {
    return this._tasks.get(id) || null;
  }

  /**
   * Get all active (non-terminal) tasks.
   * @param {object} [filter]
   * @returns {Task[]}
   */
  getActive(filter = {}) {
    let tasks = [...this._tasks.values()].filter(t => t.isActive());

    if (filter.agent) tasks = tasks.filter(t => t.agent === filter.agent);
    if (filter.name) tasks = tasks.filter(t => t.name === filter.name);

    return tasks;
  }

  /**
   * Get all tasks for an agent.
   * @param {string} agentId
   * @returns {Task[]}
   */
  getByAgent(agentId) {
    return [...this._tasks.values()].filter(t => t.agent === agentId);
  }

  /**
   * Cancel all tasks for an agent.
   * @param {string} agentId
   * @returns {number} Count of cancelled tasks
   */
  cancelByAgent(agentId) {
    let count = 0;
    for (const task of this._tasks.values()) {
      if (task.agent === agentId && task.isActive()) {
        task.cancel();
        count++;
      }
    }
    return count;
  }

  /**
   * Get children of a parent task.
   * @param {string} parentId
   * @returns {Task[]}
   */
  getChildren(parentId) {
    const parent = this._tasks.get(parentId);
    if (!parent) return [];
    return parent.childIds.map(id => this._tasks.get(id)).filter(Boolean);
  }

  /**
   * Get recent task history.
   * @param {number} [n]
   * @returns {Array}
   */
  getHistory(n) {
    return n ? this._history.slice(-n) : [...this._history];
  }

  /**
   * Get registry stats.
   * @returns {object}
   */
  getStats() {
    return {
      active: this.getActive().length,
      total: this._tasks.size,
      history: this._history.length,
      ...this._stats,
    };
  }

  /**
   * Get a summary of all active tasks as a status report.
   * @returns {string}
   */
  statusReport() {
    const active = this.getActive();
    if (active.length === 0) return 'No active tasks.';

    return `Active tasks (${active.length}):\n` +
      active.map(t => `  ${t.statusLine()}`).join('\n');
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _archiveIfTerminal(task) {
    if (!task.isTerminal()) return;

    // Move to history
    this._history.push({
      id: task.id,
      name: task.name,
      agent: task.agent,
      state: task.state,
      duration: task.getDuration(),
      completedAt: task.completedAt,
      error: task.error,
    });

    // Prune history
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    // Remove from active tasks after a delay (allow reads)
    setTimeout(() => {
      this._tasks.delete(task.id);
    }, 30000);
  }
}

// ── Singleton ───────────────────────────────────────────────────────────
let _registry = null;

/**
 * Get or create the global task registry.
 * @returns {TaskRegistry}
 */
export function getTaskRegistry() {
  if (!_registry) {
    _registry = new TaskRegistry();
  }
  return _registry;
}

/**
 * Quick helper: create, start, and return a task.
 * @param {object} opts
 * @returns {Task}
 */
export function startTask(opts) {
  const registry = getTaskRegistry();
  const task = registry.create(opts);
  task.start();
  return task;
}

/**
 * Quick helper: run a function as a tracked task.
 * @param {object} opts - Task options
 * @param {Function} fn - async (task) => result
 * @returns {Promise<any>} Task result
 */
export async function runTask(opts, fn) {
  const task = startTask(opts);
  try {
    const result = await fn(task);
    task.complete(result);
    return result;
  } catch (err) {
    task.fail(err);
    throw err;
  }
}

export default TaskRegistry;
