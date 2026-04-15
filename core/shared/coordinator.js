/**
 * coordinator.js — Multi-Agent Coordinator for TamerClaw v1.16.0
 *
 * Adapted from Claude Code's coordinatorMode.ts. Orchestrates worker agents
 * through a Research -> Synthesis -> Implementation -> Verification workflow.
 *
 * Key concepts:
 *   - Coordinator spawns workers via spawnWorker()
 *   - Workers report back via <task-notification> XML messages
 *   - Coordinator synthesizes results and directs next steps
 *   - Tool calls are partitioned into concurrent-safe (read) and serial (write) batches
 *
 * @module coordinator
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

const AGENTS_DIR = path.join(BASE_DIR, 'agents');
const TASKS_DIR = path.join(BASE_DIR, 'tasks');
const SCRATCHPAD_DIR = path.join(TASKS_DIR, 'scratchpad');

// ── Workflow Phases ─────────────────────────────────────────────────────────

export const Phase = Object.freeze({
  RESEARCH:       'research',
  SYNTHESIS:      'synthesis',
  IMPLEMENTATION: 'implementation',
  VERIFICATION:   'verification',
});

// ── Worker State ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WorkerHandle
 * @property {string} taskId    - Unique task identifier
 * @property {string} agentId   - Worker's agent identifier
 * @property {string} status    - 'running' | 'completed' | 'failed' | 'stopped'
 * @property {string} description - What the worker is doing
 * @property {string} prompt    - The prompt sent to the worker
 * @property {*}      result    - Worker result (null until completed)
 * @property {string} startedAt - ISO timestamp
 * @property {string|null} completedAt
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} name      - Tool name
 * @property {Object} arguments - Tool arguments
 * @property {string} [id]      - Optional call ID
 */

/**
 * @typedef {Object} Batch
 * @property {boolean} isConcurrencySafe - True if all calls in this batch are read-only
 * @property {ToolCall[]} calls          - Tool calls in this batch
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateTaskId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `task-${ts}-${rand}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJSONSafe(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeJSONAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

// ── Read-only tools that are safe for concurrent execution ──────────────────

const CONCURRENT_SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'ListFiles', 'GetFileInfo', 'SearchMemory', 'ReadMemory',
  'pm2-list', 'pm2-logs', 'pm2-status',
  'git-status', 'git-log', 'git-diff',
]);

// ── Coordinator Class ───────────────────────────────────────────────────────

export class Coordinator {
  /**
   * @param {string} agentId - This coordinator's agent ID
   * @param {Object} [options]
   * @param {number} [options.maxWorkers=4]        - Max concurrent workers
   * @param {number} [options.workerTimeoutMs=300000] - Per-worker timeout
   * @param {Function} [options.onWorkerUpdate]     - (taskId, status, data) => void
   * @param {Function} [options.onProgress]         - (message) => void
   * @param {Function} [options.spawnFn]            - Custom worker spawn function
   */
  constructor(agentId, options = {}) {
    this.agentId = agentId;
    this.maxWorkers = options.maxWorkers ?? 4;
    this.workerTimeoutMs = options.workerTimeoutMs ?? 300_000;
    this._onWorkerUpdate = options.onWorkerUpdate ?? (() => {});
    this._onProgress = options.onProgress ?? ((msg) => console.log(`[coordinator:${agentId}] ${msg}`));
    this._spawnFn = options.spawnFn ?? null;

    /** @type {Map<string, WorkerHandle>} */
    this._workers = new Map();

    /** @type {Map<string, *>} */
    this._results = new Map();
  }

  // ── Worker Management ───────────────────────────────────────────────────

  /**
   * Spawn a new worker agent to handle a subtask.
   *
   * @param {string} description - Human-readable description of what the worker does
   * @param {string} prompt      - The full prompt to send to the worker
   * @param {Object} [options]
   * @param {string} [options.workerId]   - Specific agent ID to use as worker
   * @param {string} [options.model]      - Model override for the worker
   * @param {string} [options.capability] - Required capability tag
   * @param {number} [options.timeoutMs]  - Override default worker timeout
   * @returns {Promise<{taskId: string, agentId: string}>}
   */
  async spawnWorker(description, prompt, options = {}) {
    const taskId = generateTaskId();
    const workerId = options.workerId || `${this.agentId}-worker-${this._workers.size + 1}`;

    // Enforce max concurrent workers
    const active = this.getActiveWorkers();
    if (active.length >= this.maxWorkers) {
      throw new Error(
        `Max concurrent workers reached (${this.maxWorkers}). ` +
        `Active: ${active.map(w => w.taskId).join(', ')}`
      );
    }

    /** @type {WorkerHandle} */
    const handle = {
      taskId,
      agentId: workerId,
      status: 'running',
      description,
      prompt,
      model: options.model || null,
      capability: options.capability || null,
      result: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      timeoutMs: options.timeoutMs ?? this.workerTimeoutMs,
    };

    this._workers.set(taskId, handle);

    // Write task to the worker's inbox
    const inboxDir = path.join(AGENTS_DIR, workerId, 'inbox');
    await ensureDir(inboxDir);
    await writeJSONAtomic(path.join(inboxDir, `task-${taskId}.json`), {
      taskId,
      from: this.agentId,
      to: workerId,
      type: 'coordinator-task',
      description,
      prompt,
      model: handle.model,
      capability: handle.capability,
      timeoutMs: handle.timeoutMs,
      dispatchedAt: handle.startedAt,
    });

    // Write to scratchpad for shared state
    const scratchDir = path.join(SCRATCHPAD_DIR, taskId);
    await ensureDir(scratchDir);
    await writeJSONAtomic(path.join(scratchDir, 'manifest.json'), {
      taskId,
      coordinator: this.agentId,
      worker: workerId,
      description,
      status: 'running',
      startedAt: handle.startedAt,
    });

    // If a custom spawn function is provided, call it
    if (this._spawnFn) {
      try {
        await this._spawnFn(handle);
      } catch (err) {
        handle.status = 'failed';
        handle.result = { error: err.message };
        handle.completedAt = new Date().toISOString();
      }
    }

    this._onProgress(`Spawned worker ${workerId} for task ${taskId}: ${description}`);
    this._onWorkerUpdate(taskId, 'spawned', handle);

    return { taskId, agentId: workerId };
  }

  /**
   * Send a follow-up message to an existing worker.
   *
   * @param {string} agentId - The worker's agent ID
   * @param {string} message - The message to send
   * @returns {Promise<void>}
   */
  async sendToWorker(agentId, message) {
    const inboxDir = path.join(AGENTS_DIR, agentId, 'inbox');
    await ensureDir(inboxDir);

    const msgId = `msg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    await writeJSONAtomic(path.join(inboxDir, `${msgId}.json`), {
      id: msgId,
      from: this.agentId,
      to: agentId,
      type: 'coordinator-message',
      message,
      sentAt: new Date().toISOString(),
    });

    this._onProgress(`Sent message to worker ${agentId}: ${message.slice(0, 100)}`);
  }

  /**
   * Stop/abort a running worker task.
   *
   * @param {string} taskId - The task ID to stop
   * @returns {boolean} True if the worker was found and stopped
   */
  stopWorker(taskId) {
    const handle = this._workers.get(taskId);
    if (!handle || handle.status !== 'running') return false;

    handle.status = 'stopped';
    handle.completedAt = new Date().toISOString();
    this._onWorkerUpdate(taskId, 'stopped', handle);
    this._onProgress(`Stopped worker ${handle.agentId} (task ${taskId})`);
    return true;
  }

  /**
   * List all currently running workers.
   *
   * @returns {WorkerHandle[]}
   */
  getActiveWorkers() {
    const active = [];
    for (const handle of this._workers.values()) {
      if (handle.status === 'running') {
        // Check for timeout
        const elapsed = Date.now() - new Date(handle.startedAt).getTime();
        if (elapsed > handle.timeoutMs) {
          handle.status = 'failed';
          handle.result = { error: 'Worker timed out' };
          handle.completedAt = new Date().toISOString();
          this._onWorkerUpdate(handle.taskId, 'timeout', handle);
          continue;
        }
        active.push(handle);
      }
    }
    return active;
  }

  /**
   * Get the result from a completed worker.
   *
   * @param {string} taskId - The task ID
   * @returns {Promise<*>} The worker's result, or null if not completed
   */
  async getWorkerResult(taskId) {
    const handle = this._workers.get(taskId);
    if (!handle) return null;

    // Check in-memory result first
    if (handle.result !== null) return handle.result;

    // Check worker outbox on disk
    const outboxDir = path.join(AGENTS_DIR, handle.agentId, 'outbox');
    const resultFile = path.join(outboxDir, `result-${taskId}.json`);
    const diskResult = await readJSONSafe(resultFile);

    if (diskResult) {
      handle.result = diskResult;
      handle.status = diskResult.status === 'failed' ? 'failed' : 'completed';
      handle.completedAt = diskResult.completedAt || new Date().toISOString();
      this._onWorkerUpdate(taskId, handle.status, handle);
      return diskResult;
    }

    // Check scratchpad
    const scratchResult = await readJSONSafe(
      path.join(SCRATCHPAD_DIR, taskId, 'result.json')
    );
    if (scratchResult) {
      handle.result = scratchResult;
      handle.status = 'completed';
      handle.completedAt = new Date().toISOString();
      this._onWorkerUpdate(taskId, 'completed', handle);
      return scratchResult;
    }

    return null;
  }

  // ── Task Notification Parsing ─────────────────────────────────────────

  /**
   * Check if a message contains a task notification.
   *
   * @param {string} message - Raw message text
   * @returns {boolean}
   */
  static isTaskNotification(message) {
    if (typeof message !== 'string') return false;
    return message.includes('<task-notification>') && message.includes('</task-notification>');
  }

  /**
   * Parse a <task-notification> XML block from a worker message.
   *
   * Expected format:
   *   <task-notification>
   *     <taskId>task-xyz</taskId>
   *     <status>completed|failed|progress</status>
   *     <summary>What happened</summary>
   *     <result>Optional JSON payload</result>
   *   </task-notification>
   *
   * @param {string} message - Raw message containing the notification
   * @returns {{taskId: string, status: string, summary: string, result: *} | null}
   */
  static parseTaskNotification(message) {
    if (!Coordinator.isTaskNotification(message)) return null;

    const blockMatch = message.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
    if (!blockMatch) return null;

    const block = blockMatch[1];

    const extract = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : null;
    };

    const taskId = extract('taskId');
    const status = extract('status') || 'unknown';
    const summary = extract('summary') || '';
    let result = extract('result');

    // Try to parse result as JSON
    if (result) {
      try { result = JSON.parse(result); } catch { /* keep as string */ }
    }

    return { taskId, status, summary, result };
  }

  // ── Tool Orchestration ────────────────────────────────────────────────

  /**
   * Partition tool calls into batches: concurrent-safe (read-only) calls
   * can run in parallel, while write/mutating calls must run serially.
   *
   * Adapted from Claude Code's toolOrchestration.ts. The algorithm groups
   * consecutive read-only calls into a single concurrent batch, then isolates
   * each write call into its own serial batch.
   *
   * @param {ToolCall[]} toolCalls - Array of tool calls to partition
   * @param {Object} [toolRegistry] - Optional registry with concurrency metadata
   * @param {Set<string>} [toolRegistry.concurrentSafe] - Set of tool names safe for concurrency
   * @returns {Batch[]}
   */
  static partitionToolCalls(toolCalls, toolRegistry = null) {
    if (!toolCalls || toolCalls.length === 0) return [];

    const safeSet = toolRegistry?.concurrentSafe || CONCURRENT_SAFE_TOOLS;

    /** @type {Batch[]} */
    const batches = [];

    /** @type {ToolCall[]} */
    let currentConcurrentBatch = [];

    for (const call of toolCalls) {
      const isSafe = safeSet.has(call.name);

      if (isSafe) {
        // Accumulate into the current concurrent batch
        currentConcurrentBatch.push(call);
      } else {
        // Flush any accumulated concurrent batch first
        if (currentConcurrentBatch.length > 0) {
          batches.push({
            isConcurrencySafe: true,
            calls: currentConcurrentBatch,
          });
          currentConcurrentBatch = [];
        }
        // Write call goes into its own serial batch
        batches.push({
          isConcurrencySafe: false,
          calls: [call],
        });
      }
    }

    // Flush remaining concurrent calls
    if (currentConcurrentBatch.length > 0) {
      batches.push({
        isConcurrencySafe: true,
        calls: currentConcurrentBatch,
      });
    }

    return batches;
  }

  // ── System Prompt Generation ──────────────────────────────────────────

  /**
   * Generate the coordinator system prompt, adapted from Claude Code's
   * coordinatorMode.ts for TamerClaw's multi-agent ecosystem.
   *
   * @param {Object} [workerCapabilities] - Map of agentId -> capability description
   * @returns {string}
   */
  getSystemPrompt(workerCapabilities = {}) {
    const capList = Object.entries(workerCapabilities)
      .map(([id, desc]) => `  - ${id}: ${desc}`)
      .join('\n') || '  (no workers registered)';

    return `You are a Coordinator agent in the TamerClaw multi-agent ecosystem.

## Your Role
You orchestrate complex tasks by breaking them into subtasks, dispatching them to
worker agents, collecting results, and synthesizing a final output.

## Available Workers
${capList}

## Workflow Phases
Follow this sequence for complex tasks:

1. **Research** — Spawn workers to gather information, explore codebases, read docs.
   Use concurrent workers for independent research tasks.

2. **Synthesis** — Review all research results. Identify patterns, conflicts, gaps.
   Decide on the approach before implementation begins.

3. **Implementation** — Spawn workers to make changes. Serial for dependent changes,
   concurrent for independent files/modules.

4. **Verification** — Spawn workers to test, lint, type-check, and review changes.
   Verify the implementation matches the synthesis plan.

## Tools
- **SpawnWorker(description, prompt)** — Create a new worker for a subtask.
  Returns { taskId, agentId }. The worker runs asynchronously.
- **SendToWorker(agentId, message)** — Send a follow-up message to a running worker.
- **StopWorker(taskId)** — Abort a running worker.
- **GetWorkerResult(taskId)** — Retrieve a completed worker's result.

## Prompt Writing Tips
When writing prompts for workers:
- Be specific about what files to read/modify
- Include relevant context from previous phases
- Specify the expected output format
- Set clear success criteria
- Include any constraints (don't modify X, keep Y stable)

## Concurrency Rules
- **Read-only operations** (Grep, Glob, Read, WebSearch) are concurrent-safe.
  Spawn multiple research workers that only read.
- **Write operations** (Edit, Write, Bash) must be serialized.
  Never have two workers editing the same file simultaneously.
- **Mixed operations**: If a worker reads then writes, treat it as serial.
- Partition tool calls: group reads into concurrent batches, writes into serial batches.

## Task Notifications
Workers report status via <task-notification> XML blocks:
  <task-notification>
    <taskId>task-xxx</taskId>
    <status>completed|failed|progress</status>
    <summary>What was done</summary>
    <result>JSON payload</result>
  </task-notification>

Parse these to track progress and decide next steps.

## Guidelines
- Always explain your plan before spawning workers
- Check worker results before proceeding to the next phase
- If a worker fails, decide whether to retry, skip, or adjust the plan
- Keep the scratchpad updated for cross-worker context sharing
- Prefer fewer, well-scoped workers over many tiny ones
- Maximum ${this.maxWorkers} concurrent workers at a time`;
  }

  /**
   * Generate user-context additions for the coordinator prompt.
   * Includes MCP client info and scratchpad directory.
   *
   * @param {Object[]} [mcpClients] - Array of MCP client descriptors
   * @param {string} [scratchpadDir] - Override scratchpad directory
   * @returns {string}
   */
  getUserContext(mcpClients = [], scratchpadDir = null) {
    const scratchpad = scratchpadDir || SCRATCHPAD_DIR;
    const lines = [];

    lines.push(`## Environment`);
    lines.push(`- Coordinator: ${this.agentId}`);
    lines.push(`- Scratchpad: ${scratchpad}`);
    lines.push(`- Active workers: ${this.getActiveWorkers().length}/${this.maxWorkers}`);

    if (mcpClients.length > 0) {
      lines.push('');
      lines.push('## MCP Clients');
      for (const client of mcpClients) {
        lines.push(`- ${client.name || client.id}: ${client.description || 'no description'}`);
        if (client.tools && client.tools.length > 0) {
          for (const tool of client.tools.slice(0, 5)) {
            lines.push(`    - ${tool.name}: ${tool.description || ''}`);
          }
          if (client.tools.length > 5) {
            lines.push(`    ... and ${client.tools.length - 5} more tools`);
          }
        }
      }
    }

    // Include active worker summary
    const active = this.getActiveWorkers();
    if (active.length > 0) {
      lines.push('');
      lines.push('## Active Workers');
      for (const w of active) {
        const elapsed = Math.round((Date.now() - new Date(w.startedAt).getTime()) / 1000);
        lines.push(`- [${w.taskId}] ${w.agentId}: ${w.description} (${elapsed}s elapsed)`);
      }
    }

    // Include recent results
    const completed = [...this._workers.values()].filter(w => w.status === 'completed');
    if (completed.length > 0) {
      lines.push('');
      lines.push('## Recent Results');
      for (const w of completed.slice(-5)) {
        const summary = typeof w.result === 'object' && w.result?.summary
          ? w.result.summary
          : String(w.result).slice(0, 120);
        lines.push(`- [${w.taskId}] ${w.description}: ${summary}`);
      }
    }

    return lines.join('\n');
  }
}

export default Coordinator;
