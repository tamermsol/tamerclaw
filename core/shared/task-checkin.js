/**
 * Task Check-In Helper v1.0 — Lightweight check-in for worker agents
 *
 * Agents call this to report progress on their active task.
 * Writes to the central task registry + local JSONL file.
 *
 * Usage in bot-template.js or agent code:
 *   import { taskCheckIn, getActiveTask, reportBlocker } from './task-checkin.js';
 *   taskCheckIn(agentId, 'Building components, 60% done', 60);
 *   reportBlocker(agentId, 'Cannot access CMS credentials');
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
const AGENTS_DIR = path.join(BASE_DIR, 'agents');

// ── Read registry (lightweight, no class) ────────────────────────────────────

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return { tasks: {} };
  }
}

function writeRegistry(data) {
  data.lastSaved = new Date().toISOString();
  const tmp = REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

// ── Find active task for an agent ────────────────────────────────────────────

/**
 * Find the currently active task for a given agent.
 * Looks for tasks where agent is assignedTo or in delegatedTo, with active status.
 */
export function getActiveTask(agentId) {
  const reg = readRegistry();
  const activeStatuses = ['in_progress', 'delegated', 'planning', 'review'];

  for (const task of Object.values(reg.tasks)) {
    if (!activeStatuses.includes(task.status)) continue;
    if (task.assignedTo === agentId || task.delegatedTo.includes(agentId)) {
      return task;
    }
  }
  return null;
}

/**
 * Find active subtask for a worker agent within a parent task.
 */
export function getActiveSubtask(agentId) {
  const reg = readRegistry();
  for (const task of Object.values(reg.tasks)) {
    if (['delivered', 'cancelled'].includes(task.status)) continue;
    const sub = task.subtasks.find(s =>
      s.assignee === agentId && ['pending', 'in_progress'].includes(s.status)
    );
    if (sub) return { task, subtask: sub };
  }
  return null;
}

// ── Check-In ─────────────────────────────────────────────────────────────────

/**
 * Record a progress check-in.
 * @param {string} agentId - The agent reporting
 * @param {string} message - What the agent is doing
 * @param {number|null} progress - 0-100 percentage or null
 * @returns {boolean} true if check-in was recorded
 */
export function taskCheckIn(agentId, message, progress = null) {
  const task = getActiveTask(agentId);
  if (!task) return false;

  const reg = readRegistry();
  const t = reg.tasks[task.id];
  if (!t) return false;

  const entry = {
    at: new Date().toISOString(),
    by: agentId,
    message,
    progress,
  };

  t.checkIns.push(entry);
  t.updatedAt = new Date().toISOString();
  writeRegistry(reg);

  // Also append to JSONL for fast daemon reads
  if (!fs.existsSync(CHECKINS_DIR)) fs.mkdirSync(CHECKINS_DIR, { recursive: true });
  const checkinFile = path.join(CHECKINS_DIR, `${task.id}.jsonl`);
  fs.appendFileSync(checkinFile, JSON.stringify(entry) + '\n');

  return true;
}

// ── Blocker Report ───────────────────────────────────────────────────────────

/**
 * Report a blocker on the active task. Transitions task to 'blocked' status.
 * @param {string} agentId
 * @param {string} blockerDescription
 */
export function reportBlocker(agentId, blockerDescription) {
  const task = getActiveTask(agentId);
  if (!task) return false;

  const reg = readRegistry();
  const t = reg.tasks[task.id];
  if (!t) return false;

  const now = new Date().toISOString();

  // Add check-in about the blocker
  t.checkIns.push({
    at: now,
    by: agentId,
    message: `BLOCKER: ${blockerDescription}`,
    progress: null,
  });

  // Transition to blocked if currently in_progress
  if (t.status === 'in_progress') {
    t.status = 'blocked';
    t.statusHistory.push({
      status: 'blocked',
      at: now,
      by: agentId,
      details: blockerDescription,
    });
  }

  t.updatedAt = now;
  writeRegistry(reg);

  // Write blocker JSONL
  const checkinFile = path.join(CHECKINS_DIR, `${task.id}.jsonl`);
  fs.appendFileSync(checkinFile, JSON.stringify({
    at: now, by: agentId, message: `BLOCKER: ${blockerDescription}`, progress: null,
  }) + '\n');

  return true;
}

// ── Subtask Completion ───────────────────────────────────────────────────────

/**
 * Mark the agent's active subtask as completed with output.
 */
export function completeSubtask(agentId, output) {
  const match = getActiveSubtask(agentId);
  if (!match) return false;

  const reg = readRegistry();
  const t = reg.tasks[match.task.id];
  if (!t) return false;

  const sub = t.subtasks.find(s => s.id === match.subtask.id);
  if (!sub) return false;

  sub.status = 'completed';
  sub.completedAt = new Date().toISOString();
  sub.output = output;

  t.updatedAt = new Date().toISOString();

  // Auto-transition: all subtasks done → review
  if (t.subtasks.length > 0 && t.subtasks.every(s => s.status === 'completed')) {
    if (['in_progress', 'delegated'].includes(t.status)) {
      t.status = 'review';
      t.statusHistory.push({
        status: 'review',
        at: new Date().toISOString(),
        by: 'autopilot',
        details: 'All subtasks completed — ready for review',
      });
    }
  }

  writeRegistry(reg);
  return true;
}

// ── Context Injection ────────────────────────────────────────────────────────

/**
 * Get a system prompt snippet about the agent's active task.
 * Injected into the agent's system prompt so it's aware of its task context.
 */
export function getTaskContext(agentId) {
  const task = getActiveTask(agentId);
  if (!task) return '';

  const sub = task.subtasks.find(s =>
    s.assignee === agentId && ['pending', 'in_progress'].includes(s.status)
  );

  const lines = [
    '\n## Active Autopilot Task',
    `Task: ${task.title}`,
    `ID: ${task.id}`,
    `Status: ${task.status}`,
    `Expected Output: ${task.expectedOutput}`,
    `Priority: ${task.priority}`,
  ];

  if (sub) {
    lines.push(`\nYour subtask: ${sub.description}`);
    lines.push(`Subtask ID: ${sub.id}`);
  }

  if (task.plan) {
    lines.push(`\nPlan: ${task.plan}`);
  }

  lines.push(
    `\nYou MUST call taskCheckIn every ~5 min of work.`,
    `When done, call completeSubtask with your output.`,
    `If blocked, call reportBlocker immediately.`,
  );

  return lines.join('\n');
}

export default { getActiveTask, getActiveSubtask, taskCheckIn, reportBlocker, completeSubtask, getTaskContext };
