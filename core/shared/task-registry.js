/**
 * Task Registry v1.0 — Central task lifecycle engine for Project Autopilot
 *
 * Tracks every task across the entire agent ecosystem with a state machine:
 * RECEIVED → PLANNING → DELEGATED → IN_PROGRESS → REVIEW → DELIVERED
 *                                        ↓
 *                                    ESCALATED → IN_PROGRESS (retry)
 *
 * Atomic file writes, auto-backup, JSONL audit log.
 *
 * Usage:
 *   import { TaskRegistry } from './task-registry.js';
 *   const registry = new TaskRegistry();
 *   const task = registry.createTask({ title, assignedTo, expectedOutput, requestedBy });
 *   registry.updateStatus(taskId, 'in_progress', agentId);
 *   registry.addSubtask(taskId, { assignee, description });
 *   registry.checkIn(taskId, agentId, message, progress);
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

const TASKS_DIR = path.join(BASE_DIR, 'tasks');
const REGISTRY_PATH = path.join(TASKS_DIR, 'registry.json');
const CHECKINS_DIR = path.join(TASKS_DIR, 'checkins');
const COMPLETED_DIR = path.join(TASKS_DIR, 'completed');
const AUDIT_LOG = path.join(TASKS_DIR, 'audit.jsonl');

// Valid status transitions
const VALID_TRANSITIONS = {
  received:      ['planning', 'delegated', 'in_progress', 'cancelled'],
  planning:      ['delegated', 'in_progress', 'cancelled', 'escalated'],
  delegated:     ['in_progress', 'escalated', 'cancelled', 'rate_limited'],
  in_progress:   ['review', 'escalated', 'blocked', 'cancelled', 'rate_limited'],
  review:        ['delivered', 'rejected', 'escalated'],
  rejected:      ['in_progress', 'cancelled'],
  escalated:     ['in_progress', 'cancelled', 'delegated'],
  blocked:       ['in_progress', 'escalated', 'cancelled'],
  rate_limited:  ['in_progress', 'delegated', 'cancelled'],  // resumes back to in_progress when rate limit clears
  delivered:     [],  // terminal
  cancelled:     [],  // terminal
};

const VALID_STATUSES = Object.keys(VALID_TRANSITIONS);

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const dir of [TASKS_DIR, CHECKINS_DIR, COMPLETED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function generateId() {
  const date = new Date().toISOString().slice(0, 10);
  const seq = Date.now().toString(36).slice(-4);
  return `task-${date}-${seq}`;
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function auditLog(entry) {
  try {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    fs.appendFileSync(AUDIT_LOG, line);
  } catch {}
}

// ── TaskRegistry Class ───────────────────────────────────────────────────────

export class TaskRegistry {
  constructor() {
    ensureDirs();
    this._load();
  }

  _load() {
    try {
      this.data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
      if (!this.data.tasks) this.data.tasks = {};
    } catch {
      this.data = { version: 2, tasks: {}, lastSaved: null };
    }
  }

  _save() {
    this.data.lastSaved = new Date().toISOString();
    atomicWrite(REGISTRY_PATH, this.data);
  }

  // ── Create ───────────────────────────────────────────────────────────────

  /**
   * Create a new task in the registry.
   * @param {Object} opts
   * @param {string} opts.title - Short task description
   * @param {string} opts.assignedTo - C-level agent receiving the task
   * @param {string} opts.expectedOutput - What Tim expects as final deliverable
   * @param {string} opts.requestedBy - Who requested (default: 'tim')
   * @param {string} opts.priority - 'critical' | 'high' | 'medium' | 'low'
   * @param {number} opts.deadlineMinutes - Auto-deadline in minutes from now
   * @param {Object} opts.timeouts - Override default timeouts
   * @returns {Object} The created task
   */
  createTask(opts) {
    const id = generateId();
    const now = new Date().toISOString();

    const task = {
      id,
      title: opts.title,
      requestedBy: opts.requestedBy || 'tim',
      assignedTo: opts.assignedTo,
      delegatedTo: [],
      expectedOutput: opts.expectedOutput || '',
      status: 'received',
      priority: opts.priority || 'high',
      createdAt: now,
      updatedAt: now,
      deadline: opts.deadlineMinutes
        ? new Date(Date.now() + opts.deadlineMinutes * 60000).toISOString()
        : null,
      statusHistory: [
        { status: 'received', at: now, by: opts.assignedTo }
      ],
      subtasks: [],
      checkIns: [],
      plan: null,
      deliverables: [],
      timeouts: {
        planningMaxMs:        opts.timeouts?.planningMaxMs        || 300_000,    // 5 min
        delegationMaxMs:      opts.timeouts?.delegationMaxMs      || 600_000,    // 10 min
        progressCheckMs:      opts.timeouts?.progressCheckMs      || 300_000,    // 5 min check-in interval
        escalateAfterMs:      opts.timeouts?.escalateAfterMs      || 600_000,    // 10 min no check-in → escalate
        alertTimAfterMs:      opts.timeouts?.alertTimAfterMs      || 1_200_000,  // 20 min → alert Tim
        totalMaxMs:           opts.timeouts?.totalMaxMs            || 14_400_000, // 4 hours total
      },
    };

    this.data.tasks[id] = task;
    this._save();
    auditLog({ action: 'create', taskId: id, by: opts.assignedTo, title: opts.title });
    return task;
  }

  // ── Status Updates ─────────────────────────────────────────────────────

  /**
   * Transition a task to a new status.
   * Validates the transition is legal.
   */
  updateStatus(taskId, newStatus, by, details = null) {
    const task = this.data.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!VALID_STATUSES.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(`Cannot transition ${taskId} from ${task.status} → ${newStatus}`);
    }

    const now = new Date().toISOString();
    task.status = newStatus;
    task.updatedAt = now;
    task.statusHistory.push({ status: newStatus, at: now, by, details });

    // Archive delivered/cancelled tasks
    if (newStatus === 'delivered' || newStatus === 'cancelled') {
      this._archiveTask(taskId);
    }

    this._save();
    auditLog({ action: 'status', taskId, from: task.statusHistory.slice(-2, -1)[0]?.status, to: newStatus, by });
    return task;
  }

  // ── Plan ────────────────────────────────────────────────────────────────

  /**
   * Set the execution plan for a task (C-level agent's breakdown).
   */
  setPlan(taskId, plan, by) {
    const task = this.data.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.plan = plan;
    task.updatedAt = new Date().toISOString();
    this._save();
    auditLog({ action: 'plan', taskId, by });
    return task;
  }

  // ── Subtasks ───────────────────────────────────────────────────────────

  /**
   * Add a subtask (delegation to a worker agent).
   */
  addSubtask(taskId, opts) {
    const task = this.data.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);

    const subtask = {
      id: `${taskId}-sub-${task.subtasks.length + 1}`,
      assignee: opts.assignee,
      description: opts.description,
      status: 'pending',
      createdAt: new Date().toISOString(),
      completedAt: null,
      output: null,
    };

    task.subtasks.push(subtask);
    if (!task.delegatedTo.includes(opts.assignee)) {
      task.delegatedTo.push(opts.assignee);
    }
    task.updatedAt = new Date().toISOString();
    this._save();
    auditLog({ action: 'subtask_add', taskId, subtaskId: subtask.id, assignee: opts.assignee });
    return subtask;
  }

  /**
   * Update a subtask's status.
   */
  updateSubtask(taskId, subtaskId, status, output = null) {
    const task = this.data.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);

    const sub = task.subtasks.find(s => s.id === subtaskId);
    if (!sub) throw new Error(`Subtask ${subtaskId} not found`);

    sub.status = status;
    sub.output = output || sub.output;
    if (status === 'completed') sub.completedAt = new Date().toISOString();

    task.updatedAt = new Date().toISOString();
    this._save();
    auditLog({ action: 'subtask_update', taskId, subtaskId, status });

    // Auto-transition: all subtasks done → review
    if (task.subtasks.length > 0 && task.subtasks.every(s => s.status === 'completed')) {
      if (task.status === 'in_progress' || task.status === 'delegated') {
        this.updateStatus(taskId, 'review', 'autopilot', 'All subtasks completed');
      }
    }

    return sub;
  }

  // ── Check-Ins ──────────────────────────────────────────────────────────

  /**
   * Record a progress check-in from a worker agent.
   * Written both to the task object and to a JSONL file for the daemon.
   */
  checkIn(taskId, agentId, message, progress = null) {
    const task = this.data.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);

    const entry = {
      at: new Date().toISOString(),
      by: agentId,
      message,
      progress, // 0-100 or null
    };

    task.checkIns.push(entry);
    task.updatedAt = new Date().toISOString();

    // Also write to JSONL file for fast daemon scanning
    const checkinFile = path.join(CHECKINS_DIR, `${taskId}.jsonl`);
    fs.appendFileSync(checkinFile, JSON.stringify(entry) + '\n');

    this._save();
    return entry;
  }

  /**
   * Get the last check-in for a task.
   */
  getLastCheckIn(taskId) {
    const task = this.data.tasks[taskId];
    if (!task || task.checkIns.length === 0) return null;
    return task.checkIns[task.checkIns.length - 1];
  }

  // ── Deliverables ───────────────────────────────────────────────────────

  /**
   * Add a deliverable (URL, file path, screenshot, etc.)
   */
  addDeliverable(taskId, deliverable) {
    const task = this.data.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);

    task.deliverables.push({
      ...deliverable,
      addedAt: new Date().toISOString(),
    });
    task.updatedAt = new Date().toISOString();
    this._save();
    return task;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getTask(taskId) {
    return this.data.tasks[taskId] || null;
  }

  getActiveTasks() {
    return Object.values(this.data.tasks).filter(t =>
      !['delivered', 'cancelled', 'completed'].includes(t.status)
    );
  }

  getTasksByAgent(agentId) {
    return Object.values(this.data.tasks).filter(t =>
      t.assignedTo === agentId || t.delegatedTo.includes(agentId)
    );
  }

  getTasksByStatus(status) {
    return Object.values(this.data.tasks).filter(t => t.status === status);
  }

  /**
   * Get tasks that are overdue on their timeouts.
   * Used by autopilot daemon.
   */
  getOverdueTasks() {
    const now = Date.now();
    const overdue = [];

    for (const task of this.getActiveTasks()) {
      const updated = new Date(task.updatedAt).getTime();
      const created = new Date(task.createdAt).getTime();
      const lastCheckIn = this.getLastCheckIn(task.id);
      const lastCheckInTime = lastCheckIn ? new Date(lastCheckIn.at).getTime() : updated;
      const elapsed = now - updated;
      const sinceCheckIn = now - lastCheckInTime;
      const totalElapsed = now - created;

      const reasons = [];

      if (task.status === 'planning' && elapsed > task.timeouts.planningMaxMs) {
        reasons.push('planning_timeout');
      }
      if (task.status === 'delegated' && elapsed > task.timeouts.delegationMaxMs) {
        reasons.push('delegation_timeout');
      }
      if (task.status === 'in_progress' && sinceCheckIn > task.timeouts.escalateAfterMs) {
        reasons.push('no_checkin');
      }
      if (task.status === 'in_progress' && sinceCheckIn > task.timeouts.alertTimAfterMs) {
        reasons.push('alert_tim');
      }
      if (totalElapsed > task.timeouts.totalMaxMs) {
        reasons.push('total_timeout');
      }
      if (task.deadline && now > new Date(task.deadline).getTime()) {
        reasons.push('past_deadline');
      }

      if (reasons.length > 0) {
        overdue.push({ task, reasons, sinceCheckIn, totalElapsed });
      }
    }

    return overdue;
  }

  // ── Archive ────────────────────────────────────────────────────────────

  _archiveTask(taskId) {
    const task = this.data.tasks[taskId];
    if (!task) return;

    const archivePath = path.join(COMPLETED_DIR, `${taskId}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(task, null, 2));

    // Remove check-in file
    const checkinFile = path.join(CHECKINS_DIR, `${taskId}.jsonl`);
    try { fs.unlinkSync(checkinFile); } catch {}

    // Remove from active registry
    delete this.data.tasks[taskId];
    auditLog({ action: 'archive', taskId });
  }

  // ── Summary ────────────────────────────────────────────────────────────

  /**
   * Get a human-readable summary of all active tasks (for Telegram).
   */
  getSummary() {
    const active = this.getActiveTasks();
    if (active.length === 0) return 'No active tasks.';

    return active.map(t => {
      const age = Math.round((Date.now() - new Date(t.createdAt).getTime()) / 60000);
      const lastCI = this.getLastCheckIn(t.id);
      const ciAge = lastCI
        ? `${Math.round((Date.now() - new Date(lastCI.at).getTime()) / 60000)}min ago`
        : 'none';
      const subDone = t.subtasks.filter(s => s.status === 'completed').length;
      const subTotal = t.subtasks.length;

      return [
        `[${t.status.toUpperCase()}] ${t.title}`,
        `  Assigned: ${t.assignedTo} | Delegated: ${t.delegatedTo.join(', ') || 'none'}`,
        `  Age: ${age}min | Last check-in: ${ciAge}`,
        subTotal > 0 ? `  Subtasks: ${subDone}/${subTotal} done` : null,
      ].filter(Boolean).join('\n');
    }).join('\n\n');
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────────
let _instance = null;
export function getRegistry() {
  if (!_instance) _instance = new TaskRegistry();
  return _instance;
}

export default { TaskRegistry, getRegistry };
