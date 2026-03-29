/**
 * Async File Utilities
 *
 * Drop-in async replacements for common fs sync operations.
 * - Atomic writes (write to temp, rename into place)
 * - Non-blocking reads
 * - Safe mkdir/exists/stat
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ── Async Reads ───────────────────────────────────────────────────────────────

export async function readFile(filePath, encoding = 'utf-8') {
  return fsp.readFile(filePath, encoding);
}

export async function readJSON(filePath) {
  const content = await fsp.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

export async function readFileSafe(filePath, fallback = null) {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

export async function readJSONSafe(filePath, fallback = null) {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

// ── Async Writes ──────────────────────────────────────────────────────────────

/**
 * Atomic write: writes to a temp file then renames into place.
 * Prevents partial reads if another process reads during write.
 */
export async function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmpPath, content);
  await fsp.rename(tmpPath, filePath);
}

export async function writeJSONAtomic(filePath, data) {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

export async function appendFile(filePath, content) {
  return fsp.appendFile(filePath, content);
}

// ── Async Directory Operations ────────────────────────────────────────────────

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function stat(filePath) {
  return fsp.stat(filePath);
}

export async function readdir(dirPath) {
  return fsp.readdir(dirPath);
}

export async function unlink(filePath) {
  return fsp.unlink(filePath);
}

export async function unlinkSafe(filePath) {
  try { await fsp.unlink(filePath); } catch {}
}

export async function rename(oldPath, newPath) {
  return fsp.rename(oldPath, newPath);
}

// ── Config-Specific Operations ────────────────────────────────────────────────

/**
 * Read config with mtime-based caching (async version).
 * Returns cached version if file hasn't changed.
 */
const _configCaches = new Map(); // path → { mtime, data }

export async function readConfigCached(configPath) {
  try {
    const st = await fsp.stat(configPath);
    const cached = _configCaches.get(configPath);
    if (cached && st.mtimeMs === cached.mtime) return cached.data;

    const content = await fsp.readFile(configPath, 'utf-8');
    const data = JSON.parse(content);
    _configCaches.set(configPath, { mtime: st.mtimeMs, data });
    return data;
  } catch (e) {
    const cached = _configCaches.get(configPath);
    if (cached) return cached.data;
    throw e;
  }
}

/**
 * Write config atomically with basic advisory locking.
 * Uses a .lock file to coordinate writers.
 */
export async function writeConfigAtomic(configPath, data) {
  const lockPath = configPath + '.lock';
  const lockContent = `${process.pid}:${Date.now()}`;

  // Simple advisory lock with retry
  for (let i = 0; i < 10; i++) {
    try {
      await fsp.writeFile(lockPath, lockContent, { flag: 'wx' }); // exclusive create
      break;
    } catch (e) {
      if (e.code === 'EEXIST') {
        // Check if lock is stale (older than 10s)
        try {
          const lockStat = await fsp.stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > 10000) {
            await fsp.unlink(lockPath);
            continue;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        continue;
      }
      throw e;
    }
  }

  try {
    await writeJSONAtomic(configPath, data);
    // Invalidate cache
    _configCaches.delete(configPath);
  } finally {
    try { await fsp.unlink(lockPath); } catch {}
  }
}
