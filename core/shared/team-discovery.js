/**
 * TamerClaw Team Discovery & Health Monitoring v1.0
 *
 * Real-time visibility into the org: which agents are running, healthy,
 * stuck, or idle. Used by C-suite and CEO for operational awareness.
 *
 * Functions:
 *   discoverTeams()                — all teams with members and leaders
 *   getTeamStatus(teamName)        — each member's live status
 *   getAgentHealth(agentName)      — process, heartbeat, activity, memory freshness
 *   getOrgChart()                  — CEO -> C-suite -> teams -> members
 *   findAgent(query)               — search by name, role, capability
 *   getAgentCapabilities(agentName) — parsed from IDENTITY.md
 *   isAgentStuck(agentName, mins)  — detect stuck agents
 *
 * Status levels:
 *   running  — active in last 5 minutes
 *   idle     — active in last hour
 *   stale    — last activity > 1 hour ago
 *   offline  — no running process
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ── Dynamic path resolution ───────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

// ── Constants ───────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const AGENTS_DIR = path.join(BASE_DIR, 'agents');

const STATUS = {
  RUNNING: 'running',   // active in last 5 min
  IDLE: 'idle',         // active in last hour
  STALE: 'stale',       // > 1 hour since activity
  OFFLINE: 'offline',   // no process found
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// ── Config Loader ───────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// ── Process Checks ──────────────────────────────────────────────────────────

/**
 * Check if an agent has a running PM2 process.
 * Returns { running: boolean, status: string, uptime: string|null }
 */
function checkPM2Process(agentName) {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const procs = JSON.parse(raw);
    // Match by name containing the agent name (agents use prefixed names)
    const match = procs.find(p =>
      p.name === agentName ||
      p.name === `${agentName}-agent` ||
      p.name.startsWith(`${agentName}-`)
    );
    if (match) {
      return {
        running: match.pm2_env?.status === 'online',
        status: match.pm2_env?.status || 'unknown',
        uptime: match.pm2_env?.pm_uptime
          ? new Date(match.pm2_env.pm_uptime).toISOString()
          : null,
        restarts: match.pm2_env?.restart_time || 0,
        pid: match.pid || null,
      };
    }
  } catch {
    // PM2 not available or error
  }
  return { running: false, status: 'not_found', uptime: null, restarts: 0, pid: null };
}

/**
 * Check if an agent has a running systemd service.
 * Returns { running: boolean, status: string }
 */
function checkSystemdService(serviceName) {
  if (!serviceName) return { running: false, status: 'no_service' };
  try {
    const result = execSync(`systemctl is-active ${serviceName} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return { running: result === 'active', status: result };
  } catch {
    return { running: false, status: 'inactive' };
  }
}

// ── File-based Health Checks ────────────────────────────────────────────────

/**
 * Get the last modification time of a file (or null if missing).
 */
function fileMtime(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime;
  } catch {
    return null;
  }
}

/**
 * Find the most recent daily memory file for an agent.
 * Daily memory files follow the pattern YYYY-MM-DD.md in the agent's memory dir.
 */
function getLatestDailyMemory(agentName) {
  const memoryDir = path.join(AGENTS_DIR, agentName, 'memory');
  try {
    const files = fs.readdirSync(memoryDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
    if (files.length > 0) {
      const filePath = path.join(memoryDir, files[0]);
      return { file: files[0], path: filePath, mtime: fileMtime(filePath) };
    }
  } catch {
    // No memory directory
  }
  return null;
}

/**
 * Read an agent's health.json if it exists.
 */
function readHealthFile(agentName, config) {
  const agentConf = config.agents?.[agentName];
  const healthPath = agentConf?.healthFile
    || path.join(AGENTS_DIR, agentName, 'health.json');
  try {
    return JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Status Classification ───────────────────────────────────────────────────

/**
 * Determine agent status level from the most recent activity timestamp.
 */
function classifyStatus(lastActivityDate, processRunning) {
  if (!processRunning) return STATUS.OFFLINE;
  if (!lastActivityDate) return STATUS.RUNNING; // process up, no activity data

  const ageMs = Date.now() - lastActivityDate.getTime();
  if (ageMs <= FIVE_MINUTES_MS) return STATUS.RUNNING;
  if (ageMs <= ONE_HOUR_MS) return STATUS.IDLE;
  return STATUS.STALE;
}

/**
 * Gather all activity timestamps for an agent and return the most recent one.
 */
function getLatestActivity(agentName, config) {
  const timestamps = [];

  // Health file heartbeat
  const health = readHealthFile(agentName, config);
  if (health?.lastHeartbeat) timestamps.push(new Date(health.lastHeartbeat));
  if (health?.lastActivity) timestamps.push(new Date(health.lastActivity));

  // Daily memory file modification
  const mem = getLatestDailyMemory(agentName);
  if (mem?.mtime) timestamps.push(mem.mtime);

  // MEMORY.md modification
  const memMd = fileMtime(path.join(AGENTS_DIR, agentName, 'MEMORY.md'));
  if (memMd) timestamps.push(memMd);

  // Session directory — most recent file
  const sessDir = path.join(AGENTS_DIR, agentName, 'sessions');
  try {
    const sessFiles = fs.readdirSync(sessDir).sort().reverse();
    if (sessFiles.length > 0) {
      const mtime = fileMtime(path.join(sessDir, sessFiles[0]));
      if (mtime) timestamps.push(mtime);
    }
  } catch {
    // no sessions dir
  }

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps.map(d => d.getTime())));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Discover all teams with their members and leaders.
 * @returns {Object[]} Array of team objects
 */
export function discoverTeams() {
  const config = loadConfig();
  const teams = config.teams || {};
  return Object.entries(teams).map(([teamId, team]) => ({
    teamId,
    name: team.name,
    description: team.description || '',
    leader: team.leader,
    members: team.members || [],
    memberCount: (team.members || []).length,
  }));
}

/**
 * Get the live status of every member in a team.
 * @param {string} teamName — team ID (e.g. 'tech-team', 'executive')
 * @returns {Object|null} Team info with per-member status, or null if not found
 */
export function getTeamStatus(teamName) {
  const config = loadConfig();
  const team = config.teams?.[teamName];
  if (!team) return null;

  const memberStatuses = (team.members || []).map(memberId => {
    const health = getAgentHealth(memberId);
    return {
      agentId: memberId,
      status: health.status,
      lastActivity: health.lastActivity,
      processRunning: health.processRunning,
      isLeader: memberId === team.leader,
    };
  });

  const summary = {
    running: memberStatuses.filter(m => m.status === STATUS.RUNNING).length,
    idle: memberStatuses.filter(m => m.status === STATUS.IDLE).length,
    stale: memberStatuses.filter(m => m.status === STATUS.STALE).length,
    offline: memberStatuses.filter(m => m.status === STATUS.OFFLINE).length,
  };

  return {
    teamId: teamName,
    name: team.name,
    description: team.description || '',
    leader: team.leader,
    members: memberStatuses,
    summary,
  };
}

/**
 * Full health check for a single agent.
 * @param {string} agentName
 * @returns {Object} Health report
 */
export function getAgentHealth(agentName) {
  const config = loadConfig();
  const agentConf = config.agents?.[agentName];

  if (!agentConf) {
    return {
      agentId: agentName,
      exists: false,
      status: STATUS.OFFLINE,
      processRunning: false,
      error: 'Agent not found in config',
    };
  }

  // Process checks
  const pm2 = checkPM2Process(agentName);
  const systemd = checkSystemdService(agentConf.service);
  const processRunning = pm2.running || systemd.running;

  // Health file
  const healthData = readHealthFile(agentName, config);

  // Activity / memory freshness
  const latestActivity = getLatestActivity(agentName, config);
  const dailyMemory = getLatestDailyMemory(agentName);

  // Classify
  const status = classifyStatus(latestActivity, processRunning);

  return {
    agentId: agentName,
    exists: true,
    status,
    processRunning,
    process: {
      pm2: pm2,
      systemd: systemd,
    },
    lastActivity: latestActivity ? latestActivity.toISOString() : null,
    lastActivityAgo: latestActivity
      ? humanDuration(Date.now() - latestActivity.getTime())
      : null,
    memory: dailyMemory
      ? { file: dailyMemory.file, lastModified: dailyMemory.mtime?.toISOString() }
      : null,
    health: healthData,
    standalone: agentConf.standalone || false,
    model: agentConf.model || config.defaults?.model || 'unknown',
    team: agentConf.team || null,
  };
}

/**
 * Return the full org chart: CEO -> C-suite -> teams -> members.
 * @returns {Object} Hierarchical org structure
 */
export function getOrgChart() {
  const config = loadConfig();
  const teams = config.teams || {};
  const agents = config.agents || {};

  // Find CEO (supreme)
  const ceoEntry = Object.entries(agents).find(([, a]) => a.team?.role === 'ceo');
  const ceoId = ceoEntry ? ceoEntry[0] : 'supreme';

  // Find C-suite (direct reports of CEO)
  const cSuite = Object.entries(agents)
    .filter(([, a]) => a.team?.role === 'leader')
    .map(([id, a]) => ({
      agentId: id,
      role: 'leader',
      teamId: a.team.teamId,
      teamName: teams[a.team.teamId]?.name || a.team.teamId,
      members: (a.team.members || []).map(memberId => ({
        agentId: memberId,
        role: agents[memberId]?.team?.role || 'member',
      })),
    }));

  // Executive team
  const executive = teams.executive || null;

  return {
    ceo: {
      agentId: ceoId,
      role: 'ceo',
      directReports: agents[ceoId]?.team?.directReports || [],
    },
    cSuite,
    teams: Object.entries(teams).map(([teamId, team]) => ({
      teamId,
      name: team.name,
      leader: team.leader,
      members: team.members || [],
      description: team.description || '',
    })),
    executive: executive
      ? { leader: executive.leader, members: executive.members }
      : null,
    totalAgents: Object.keys(agents).length,
    totalTeams: Object.keys(teams).length,
  };
}

/**
 * Search agents by name, role, or capability keyword.
 * @param {string} query — search string (case-insensitive)
 * @returns {Object[]} Matching agents
 */
export function findAgent(query) {
  const config = loadConfig();
  const agents = config.agents || {};
  const teams = config.teams || {};
  const q = query.toLowerCase();

  const results = [];

  for (const [agentId, agentConf] of Object.entries(agents)) {
    let score = 0;
    const reasons = [];

    // Name match
    if (agentId.toLowerCase().includes(q)) {
      score += 10;
      reasons.push('name');
    }

    // Telegram account match
    if (agentConf.telegramAccount?.toLowerCase().includes(q)) {
      score += 5;
      reasons.push('telegram');
    }

    // Role match
    const role = agentConf.team?.role || '';
    if (role.toLowerCase().includes(q)) {
      score += 8;
      reasons.push('role');
    }

    // Team match
    const teamId = agentConf.team?.teamId || '';
    const teamName = teams[teamId]?.name || '';
    if (teamId.toLowerCase().includes(q) || teamName.toLowerCase().includes(q)) {
      score += 4;
      reasons.push('team');
    }

    // Capability match (quick IDENTITY.md scan)
    if (score === 0) {
      const identityPath = agentConf.identity
        || path.join(AGENTS_DIR, agentId, 'IDENTITY.md');
      try {
        const identity = fs.readFileSync(identityPath, 'utf-8').toLowerCase();
        if (identity.includes(q)) {
          score += 3;
          reasons.push('capability');
        }
      } catch {
        // No identity file
      }
    }

    if (score > 0) {
      results.push({
        agentId,
        score,
        matchedOn: reasons,
        team: teamId || null,
        role: role || 'member',
        standalone: agentConf.standalone || false,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Read an agent's IDENTITY.md and extract capabilities.
 * @param {string} agentName
 * @returns {Object} { name, role, capabilities[], rawIdentity }
 */
export async function getAgentCapabilities(agentName) {
  const config = loadConfig();
  const agentConf = config.agents?.[agentName];

  if (!agentConf) {
    return { agentId: agentName, name: agentName, error: 'Agent not found in config', capabilities: [] };
  }

  const identityPath = agentConf.identity
    || path.join(AGENTS_DIR, agentName, 'IDENTITY.md');

  let raw;
  try {
    raw = await fsp.readFile(identityPath, 'utf-8');
  } catch {
    return {
      agentId: agentName,
      name: agentName,
      identityPath,
      error: 'IDENTITY.md not found',
      capabilities: [],
    };
  }

  // Extract name from first heading
  const nameMatch = raw.match(/^#\s+(.+)/m);
  const name = nameMatch ? nameMatch[1].trim() : agentName;

  // Extract capabilities: look for bullet points under capability-related headings
  const capabilities = [];
  const capSection = raw.match(/(?:capabilities|skills|responsibilities|can do|powers)[:\s]*\n((?:\s*[-*].+\n?)+)/im);
  if (capSection) {
    const bullets = capSection[1].match(/[-*]\s+(.+)/g) || [];
    for (const b of bullets) {
      capabilities.push(b.replace(/^[-*]\s+/, '').trim());
    }
  }

  // Also grab any bullet lists as general capabilities if none found yet
  if (capabilities.length === 0) {
    const allBullets = raw.match(/^[-*]\s+(.+)/gm) || [];
    for (const b of allBullets.slice(0, 20)) {
      capabilities.push(b.replace(/^[-*]\s+/, '').trim());
    }
  }

  // Extract role from team config
  const role = agentConf.team?.role || 'member';

  return {
    agentId: agentName,
    name,
    role,
    team: agentConf.team?.teamId || null,
    capabilities,
    identityPath,
    standalone: agentConf.standalone || false,
    model: agentConf.model || 'default',
  };
}

/**
 * Detect if an agent appears stuck.
 * An agent is stuck if its process is running but has no activity
 * within the given threshold.
 *
 * @param {string} agentName
 * @param {number} [thresholdMinutes=30] — minutes of inactivity to consider stuck
 * @returns {Object} { stuck: boolean, reason, lastActivity, ageMinutes }
 */
export function isAgentStuck(agentName, thresholdMinutes = 30) {
  const config = loadConfig();
  const agentConf = config.agents?.[agentName];

  if (!agentConf) {
    return { agentId: agentName, stuck: false, reason: 'Agent not found' };
  }

  const pm2 = checkPM2Process(agentName);
  const systemd = checkSystemdService(agentConf.service);
  const processRunning = pm2.running || systemd.running;

  if (!processRunning) {
    return {
      agentId: agentName,
      stuck: false,
      reason: 'Process not running (offline, not stuck)',
      processRunning: false,
    };
  }

  const latestActivity = getLatestActivity(agentName, config);
  if (!latestActivity) {
    return {
      agentId: agentName,
      stuck: true,
      reason: 'Process running but no activity data found',
      processRunning: true,
      lastActivity: null,
      ageMinutes: null,
    };
  }

  const ageMs = Date.now() - latestActivity.getTime();
  const ageMinutes = Math.round(ageMs / 60000);
  const stuck = ageMinutes >= thresholdMinutes;

  return {
    agentId: agentName,
    stuck,
    reason: stuck
      ? `No activity for ${ageMinutes} minutes (threshold: ${thresholdMinutes})`
      : `Active ${ageMinutes} minutes ago (within threshold)`,
    processRunning: true,
    lastActivity: latestActivity.toISOString(),
    ageMinutes,
    thresholdMinutes,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert milliseconds to a human-readable duration string.
 */
function humanDuration(ms) {
  if (ms < 1000) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export default {
  discoverTeams,
  getTeamStatus,
  getAgentHealth,
  getOrgChart,
  findAgent,
  getAgentCapabilities,
  isAgentStuck,
  STATUS,
};
