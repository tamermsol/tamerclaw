/**
 * Teammate Mailbox v1.0 — Async file-based agent-to-agent messaging
 *
 * Each agent has an inbox at <TAMERCLAW_HOME>/user/agents/{agentName}/inbox.json
 * Messages are JSON objects with sender, text, timestamps, read tracking,
 * and priority levels. File locking prevents corruption from concurrent writes.
 *
 * Supports:
 * - Direct agent-to-agent messages with priority
 * - Read tracking (mark as read, unread counts)
 * - Team broadcast (send to all members of a team)
 * - Auto-expiry (messages older than 7 days are cleaned up)
 * - FIFO eviction (max 100 messages per inbox)
 *
 * Usage:
 *   import { sendMessage, readInbox, getUnreadCount } from '../../shared/teammate-mailbox.js';
 *   await sendMessage('cto', 'flutter', 'Deploy the new build', { priority: 'urgent' });
 *   const msgs = await readInbox('flutter', { unreadOnly: true });
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import paths from './paths.js';

const AGENTS_DIR = paths.agents;
const CONFIG_PATH = paths.config;

const MAX_MESSAGES = 100;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOCK_TIMEOUT = 5000; // 5s max wait for lock
const LOCK_STALE = 10000; // 10s stale lock threshold
const SUMMARY_LENGTH = 80;

// -- Helpers -------------------------------------------------------------------

function inboxPath(agentName) {
  return path.join(AGENTS_DIR, agentName, 'inbox.json');
}

function lockPath(agentName) {
  return inboxPath(agentName) + '.lock';
}

function makeSummary(text) {
  if (!text) return '';
  const oneLine = text.replace(/\n/g, ' ').trim();
  return oneLine.length <= SUMMARY_LENGTH
    ? oneLine
    : oneLine.slice(0, SUMMARY_LENGTH - 1) + '\u2026';
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function getTeamMembers(teamName) {
  const config = loadConfig();
  const team = (config.teams || {})[teamName];
  if (!team) return null;
  return team.members || [];
}

// -- File Locking (rename-based atomic lock) -----------------------------------

async function acquireLock(agentName) {
  const lp = lockPath(agentName);
  const start = Date.now();

  while (Date.now() - start < LOCK_TIMEOUT) {
    try {
      // O_EXCL — fails if file exists
      const fd = await fsp.open(lp, 'wx');
      await fd.write(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await fd.close();
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale
        try {
          const stat = await fsp.stat(lp);
          if (Date.now() - stat.mtimeMs > LOCK_STALE) {
            await fsp.unlink(lp).catch(() => {});
            continue;
          }
        } catch {
          // Lock file vanished — retry
          continue;
        }
        // Wait and retry
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`[teammate-mailbox] Lock timeout for ${agentName} inbox`);
}

async function releaseLock(agentName) {
  await fsp.unlink(lockPath(agentName)).catch(() => {});
}

// -- Inbox I/O -----------------------------------------------------------------

async function readInboxFile(agentName) {
  const fp = inboxPath(agentName);
  try {
    const raw = await fsp.readFile(fp, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // Corrupt file — back up and return empty
    console.error(`[teammate-mailbox] Corrupt inbox for ${agentName}, resetting:`, err.message);
    return [];
  }
}

async function writeInboxFile(agentName, messages) {
  const fp = inboxPath(agentName);
  const dir = path.dirname(fp);
  await fsp.mkdir(dir, { recursive: true });

  // Atomic write via temp file + rename
  const tmp = fp + '.tmp.' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(messages, null, 2));
  await fsp.rename(tmp, fp);
}

// -- Cleanup: expiry + FIFO eviction -------------------------------------------

function cleanup(messages) {
  const now = Date.now();
  // Remove expired
  let cleaned = messages.filter(m => {
    const age = now - new Date(m.timestamp).getTime();
    return age < EXPIRY_MS;
  });
  // FIFO eviction — keep newest MAX_MESSAGES
  if (cleaned.length > MAX_MESSAGES) {
    cleaned = cleaned.slice(cleaned.length - MAX_MESSAGES);
  }
  return cleaned;
}

// -- withLock helper -----------------------------------------------------------

async function withLock(agentName, fn) {
  await acquireLock(agentName);
  try {
    return await fn();
  } finally {
    await releaseLock(agentName);
  }
}

// -- Public API ----------------------------------------------------------------

/**
 * Send a message to another agent's inbox.
 *
 * @param {string} from    - Sender agent ID
 * @param {string} to      - Recipient agent ID
 * @param {string} text    - Message body
 * @param {Object} [opts]
 * @param {string} [opts.priority='normal'] - 'normal' | 'urgent' | 'critical'
 * @param {Object} [opts.metadata]          - Arbitrary metadata to attach
 * @returns {Promise<Object>} The created message object
 */
export async function sendMessage(from, to, text, opts = {}) {
  const { priority = 'normal', metadata } = opts;

  const message = {
    id: randomUUID(),
    from,
    to,
    text,
    summary: makeSummary(text),
    priority,
    timestamp: new Date().toISOString(),
    read: false,
    ...(metadata ? { metadata } : {}),
  };

  await withLock(to, async () => {
    let messages = await readInboxFile(to);
    messages.push(message);
    messages = cleanup(messages);
    await writeInboxFile(to, messages);
  });

  return message;
}

/**
 * Read messages from an agent's inbox.
 *
 * @param {string} agentName - Agent whose inbox to read
 * @param {Object} [opts]
 * @param {boolean} [opts.unreadOnly=false] - Only return unread messages
 * @param {string}  [opts.from]             - Filter by sender agent ID
 * @param {string}  [opts.priority]         - Filter by priority level
 * @param {number}  [opts.limit]            - Max messages to return (newest first)
 * @returns {Promise<Object[]>} Array of message objects (newest last)
 */
export async function readInbox(agentName, opts = {}) {
  const { unreadOnly = false, from, priority, limit } = opts;

  let messages = await readInboxFile(agentName);

  if (unreadOnly) messages = messages.filter(m => !m.read);
  if (from) messages = messages.filter(m => m.from === from);
  if (priority) messages = messages.filter(m => m.priority === priority);
  if (limit) messages = messages.slice(-limit);

  return messages;
}

/**
 * Mark specific messages as read.
 *
 * @param {string}   agentName  - Agent whose inbox to update
 * @param {string[]} messageIds - Array of message IDs to mark read
 * @returns {Promise<number>} Number of messages marked read
 */
export async function markRead(agentName, messageIds) {
  const idSet = new Set(messageIds);
  let marked = 0;

  await withLock(agentName, async () => {
    const messages = await readInboxFile(agentName);
    for (const m of messages) {
      if (idSet.has(m.id) && !m.read) {
        m.read = true;
        marked++;
      }
    }
    await writeInboxFile(agentName, messages);
  });

  return marked;
}

/**
 * Get count of unread messages in an agent's inbox.
 *
 * @param {string} agentName
 * @returns {Promise<number>}
 */
export async function getUnreadCount(agentName) {
  const messages = await readInboxFile(agentName);
  return messages.filter(m => !m.read).length;
}

/**
 * Broadcast a message to all members of a team.
 *
 * @param {string} from     - Sender agent ID
 * @param {string} teamName - Team ID from config.json (e.g. 'tech-team')
 * @param {string} text     - Message body
 * @param {Object} [opts]
 * @param {string} [opts.priority='normal']    - Priority level
 * @param {boolean} [opts.excludeSelf=true]    - Skip sending to self
 * @param {Object} [opts.metadata]             - Arbitrary metadata
 * @returns {Promise<Object[]>} Array of sent message objects
 */
export async function broadcastToTeam(from, teamName, text, opts = {}) {
  const { excludeSelf = true, ...msgOpts } = opts;
  const members = getTeamMembers(teamName);
  if (!members) {
    throw new Error(`[teammate-mailbox] Unknown team: ${teamName}`);
  }

  const recipients = excludeSelf
    ? members.filter(m => m !== from)
    : members;

  const results = await Promise.allSettled(
    recipients.map(to => sendMessage(from, to, text, msgOpts))
  );

  const sent = [];
  for (const r of results) {
    if (r.status === 'fulfilled') sent.push(r.value);
    else console.error(`[teammate-mailbox] Broadcast delivery failed:`, r.reason?.message);
  }

  return sent;
}

/**
 * Get unread message counts for all members of a team.
 *
 * @param {string} teamName - Team ID from config.json
 * @returns {Promise<Object>} Map of { agentName: unreadCount }
 */
export async function getTeamInboxSummary(teamName) {
  const members = getTeamMembers(teamName);
  if (!members) {
    throw new Error(`[teammate-mailbox] Unknown team: ${teamName}`);
  }

  const results = await Promise.allSettled(
    members.map(async m => ({ agent: m, unread: await getUnreadCount(m) }))
  );

  const summary = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      summary[r.value.agent] = r.value.unread;
    }
  }

  return summary;
}

/**
 * Purge expired messages from an agent's inbox.
 * Called automatically during sendMessage, but can be invoked manually.
 *
 * @param {string} agentName
 * @returns {Promise<number>} Number of messages removed
 */
export async function purgeExpired(agentName) {
  let removed = 0;

  await withLock(agentName, async () => {
    const messages = await readInboxFile(agentName);
    const cleaned = cleanup(messages);
    removed = messages.length - cleaned.length;
    if (removed > 0) {
      await writeInboxFile(agentName, cleaned);
    }
  });

  return removed;
}

/**
 * Delete specific messages from an agent's inbox.
 *
 * @param {string}   agentName  - Agent whose inbox to update
 * @param {string[]} messageIds - Array of message IDs to delete
 * @returns {Promise<number>} Number of messages deleted
 */
export async function deleteMessages(agentName, messageIds) {
  const idSet = new Set(messageIds);
  let deleted = 0;

  await withLock(agentName, async () => {
    const messages = await readInboxFile(agentName);
    const filtered = messages.filter(m => {
      if (idSet.has(m.id)) { deleted++; return false; }
      return true;
    });
    if (deleted > 0) {
      await writeInboxFile(agentName, filtered);
    }
  });

  return deleted;
}

export default {
  sendMessage,
  readInbox,
  markRead,
  getUnreadCount,
  broadcastToTeam,
  getTeamInboxSummary,
  purgeExpired,
  deleteMessages,
};
