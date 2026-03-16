/**
 * Async File Utilities
 * Atomic writes, non-blocking reads, safe mkdir/exists/stat.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export async function readFile(filePath, encoding = 'utf-8') {
  return fsp.readFile(filePath, encoding);
}

export async function readJSON(filePath) {
  const content = await fsp.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

export async function readFileSafe(filePath, fallback = null) {
  try { return await fsp.readFile(filePath, 'utf-8'); } catch { return fallback; }
}

export async function readJSONSafe(filePath, fallback = null) {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch { return fallback; }
}

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

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function exists(filePath) {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

export async function stat(filePath) { return fsp.stat(filePath); }
export async function readdir(dirPath) { return fsp.readdir(dirPath); }
export async function unlink(filePath) { return fsp.unlink(filePath); }
export async function unlinkSafe(filePath) { try { await fsp.unlink(filePath); } catch {} }
export async function rename(oldPath, newPath) { return fsp.rename(oldPath, newPath); }

const _configCaches = new Map();
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

export async function writeConfigAtomic(configPath, data) {
  const lockPath = configPath + '.lock';
  const lockContent = `${process.pid}:${Date.now()}`;
  for (let i = 0; i < 10; i++) {
    try {
      await fsp.writeFile(lockPath, lockContent, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const lockStat = await fsp.stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > 10000) { await fsp.unlink(lockPath); continue; }
        } catch {}
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        continue;
      }
      throw e;
    }
  }
  try {
    await writeJSONAtomic(configPath, data);
    _configCaches.delete(configPath);
  } finally {
    try { await fsp.unlink(lockPath); } catch {}
  }
}
