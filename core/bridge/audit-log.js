/**
 * Config Audit Logger
 * Tracks all config changes with SHA256 hashes, matching OpenClaw's config-audit.jsonl.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import paths from '../shared/paths.js';

const LOG_PATH = paths.auditLog;

// Ensure log dir exists (sync at module load is fine — one-time startup)
const logDir = path.dirname(LOG_PATH);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; }
  catch { return 0; }
}

export function auditConfigRead(configPath) {
  const entry = {
    ts: new Date().toISOString(),
    source: 'config-io',
    event: 'config.read',
    configPath,
    pid: process.pid,
    hash: hashFile(configPath),
    bytes: fileSize(configPath),
    result: 'read'
  };
  fsp.appendFile(LOG_PATH, JSON.stringify(entry) + '\n').catch(() => {});
}

export function auditConfigWrite(configPath, previousHash = null) {
  const entry = {
    ts: new Date().toISOString(),
    source: 'config-io',
    event: 'config.write',
    configPath,
    pid: process.pid,
    previousHash,
    nextHash: hashFile(configPath),
    previousBytes: 0,
    nextBytes: fileSize(configPath),
    result: 'write'
  };
  fsp.appendFile(LOG_PATH, JSON.stringify(entry) + '\n').catch(() => {});
}

export function auditEvent(event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    source: 'system',
    event,
    pid: process.pid,
    ...details
  };
  fsp.appendFile(LOG_PATH, JSON.stringify(entry) + '\n').catch(() => {});
}

// Wrap config read/write with auditing (async)
export async function readConfigAudited(configPath) {
  const content = await fsp.readFile(configPath, 'utf-8');
  auditConfigRead(configPath);
  return JSON.parse(content);
}

export async function writeConfigAudited(configPath, data) {
  const { writeConfigAtomic } = await import('../shared/async-fs.js');
  const prevHash = hashFile(configPath);
  await writeConfigAtomic(configPath, data);
  auditConfigWrite(configPath, prevHash);
}
