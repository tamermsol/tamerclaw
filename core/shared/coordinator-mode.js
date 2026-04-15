/**
 * coordinator-mode.js — Multi-Agent Coordinator for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's Coordinator Mode architecture.
 * Enables true multi-agent orchestration:
 *   - Spawns parallel workers with isolated contexts
 *   - Workers report back via structured notifications
 *   - Shared scratchpad for cross-worker state
 *   - Automatic result aggregation and conflict resolution
 *   - Timeout and failure handling per worker
 *
 * The coordinator is NOT a message router — it's a task orchestrator.
 * It breaks a complex task into subtasks, dispatches them to workers,
 * monitors progress, and assembles the final result.
 *
 * Usage:
 *   import { Coordinator, createCoordinator } from './coordinator-mode.js';
 *
 *   const coord = createCoordinator('supreme', {
 *     maxWorkers: 5,
 *     timeout: 120000,
 *   });
 *
 *   coord.dispatch({
 *     task: 'Build the dashboard',
 *     subtasks: [
 *       { id: 'api', agent: 'fullstack', prompt: 'Create REST endpoints...' },
 *       { id: 'ui', agent: 'flutter', prompt: 'Build dashboard screen...' },
 *     ],
 *     onComplete: (results) => { ... },
 *   });
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import paths from './paths.js';
import { feature } from './feature-flags.js';

// ── Worker States ───────────────────────────────────────────────────────
export const WORKER_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
};

// ── Coordination States ─────────────────────────────────────────────────
export const COORD_STATE = {
  IDLE: 'idle',
  DISPATCHING: 'dispatching',
  RUNNING: 'running',
  AGGREGATING: 'aggregating',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

// ── Notification Types ──────────────────────────────────────────────────
export const NOTIFICATION = {
  PROGRESS: 'progress',       // Worker reports progress
  RESULT: 'result',           // Worker completed with result
  ERROR: 'error',             // Worker encountered error
  QUESTION: 'question',       // Worker needs clarification
  HANDOFF: 'handoff',         // Worker hands off to another worker
  SCRATCHPAD: 'scratchpad',   // Worker writes to shared scratchpad
};

// ── Default Options ─────────────────────────────────────────────────────
const DEFAULT_OPTS = {
  maxWorkers: 5,              // Max concurrent workers
  defaultTimeout: 120000,     // 2 minutes per worker
  retryOnFailure: true,       // Retry failed workers once
  maxRetries: 1,
  aggregationStrategy: 'collect',  // 'collect' | 'merge' | 'custom'
  scratchpadEnabled: true,
  notifyOnProgress: true,
};

// ── Worker ──────────────────────────────────────────────────────────────
class Worker {
  constructor(subtask, opts = {}) {
    this.id = subtask.id || `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.agent = subtask.agent;
    this.prompt = subtask.prompt;
    this.dependencies = subtask.dependencies || [];   // IDs of workers this depends on
    this.priority = subtask.priority || 0;
    this.timeout = subtask.timeout || opts.defaultTimeout || DEFAULT_OPTS.defaultTimeout;
    this.state = WORKER_STATE.PENDING;
    this.result = null;
    this.error = null;
    this.retries = 0;
    this.maxRetries = opts.maxRetries ?? DEFAULT_OPTS.maxRetries;
    this.startedAt = null;
    this.completedAt = null;
    this.notifications = [];
    this._timer = null;
    this._abortController = null;
  }

  start() {
    this.state = WORKER_STATE.RUNNING;
    this.startedAt = Date.now();
    this._abortController = new AbortController();

    // Start timeout timer
    this._timer = setTimeout(() => {
      if (this.state === WORKER_STATE.RUNNING) {
        this.state = WORKER_STATE.TIMEOUT;
        this.error = `Worker ${this.id} timed out after ${this.timeout}ms`;
        this.completedAt = Date.now();
        this._abortController?.abort();
      }
    }, this.timeout);
  }

  complete(result) {
    if (this._timer) clearTimeout(this._timer);
    this.state = WORKER_STATE.COMPLETED;
    this.result = result;
    this.completedAt = Date.now();
  }

  fail(error) {
    if (this._timer) clearTimeout(this._timer);
    this.state = WORKER_STATE.FAILED;
    this.error = typeof error === 'string' ? error : error.message;
    this.completedAt = Date.now();
  }

  cancel() {
    if (this._timer) clearTimeout(this._timer);
    this.state = WORKER_STATE.CANCELLED;
    this.completedAt = Date.now();
    this._abortController?.abort();
  }

  canRetry() {
    return this.retries < this.maxRetries &&
      (this.state === WORKER_STATE.FAILED || this.state === WORKER_STATE.TIMEOUT);
  }

  retry() {
    this.retries++;
    this.state = WORKER_STATE.PENDING;
    this.result = null;
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
  }

  getDuration() {
    if (!this.startedAt) return 0;
    return (this.completedAt || Date.now()) - this.startedAt;
  }

  toJSON() {
    return {
      id: this.id,
      agent: this.agent,
      state: this.state,
      priority: this.priority,
      retries: this.retries,
      duration: this.getDuration(),
      hasResult: this.result !== null,
      error: this.error,
    };
  }
}

// ── Scratchpad ──────────────────────────────────────────────────────────
class Scratchpad {
  constructor() {
    this._data = new Map();
    this._log = [];
  }

  write(key, value, workerId) {
    this._data.set(key, { value, writtenBy: workerId, at: Date.now() });
    this._log.push({ type: 'write', key, workerId, at: Date.now() });
  }

  read(key) {
    const entry = this._data.get(key);
    return entry ? entry.value : undefined;
  }

  readAll() {
    const result = {};
    for (const [key, entry] of this._data) {
      result[key] = entry.value;
    }
    return result;
  }

  has(key) {
    return this._data.has(key);
  }

  getLog() {
    return [...this._log];
  }

  clear() {
    this._data.clear();
    this._log = [];
  }
}

// ── Coordinator ─────────────────────────────────────────────────────────
export class Coordinator extends EventEmitter {
  /**
   * @param {string} ownerId - Agent that owns this coordinator
   * @param {object} [opts]
   */
  constructor(ownerId, opts = {}) {
    super();
    this.ownerId = ownerId;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.state = COORD_STATE.IDLE;
    this.workers = new Map();
    this.scratchpad = new Scratchpad();
    this._taskDescription = null;
    this._onComplete = null;
    this._onError = null;
    this._dispatchFn = opts.dispatchFn || null;  // How to actually send work to agents
    this._stats = {
      dispatches: 0,
      workersSpawned: 0,
      workersCompleted: 0,
      workersFailed: 0,
      retries: 0,
    };
  }

  /**
   * Dispatch a coordinated task with subtasks.
   * @param {object} task
   * @param {string} task.description - What we're building
   * @param {Array} task.subtasks - [{id, agent, prompt, dependencies?, priority?, timeout?}]
   * @param {Function} [task.onComplete] - Called with aggregated results
   * @param {Function} [task.onError] - Called on coordination failure
   * @returns {Promise<object>} Aggregated results
   */
  async dispatch(task) {
    if (this.state === COORD_STATE.RUNNING) {
      throw new Error('Coordinator already running. Cancel current task first.');
    }

    this.state = COORD_STATE.DISPATCHING;
    this._taskDescription = task.description;
    this._onComplete = task.onComplete || null;
    this._onError = task.onError || null;
    this._stats.dispatches++;

    // Create workers from subtasks
    this.workers.clear();
    this.scratchpad.clear();

    for (const subtask of task.subtasks) {
      const worker = new Worker(subtask, this.opts);
      this.workers.set(worker.id, worker);
      this._stats.workersSpawned++;
    }

    this.state = COORD_STATE.RUNNING;
    this.emit('dispatch', { task: task.description, workers: this.workers.size });

    try {
      // Execute workers respecting dependencies
      await this._executeWorkers();

      // Aggregate results
      this.state = COORD_STATE.AGGREGATING;
      const results = this._aggregate();

      this.state = COORD_STATE.COMPLETED;
      this.emit('complete', results);
      this._onComplete?.(results);

      return results;
    } catch (err) {
      this.state = COORD_STATE.FAILED;
      this.emit('error', err);
      this._onError?.(err);
      throw err;
    }
  }

  /**
   * Send a notification from a worker.
   * @param {string} workerId
   * @param {string} type - NOTIFICATION type
   * @param {any} payload
   */
  notify(workerId, type, payload) {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    const notification = { workerId, type, payload, at: Date.now() };
    worker.notifications.push(notification);

    if (type === NOTIFICATION.SCRATCHPAD && this.opts.scratchpadEnabled) {
      this.scratchpad.write(payload.key, payload.value, workerId);
    }

    this.emit('notification', notification);
  }

  /**
   * Complete a worker externally (when the agent finishes).
   * @param {string} workerId
   * @param {any} result
   */
  completeWorker(workerId, result) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.state !== WORKER_STATE.RUNNING) return;

    worker.complete(result);
    this._stats.workersCompleted++;
    this.emit('worker:complete', { workerId, result });
  }

  /**
   * Fail a worker externally.
   * @param {string} workerId
   * @param {string} error
   */
  failWorker(workerId, error) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.state !== WORKER_STATE.RUNNING) return;

    worker.fail(error);
    this._stats.workersFailed++;

    // Auto-retry
    if (this.opts.retryOnFailure && worker.canRetry()) {
      worker.retry();
      this._stats.retries++;
      this.emit('worker:retry', { workerId, retries: worker.retries });
    } else {
      this.emit('worker:failed', { workerId, error });
    }
  }

  /**
   * Cancel all workers and the coordination.
   */
  cancel() {
    for (const worker of this.workers.values()) {
      if (worker.state === WORKER_STATE.RUNNING || worker.state === WORKER_STATE.PENDING) {
        worker.cancel();
      }
    }
    this.state = COORD_STATE.IDLE;
    this.emit('cancelled');
  }

  /**
   * Get coordination status.
   * @returns {object}
   */
  getStatus() {
    const workers = {};
    for (const [id, w] of this.workers) {
      workers[id] = w.toJSON();
    }

    return {
      ownerId: this.ownerId,
      state: this.state,
      task: this._taskDescription,
      workers,
      workerCount: this.workers.size,
      completed: [...this.workers.values()].filter(w => w.state === WORKER_STATE.COMPLETED).length,
      failed: [...this.workers.values()].filter(w => w.state === WORKER_STATE.FAILED).length,
      running: [...this.workers.values()].filter(w => w.state === WORKER_STATE.RUNNING).length,
      pending: [...this.workers.values()].filter(w => w.state === WORKER_STATE.PENDING).length,
      scratchpad: this.scratchpad.readAll(),
      stats: { ...this._stats },
    };
  }

  /**
   * Get a human-readable progress line.
   */
  progressLine() {
    const status = this.getStatus();
    return `[${this.state}] ${status.completed}/${status.workerCount} done, ${status.running} running, ${status.failed} failed`;
  }

  /**
   * Build a context injection for a worker (includes scratchpad + dependency results).
   * @param {string} workerId
   * @returns {string}
   */
  buildWorkerContext(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) return '';

    let context = `<coordination-context>\n`;
    context += `<task>${this._taskDescription}</task>\n`;
    context += `<worker-id>${workerId}</worker-id>\n`;
    context += `<worker-role>${worker.prompt?.slice(0, 200) || ''}</worker-role>\n`;

    // Include dependency results
    if (worker.dependencies.length > 0) {
      context += `<dependency-results>\n`;
      for (const depId of worker.dependencies) {
        const dep = this.workers.get(depId);
        if (dep?.state === WORKER_STATE.COMPLETED && dep.result) {
          const resultStr = typeof dep.result === 'string' ? dep.result : JSON.stringify(dep.result);
          context += `<result from="${depId}">${resultStr.slice(0, 2000)}</result>\n`;
        }
      }
      context += `</dependency-results>\n`;
    }

    // Include scratchpad
    if (this.opts.scratchpadEnabled) {
      const pad = this.scratchpad.readAll();
      if (Object.keys(pad).length > 0) {
        context += `<scratchpad>\n`;
        for (const [key, value] of Object.entries(pad)) {
          context += `<entry key="${key}">${typeof value === 'string' ? value : JSON.stringify(value)}</entry>\n`;
        }
        context += `</scratchpad>\n`;
      }
    }

    context += `</coordination-context>`;
    return context;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _executeWorkers() {
    // Topological sort by dependencies, then execute in waves
    const executed = new Set();
    const maxIterations = this.workers.size + 5; // Safety bound
    let iteration = 0;

    while (executed.size < this.workers.size && iteration < maxIterations) {
      iteration++;
      const wave = [];

      for (const [id, worker] of this.workers) {
        if (executed.has(id)) continue;
        if (worker.state === WORKER_STATE.CANCELLED) { executed.add(id); continue; }

        // Check if dependencies are met
        const depsComplete = worker.dependencies.every(depId => {
          const dep = this.workers.get(depId);
          return dep && dep.state === WORKER_STATE.COMPLETED;
        });

        // Check if any dependency failed (cascade failure)
        const depFailed = worker.dependencies.some(depId => {
          const dep = this.workers.get(depId);
          return dep && (dep.state === WORKER_STATE.FAILED || dep.state === WORKER_STATE.TIMEOUT);
        });

        if (depFailed) {
          worker.fail(`Dependency failed`);
          executed.add(id);
          continue;
        }

        if (depsComplete && worker.state === WORKER_STATE.PENDING) {
          wave.push(worker);
        }
      }

      if (wave.length === 0) {
        // Check if we're stuck (all remaining have unmet deps)
        const remaining = [...this.workers.values()].filter(w =>
          !executed.has(w.id) && w.state !== WORKER_STATE.CANCELLED
        );
        if (remaining.length > 0 && remaining.every(w => w.state === WORKER_STATE.PENDING)) {
          throw new Error(`Circular dependency detected among workers: ${remaining.map(w => w.id).join(', ')}`);
        }
        break;
      }

      // Sort wave by priority (higher first)
      wave.sort((a, b) => b.priority - a.priority);

      // Limit concurrent workers
      const batch = wave.slice(0, this.opts.maxWorkers);

      // Execute batch in parallel
      await Promise.allSettled(batch.map(worker => this._executeWorker(worker)));

      for (const worker of batch) {
        executed.add(worker.id);
      }
    }
  }

  async _executeWorker(worker) {
    worker.start();
    this.emit('worker:start', { workerId: worker.id, agent: worker.agent });

    try {
      if (this._dispatchFn) {
        // Use provided dispatch function to send work to agent
        const context = this.buildWorkerContext(worker.id);
        const result = await this._dispatchFn({
          workerId: worker.id,
          agent: worker.agent,
          prompt: worker.prompt,
          context,
          signal: worker._abortController?.signal,
        });
        worker.complete(result);
        this._stats.workersCompleted++;
      } else {
        // No dispatch function — write to agent inbox for async pickup
        await this._writeToInbox(worker);
        // Worker stays in RUNNING state until completeWorker() is called externally
        // For now, simulate completion for testing
      }
    } catch (err) {
      worker.fail(err);
      this._stats.workersFailed++;

      if (this.opts.retryOnFailure && worker.canRetry()) {
        worker.retry();
        this._stats.retries++;
        return this._executeWorker(worker);
      }
    }
  }

  async _writeToInbox(worker) {
    const inboxDir = path.join(paths.agentDir(worker.agent), 'inbox');
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    const payload = {
      type: 'coordination-task',
      workerId: worker.id,
      coordinatorId: this.ownerId,
      task: this._taskDescription,
      prompt: worker.prompt,
      context: this.buildWorkerContext(worker.id),
      timestamp: new Date().toISOString(),
      timeout: worker.timeout,
    };

    const filePath = path.join(inboxDir, `coord-${worker.id}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  }

  _aggregate() {
    const results = {};
    const errors = {};

    for (const [id, worker] of this.workers) {
      if (worker.state === WORKER_STATE.COMPLETED) {
        results[id] = worker.result;
      } else if (worker.state === WORKER_STATE.FAILED || worker.state === WORKER_STATE.TIMEOUT) {
        errors[id] = worker.error;
      }
    }

    return {
      task: this._taskDescription,
      results,
      errors,
      scratchpad: this.scratchpad.readAll(),
      allSucceeded: Object.keys(errors).length === 0,
      completedCount: Object.keys(results).length,
      failedCount: Object.keys(errors).length,
      totalWorkers: this.workers.size,
    };
  }
}

// ── Active Coordinators ─────────────────────────────────────────────────
const _coordinators = new Map();

/**
 * Create a new coordinator.
 * @param {string} ownerId
 * @param {object} [opts]
 * @returns {Coordinator}
 */
export function createCoordinator(ownerId, opts = {}) {
  const coord = new Coordinator(ownerId, opts);
  _coordinators.set(ownerId, coord);
  return coord;
}

/**
 * Get an active coordinator.
 * @param {string} ownerId
 * @returns {Coordinator|null}
 */
export function getCoordinator(ownerId) {
  return _coordinators.get(ownerId) || null;
}

/**
 * Get all active coordinators.
 * @returns {Map<string, Coordinator>}
 */
export function getAllCoordinators() {
  return new Map(_coordinators);
}

export default Coordinator;
