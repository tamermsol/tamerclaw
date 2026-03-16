/**
 * Delivery Queue
 * Async message delivery with retry logic and failed tracking.
 * Uses atomic writes to prevent partial reads.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { writeFileAtomic, readJSONSafe, ensureDir } from '../shared/async-fs.js';
import paths from '../shared/paths.js';

const BASE_DIR = paths.deliveryQueue;
const PENDING_DIR = path.join(BASE_DIR, 'pending');
const FAILED_DIR = path.join(BASE_DIR, 'failed');

// Ensure dirs exist (sync at module load is fine — one-time startup)
[PENDING_DIR, FAILED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

export function enqueue(item) {
  const id = crypto.randomUUID();
  const entry = {
    id,
    ...item,
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxRetries: item.maxRetries || 3,
    lastAttemptAt: null,
    lastError: null
  };
  // Atomic write prevents partial reads by other processes
  const tmpPath = path.join(PENDING_DIR, `.${id}.json.tmp`);
  const finalPath = path.join(PENDING_DIR, `${id}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
  fs.renameSync(tmpPath, finalPath);
  return id;
}

export function getPending() {
  try {
    return fs.readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } catch { return []; }
}

export function getFailed() {
  try {
    return fs.readdirSync(FAILED_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(FAILED_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

export function markAttempt(id, error = null) {
  const filePath = path.join(PENDING_DIR, `${id}.json`);
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
  entry.attempts++;
  entry.lastAttemptAt = new Date().toISOString();
  entry.lastError = error;

  if (error && entry.attempts >= entry.maxRetries) {
    // Move to failed — atomic write then remove
    const tmpPath = path.join(FAILED_DIR, `.${id}.json.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
    fs.renameSync(tmpPath, path.join(FAILED_DIR, `${id}.json`));
    try { fs.unlinkSync(filePath); } catch {}
    return { status: 'failed', entry };
  } else if (!error) {
    // Success — remove from queue
    try { fs.unlinkSync(filePath); } catch {}
    return { status: 'delivered', entry };
  } else {
    // Retry later — atomic update
    const tmpPath = path.join(PENDING_DIR, `.${id}.json.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
    fs.renameSync(tmpPath, filePath);
    return { status: 'retry', entry };
  }
}

export function remove(id) {
  const filePath = path.join(PENDING_DIR, `${id}.json`);
  try { fs.unlinkSync(filePath); } catch {}
}

export function retryFailed(id) {
  const failedPath = path.join(FAILED_DIR, `${id}.json`);
  try {
    const entry = JSON.parse(fs.readFileSync(failedPath, 'utf-8'));
    entry.attempts = 0;
    entry.lastError = null;
    entry.retriedAt = new Date().toISOString();

    const tmpPath = path.join(PENDING_DIR, `.${id}.json.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
    fs.renameSync(tmpPath, path.join(PENDING_DIR, `${id}.json`));
    fs.unlinkSync(failedPath);
    return true;
  } catch {
    return false;
  }
}
