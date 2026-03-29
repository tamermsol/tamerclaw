/**
 * Session History — Archive & Resume Past Sessions
 *
 * Stores completed sessions per agent with summaries extracted from daily memory.
 * Enables users to browse past sessions and resume specific ones.
 *
 * Storage: {agentDir}/session-history.json
 * Format: Array of { sessionId, startedAt, endedAt, messageCount, summary, topics }
 *
 * Max 30 sessions retained per agent (oldest pruned automatically).
 */

import fs from 'fs';
import path from 'path';
import paths from './paths.js';

const MAX_SESSIONS = 30;

// ── File Paths ───────────────────────────────────────────────────────────────

function getHistoryPath(agentId) {
  // Check standalone agent dirs first
  const standaloneDirs = [
    path.join(paths.home, agentId),
    path.join(paths.agents, agentId)
  ];
  for (const dir of standaloneDirs) {
    if (fs.existsSync(dir)) return path.join(dir, 'session-history.json');
  }
  return path.join(paths.agents, agentId, 'session-history.json');
}

function getMemoryDir(agentId) {
  const dirs = [
    path.join(paths.agents, agentId, 'memory'),
    path.join(paths.home, agentId, 'memory')
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) return d;
  }
  return path.join(paths.agents, agentId, 'memory');
}

// ── Load / Save ──────────────────────────────────────────────────────────────

function loadHistory(agentId) {
  try {
    const filePath = getHistoryPath(agentId);
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`[session-history] Failed to load for ${agentId}:`, e.message);
    return [];
  }
}

function saveHistory(agentId, history) {
  try {
    const filePath = getHistoryPath(agentId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error(`[session-history] Failed to save for ${agentId}:`, e.message);
  }
}

// ── Summary Extraction ───────────────────────────────────────────────────────

/**
 * Extract a session summary from daily memory files.
 * Looks at memory entries between startedAt and endedAt timestamps.
 * Returns { summary: string, topics: string[] }
 */
function extractSessionSummary(agentId, startedAt, endedAt) {
  const memDir = getMemoryDir(agentId);
  const startDate = startedAt.slice(0, 10);
  const endDate = (endedAt || new Date().toISOString()).slice(0, 10);

  const entries = [];

  try {
    const memFiles = fs.readdirSync(memDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .filter(f => {
        const date = f.replace('.md', '');
        return date >= startDate && date <= endDate;
      })
      .sort();

    for (const file of memFiles) {
      const content = fs.readFileSync(path.join(memDir, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.startsWith('['));

      for (const line of lines) {
        // Parse: [HH:MM:SS] User: message... -> responded (N chars)
        const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\] User: (.+?)(?:\.\.\.)? (?:->|→) responded/);
        if (match) {
          const [, time, msg] = match;
          const date = file.replace('.md', '');
          const entryTime = new Date(`${date}T${time}Z`);
          const start = new Date(startedAt);
          const end = endedAt ? new Date(endedAt) : new Date();

          // Include entries within session timeframe (with 1min buffer)
          if (entryTime >= new Date(start.getTime() - 60000) && entryTime <= new Date(end.getTime() + 60000)) {
            entries.push(msg.trim());
          }
        }
      }
    }
  } catch (e) {
    console.error(`[session-history] Memory scan failed for ${agentId}:`, e.message);
  }

  if (entries.length === 0) {
    return { summary: 'No conversation details captured', topics: [] };
  }

  // Build summary from first few + last few entries
  const topics = extractTopics(entries);
  const summary = buildSummary(entries);

  return { summary, topics };
}

/**
 * Extract key topics from conversation entries.
 * Simple keyword extraction — no LLM needed.
 */
function extractTopics(entries) {
  const text = entries.join(' ').toLowerCase();
  const topicPatterns = [
    { pattern: /\b(apk|flutter|mobile app|android|ios)\b/i, topic: 'Mobile App' },
    { pattern: /\b(ui|ux|design|layout|screen|widget)\b/i, topic: 'UI/UX' },
    { pattern: /\b(bug|fix|error|crash|broken|issue)\b/i, topic: 'Bug Fix' },
    { pattern: /\b(deploy|release|push|publish|build)\b/i, topic: 'Deployment' },
    { pattern: /\b(trade|trading|position|crypto|btc|eth)\b/i, topic: 'Trading' },
    { pattern: /\b(voice|tts|audio|speech|whisper)\b/i, topic: 'Voice' },
    { pattern: /\b(api|endpoint|server|backend|gateway)\b/i, topic: 'API/Backend' },
    { pattern: /\b(login|auth|password|token|credential)\b/i, topic: 'Authentication' },
    { pattern: /\b(cron|schedule|job|recurring)\b/i, topic: 'Scheduling' },
    { pattern: /\b(website|page|cms|seo|framer)\b/i, topic: 'Website' },
    { pattern: /\b(agent|bot|telegram)\b/i, topic: 'Agent/Bot' },
    { pattern: /\b(test|testing|qa|verify)\b/i, topic: 'Testing' },
    { pattern: /\b(config|setup|install|init)\b/i, topic: 'Configuration' },
    { pattern: /\b(database|db|sql|mongo|payload)\b/i, topic: 'Database' },
    { pattern: /\b(image|photo|screenshot|media)\b/i, topic: 'Media' },
    { pattern: /\b(session|memory|context|resume)\b/i, topic: 'Session Mgmt' },
    { pattern: /\b(plan|strategy|roadmap|feature)\b/i, topic: 'Planning' },
    { pattern: /\b(refactor|clean|optimize|performance)\b/i, topic: 'Optimization' },
  ];

  const found = [];
  for (const { pattern, topic } of topicPatterns) {
    if (pattern.test(text) && !found.includes(topic)) {
      found.push(topic);
    }
  }

  return found.slice(0, 5); // Max 5 topics
}

/**
 * Build a concise summary from conversation entries.
 */
function buildSummary(entries) {
  if (entries.length <= 3) {
    return entries.join(' | ');
  }

  // Show first 2 and last entry for context
  const first = entries.slice(0, 2).map(e => e.slice(0, 80)).join('; ');
  const last = entries[entries.length - 1].slice(0, 80);
  return `${first} ... ${last} (${entries.length} messages)`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Archive a session before it's cleared.
 * Call this BEFORE deleting from active sessions.
 *
 * @param {string} agentId
 * @param {object} sessionData - { sessionId, startedAt, messageCount, lastMessageAt? }
 * @param {string} [reason] - Why session ended: 'reset', 'expired', 'error', 'new_session'
 */
export function archiveSession(agentId, sessionData, reason = 'reset') {
  if (!sessionData?.sessionId) return;

  // Don't archive empty sessions (0 messages, never used)
  if (!sessionData.messageCount || sessionData.messageCount === 0) {
    console.log(`[session-history] Skipping empty session for ${agentId}`);
    return;
  }

  const endedAt = new Date().toISOString();
  const { summary, topics } = extractSessionSummary(agentId, sessionData.startedAt, endedAt);

  const history = loadHistory(agentId);

  // Deduplicate — don't archive same sessionId twice
  if (history.some(h => h.sessionId === sessionData.sessionId)) {
    console.log(`[session-history] Session ${sessionData.sessionId.slice(0, 8)} already archived for ${agentId}`);
    return;
  }

  const entry = {
    sessionId: sessionData.sessionId,
    startedAt: sessionData.startedAt,
    endedAt,
    messageCount: sessionData.messageCount || 0,
    reason,
    summary,
    topics
  };

  history.push(entry);

  // Prune to MAX_SESSIONS
  while (history.length > MAX_SESSIONS) {
    history.shift();
  }

  saveHistory(agentId, history);
  console.log(`[session-history] Archived session ${entry.sessionId.slice(0, 8)} for ${agentId} (${entry.messageCount} msgs, ${topics.join(', ') || 'no topics'})`);
}

/**
 * List past sessions for an agent.
 * Returns array of { index, sessionId, startedAt, endedAt, messageCount, summary, topics }
 * Most recent first.
 */
export function listSessions(agentId) {
  const history = loadHistory(agentId);
  return history
    .map((h, i) => ({ index: i + 1, ...h }))
    .reverse(); // Most recent first
}

/**
 * Get a specific session by its 1-based index (as shown in /sessions).
 * Index 1 = most recent, 2 = second most recent, etc.
 */
export function getSessionByIndex(agentId, index) {
  const history = loadHistory(agentId);
  if (index < 1 || index > history.length) return null;
  // Index 1 = most recent = last in array
  return history[history.length - index];
}

/**
 * Get a session by its UUID (or UUID prefix).
 */
export function getSessionById(agentId, idOrPrefix) {
  const history = loadHistory(agentId);
  return history.find(h =>
    h.sessionId === idOrPrefix || h.sessionId.startsWith(idOrPrefix)
  );
}

/**
 * Format sessions list for Telegram display.
 * @param {string} agentId
 * @param {number} [limit=10] - How many to show
 * @returns {string} Formatted message for Telegram
 */
export function formatSessionsList(agentId, limit = 10) {
  const sessions = listSessions(agentId);

  if (sessions.length === 0) {
    return `No session history for *${agentId}* yet.`;
  }

  const lines = [`*${agentId}* — Past Sessions:\n`];

  for (const s of sessions.slice(0, limit)) {
    const date = formatDate(s.startedAt);
    const duration = formatDuration(s.startedAt, s.endedAt);
    const topicsStr = s.topics?.length ? ` [${s.topics.join(', ')}]` : '';

    lines.push(
      `*${s.index}.* ${date} (${s.messageCount} msgs, ${duration})${topicsStr}`
    );

    if (s.summary && s.summary !== 'No conversation details captured') {
      lines.push(`   ${truncate(s.summary, 120)}`);
    }
    lines.push('');
  }

  if (sessions.length > limit) {
    lines.push(`_...and ${sessions.length - limit} older sessions_`);
  }

  lines.push(`\nUse /resume <number> to continue a session.`);

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(isoStr) {
  try {
    const d = new Date(isoStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return isoStr?.slice(0, 16) || 'unknown';
  }
}

function formatDuration(startIso, endIso) {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
  } catch {
    return '?';
  }
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

export default {
  archiveSession,
  listSessions,
  getSessionByIndex,
  getSessionById,
  formatSessionsList
};
