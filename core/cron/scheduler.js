/**
 * Cron Scheduler
 * Matches OpenClaw's cron system: supports one-time (at) and recurring (cron) jobs.
 * Each job triggers a message to an agent via the bridge's callClaude function.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import paths from '../shared/paths.js';

const JOBS_PATH = paths.cronJobs;
const RUNS_DIR = paths.cronRuns;

// Ensure runs dir exists
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

export function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  } catch {
    return { version: 1, jobs: [] };
  }
}

export function saveJobs(data) {
  // Atomic write: temp file + rename to prevent partial reads
  const tmpPath = JOBS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, JOBS_PATH);
}

export function addJob(job) {
  const data = loadJobs();
  job.id = job.id || crypto.randomUUID();
  job.enabled = job.enabled !== false;
  job.state = { lastRunAtMs: 0, lastRunStatus: null, lastError: null, consecutiveErrors: 0 };
  job.createdAt = new Date().toISOString();
  data.jobs.push(job);
  saveJobs(data);
  return job;
}

export function removeJob(jobId) {
  const data = loadJobs();
  data.jobs = data.jobs.filter(j => j.id !== jobId);
  saveJobs(data);
}

export function updateJob(jobId, updates) {
  const data = loadJobs();
  const job = data.jobs.find(j => j.id === jobId);
  if (job) {
    Object.assign(job, updates);
    saveJobs(data);
  }
  return job;
}

export function listJobs(agentId = null) {
  const data = loadJobs();
  if (agentId) return data.jobs.filter(j => j.agentId === agentId);
  return data.jobs;
}

// Parse cron expression: "min hour dom month dow"
function parseCron(expr) {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return null;
  return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

function cronFieldMatches(field, value) {
  if (field === '*') return true;
  // Handle */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2));
    return value % step === 0;
  }
  // Handle comma-separated values
  const values = field.split(',').map(Number);
  return values.includes(value);
}

function shouldRunCron(cronExpr, now) {
  const cron = parseCron(cronExpr);
  if (!cron) return false;
  return (
    cronFieldMatches(cron.minute, now.getUTCMinutes()) &&
    cronFieldMatches(cron.hour, now.getUTCHours()) &&
    cronFieldMatches(cron.dom, now.getUTCDate()) &&
    cronFieldMatches(cron.month, now.getUTCMonth() + 1) &&
    cronFieldMatches(cron.dow, now.getUTCDay())
  );
}

function shouldRunAt(isoTime, now, lastRunAtMs) {
  const target = new Date(isoTime).getTime();
  return now.getTime() >= target && lastRunAtMs < target;
}

// Get jobs that are due to run
export function getDueJobs() {
  const data = loadJobs();
  const now = new Date();
  const due = [];

  for (const job of data.jobs) {
    if (!job.enabled) continue;

    const schedule = job.schedule;
    if (!schedule) continue;

    if (schedule.kind === 'at') {
      if (shouldRunAt(schedule.at, now, job.state?.lastRunAtMs || 0)) {
        due.push(job);
      }
    } else if (schedule.kind === 'recurring') {
      const lastRun = job.state?.lastRunAtMs || 0;
      // Don't run more than once per minute
      if (now.getTime() - lastRun < 55000) continue;
      if (shouldRunCron(schedule.cron, now)) {
        due.push(job);
      }
    }
  }

  return due;
}

// List system crontab entries as read-only jobs for the dashboard
export function listSystemCronJobs() {
  try {
    const raw = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    return lines.map((line, i) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const cron = parts.slice(0, 5).join(' ');
      const command = parts.slice(5).join(' ');
      // Try to detect agent from command path
      let agentId = 'system';
      if (command.includes('workspace-trading') || command.includes('trading')) agentId = 'trading';
      if (command.includes('heartbeat')) agentId = 'system';
      return {
        id: `sys-cron-${i}`,
        name: inferCronJobName(command),
        agentId,
        enabled: true,
        system: true,
        source: 'system',
        schedule: { kind: 'recurring', cron },
        command: command,
        state: { lastRunAtMs: 0, lastRunStatus: null, lastError: null, consecutiveErrors: 0 },
        createdAt: null,
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function inferCronJobName(command) {
  if (command.includes('heartbeat')) return 'Heartbeat Monitor';
  if (command.includes('log_rotate')) return 'Log Rotation';
  if (command.includes('hourly_snapshot')) return 'Hourly Snapshot & Report';
  if (command.includes('watchdog')) return 'Trading Watchdog';
  if (command.includes('send_snapshot')) return 'Snapshot Report';
  // Extract script name as fallback
  const match = command.match(/(\w+\.(?:py|sh|js))/);
  return match ? match[1] : command.slice(0, 40);
}

// Get all jobs — both managed and system crontab
export function listAllJobs(agentId = null) {
  const managed = listJobs(agentId);
  const system = listSystemCronJobs().filter(j => !agentId || j.agentId === agentId);
  return [...managed, ...system];
}

// Record a job run
export function recordRun(job, status, error = null, response = null) {
  const data = loadJobs();
  const target = data.jobs.find(j => j.id === job.id);
  if (target) {
    target.state = target.state || {};
    target.state.lastRunAtMs = Date.now();
    target.state.lastRunStatus = status;
    target.state.lastError = error;
    if (status === 'error') {
      target.state.consecutiveErrors = (target.state.consecutiveErrors || 0) + 1;
    } else {
      target.state.consecutiveErrors = 0;
    }
    // Delete one-time jobs after successful run
    if (status === 'success' && job.deleteAfterRun) {
      data.jobs = data.jobs.filter(j => j.id !== job.id);
    }
    saveJobs(data);
  }

  // Write run log
  const runLog = {
    jobId: job.id,
    agentId: job.agentId,
    name: job.name,
    ts: new Date().toISOString(),
    status,
    error,
    responseLength: response?.length || 0
  };
  const runFile = path.join(RUNS_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  fsp.appendFile(runFile, JSON.stringify(runLog) + '\n').catch(() => {});
}
