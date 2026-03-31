/**
 * Team Leader Module v1.0 — Leadership capabilities for team leader agents
 *
 * Provides:
 * - /team status — Show all team members' status
 * - /team assign <member> <task> — Delegate a task to a team member
 * - /team meeting <topic> — Start a team meeting with all members
 * - /team review — Get consolidated team progress report
 * - /team members — List team members and their roles
 *
 * Team leaders are regular agents promoted with delegation authority.
 * They can check teammate status, assign tasks, and run team meetings.
 *
 * Usage in bot.js:
 *   import { createTeamCommands } from '../../shared/team-leader.js';
 *   const teamCommands = createTeamCommands(agentId);
 *   // Pass as customCommands to createBot()
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import paths from './paths.js';

const AGENTS_DIR = paths.agents;
const CONFIG_PATH = paths.config;
const MEETINGS_DIR = paths.meetingsRequests;

// ── Config Helpers ──────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * Find the team(s) where the given agent is the leader
 */
export function getLeaderTeams(agentId) {
  const config = loadConfig();
  const teams = config.teams || {};
  return Object.entries(teams)
    .filter(([, team]) => team.leader === agentId)
    .map(([teamId, team]) => ({ teamId, ...team }));
}

/**
 * Find the team a given agent belongs to (as member or leader)
 */
export function getAgentTeam(agentId) {
  const config = loadConfig();
  const teams = config.teams || {};
  for (const [teamId, team] of Object.entries(teams)) {
    if (team.members.includes(agentId)) {
      return { teamId, ...team };
    }
  }
  return null;
}

/**
 * Check if an agent is a team leader
 */
export function isTeamLeader(agentId) {
  return getLeaderTeams(agentId).length > 0;
}

// ── Team Member Status ──────────────────────────────────────────────────────

/**
 * Get a team member's latest status from their health file or memory
 */
function getMemberStatus(memberId) {
  const status = { agent: memberId, online: false, lastActivity: null, currentTask: null };

  // Check health file (standalone agents)
  const healthPaths = [
    path.join(AGENTS_DIR, memberId, 'health.json'),
    path.join(paths.home, memberId, 'health.json'),
  ];

  for (const hp of healthPaths) {
    try {
      const health = JSON.parse(fs.readFileSync(hp, 'utf-8'));
      status.online = true;
      status.lastActivity = health.lastActivity || health.timestamp || health.ts;
      if (health.processing || health.busy) {
        status.currentTask = 'Processing a message';
      }
      break;
    } catch {}
  }

  // Check latest memory for recent work
  const memDir = path.join(AGENTS_DIR, memberId, 'memory');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayMem = path.join(memDir, `${today}.md`);
    if (fs.existsSync(todayMem)) {
      const content = fs.readFileSync(todayMem, 'utf-8');
      // Get last few lines as recent activity summary
      const lines = content.trim().split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        status.lastMemory = lines.slice(-3).join('\n');
      }
    }
  } catch {}

  // Check session files for last message time
  const sessDir = path.join(AGENTS_DIR, memberId, 'sessions');
  try {
    const files = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) {
      status.lastSession = new Date(files[0].mtime).toISOString();
    }
  } catch {}

  return status;
}

// ── Task Delegation ─────────────────────────────────────────────────────────

/**
 * Write a task to a team member's inbox for them to pick up
 */
async function delegateTask(fromAgent, toAgent, task) {
  const taskDir = path.join(AGENTS_DIR, toAgent, 'inbox');
  if (!fs.existsSync(taskDir)) {
    await fsp.mkdir(taskDir, { recursive: true });
  }

  const taskFile = {
    id: `task-${Date.now()}`,
    from: fromAgent,
    to: toAgent,
    task: task,
    priority: 'P1',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const filePath = path.join(taskDir, `${taskFile.id}.json`);
  await fsp.writeFile(filePath, JSON.stringify(taskFile, null, 2));

  // Also write to the team tasks log
  const teamTasksDir = path.join(paths.home, 'teams');
  if (!fs.existsSync(teamTasksDir)) {
    await fsp.mkdir(teamTasksDir, { recursive: true });
  }

  const logPath = path.join(teamTasksDir, 'tasks.jsonl');
  await fsp.appendFile(logPath, JSON.stringify(taskFile) + '\n');

  return taskFile;
}

/**
 * Read pending tasks for a specific agent (from their inbox)
 */
function getPendingTasks(agentId) {
  const taskDir = path.join(AGENTS_DIR, agentId, 'inbox');
  try {
    const files = fs.readdirSync(taskDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf-8'));
      } catch { return null; }
    }).filter(Boolean).filter(t => t.status === 'pending');
  } catch {
    return [];
  }
}

// ── Team Commands ───────────────────────────────────────────────────────────

/**
 * Create /team command handlers for a team leader agent.
 * Returns an object of custom commands to pass to createBot().
 */
export function createTeamCommands(agentId) {
  const teams = getLeaderTeams(agentId);
  if (teams.length === 0) return {};

  const team = teams[0]; // Primary team

  return {
    '/team': async (msg, bot, ctx) => {
      const chatId = ctx.chatId;
      const text = (msg.text || '').replace('/team', '').trim();
      const [subcommand, ...rest] = text.split(/\s+/);
      const arg = rest.join(' ').trim();

      switch (subcommand) {
        case 'status':
          await handleTeamStatus(bot, chatId, team);
          break;

        case 'assign':
          await handleTeamAssign(bot, chatId, agentId, team, arg);
          break;

        case 'meeting':
          await handleTeamMeeting(bot, chatId, agentId, team, arg);
          break;

        case 'review':
          await handleTeamReview(bot, chatId, team);
          break;

        case 'members':
          await handleTeamMembers(bot, chatId, team);
          break;

        case 'tasks':
          await handleTeamTasks(bot, chatId, team);
          break;

        default:
          await bot.sendMessage(chatId, formatTeamHelp(team, agentId));
          break;
      }
    },
  };
}

// ── Command Handlers ────────────────────────────────────────────────────────

async function handleTeamStatus(bot, chatId, team) {
  let msg = `*${team.name} — Team Status*\n\n`;

  for (const memberId of team.members) {
    const status = getMemberStatus(memberId);
    const isLeader = memberId === team.leader;
    const roleTag = isLeader ? ' (Lead)' : '';
    const onlineIcon = status.online ? '🟢' : '⚪';

    msg += `${onlineIcon} *${memberId}*${roleTag}\n`;
    if (status.currentTask) msg += `  Working: ${status.currentTask}\n`;
    if (status.lastSession) {
      const ago = timeSince(new Date(status.lastSession));
      msg += `  Last active: ${ago}\n`;
    }
    if (status.lastMemory) {
      msg += `  Recent: ${status.lastMemory.slice(0, 100)}...\n`;
    }
    msg += '\n';
  }

  // Pending tasks count
  let totalTasks = 0;
  for (const memberId of team.members) {
    totalTasks += getPendingTasks(memberId).length;
  }
  if (totalTasks > 0) {
    msg += `📋 ${totalTasks} pending task(s) across team\n`;
  }

  await sendSafe(bot, chatId, msg);
}

async function handleTeamAssign(bot, chatId, fromAgent, team, arg) {
  if (!arg) {
    await bot.sendMessage(chatId, 'Usage: /team assign <member> <task description>\n\nExample: /team assign smarty implement OTA update screen');
    return;
  }

  const [targetMember, ...taskParts] = arg.split(/\s+/);
  const taskDescription = taskParts.join(' ');

  if (!team.members.includes(targetMember)) {
    await bot.sendMessage(chatId, `${targetMember} is not on your team. Members: ${team.members.join(', ')}`);
    return;
  }

  if (!taskDescription) {
    await bot.sendMessage(chatId, 'Please provide a task description.\n\nExample: /team assign smarty implement OTA update screen');
    return;
  }

  const task = await delegateTask(fromAgent, targetMember, taskDescription);
  await bot.sendMessage(chatId, `✅ Task delegated to *${targetMember}*\n\nTask: ${taskDescription}\nID: ${task.id}\nPriority: ${task.priority}`);
}

async function handleTeamMeeting(bot, chatId, agentId, team, topic) {
  if (!topic) {
    await bot.sendMessage(chatId, 'Usage: /team meeting <topic>\n\nExample: /team meeting review MQTT pairing flow');
    return;
  }

  // Create a meeting request file
  const requestsDir = MEETINGS_DIR;
  if (!fs.existsSync(requestsDir)) {
    await fsp.mkdir(requestsDir, { recursive: true });
  }

  const meetingRequest = {
    id: `team-meeting-${Date.now()}`,
    requested_by: agentId,
    participants: team.members,
    topic: `[${team.name}] ${topic}`,
    priority: 'normal',
    created_at: new Date().toISOString(),
    team: team.teamId,
  };

  const reqPath = path.join(requestsDir, `${meetingRequest.id}.json`);
  await fsp.writeFile(reqPath, JSON.stringify(meetingRequest, null, 2));

  const memberList = team.members.filter(m => m !== agentId).join(', ');
  await bot.sendMessage(chatId, `📅 Team meeting requested\n\nTopic: ${topic}\nParticipants: ${memberList}\nID: ${meetingRequest.id}\n\nUse /meeting start ${team.members.join(' ')} ${topic} to begin`);
}

async function handleTeamReview(bot, chatId, team) {
  let msg = `*${team.name} — Team Review*\n\n`;

  for (const memberId of team.members) {
    const isLeader = memberId === team.leader;
    msg += `*${memberId}*${isLeader ? ' (Lead)' : ''}:\n`;

    // Get today's memory for activity summary
    const today = new Date().toISOString().slice(0, 10);
    const memPath = path.join(AGENTS_DIR, memberId, 'memory', `${today}.md`);
    try {
      const content = fs.readFileSync(memPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        const summary = lines.slice(-5).map(l => `  ${l.trim().slice(0, 120)}`).join('\n');
        msg += `${summary}\n`;
      } else {
        msg += '  No activity logged today\n';
      }
    } catch {
      msg += '  No activity logged today\n';
    }

    // Pending tasks
    const tasks = getPendingTasks(memberId);
    if (tasks.length > 0) {
      msg += `  📋 ${tasks.length} pending task(s)\n`;
    }
    msg += '\n';
  }

  await sendSafe(bot, chatId, msg);
}

async function handleTeamMembers(bot, chatId, team) {
  const config = loadConfig();
  let msg = `*${team.name}*\n${team.description}\n\n`;

  for (const memberId of team.members) {
    const agentConfig = config.agents[memberId];
    const isLeader = memberId === team.leader;
    const roleTag = isLeader ? ' 👑 Team Lead' : '';

    // Get role from IDENTITY frontmatter
    let role = '';
    try {
      const identity = fs.readFileSync(path.join(AGENTS_DIR, memberId, 'IDENTITY.md'), 'utf-8');
      const descMatch = identity.match(/^description:\s*(.+)$/m);
      if (descMatch) role = descMatch[1];
    } catch {}

    const standalone = agentConfig?.standalone ? '(standalone)' : '(relay)';
    msg += `${isLeader ? '👑' : '👤'} *${memberId}*${roleTag}\n`;
    if (role) msg += `  ${role}\n`;
    msg += `  ${standalone}\n\n`;
  }

  await sendSafe(bot, chatId, msg);
}

async function handleTeamTasks(bot, chatId, team) {
  let msg = `*${team.name} — Pending Tasks*\n\n`;
  let totalTasks = 0;

  for (const memberId of team.members) {
    const tasks = getPendingTasks(memberId);
    if (tasks.length > 0) {
      msg += `*${memberId}*:\n`;
      for (const task of tasks) {
        msg += `  - ${task.task.slice(0, 100)}`;
        if (task.from) msg += ` (from: ${task.from})`;
        msg += '\n';
        totalTasks++;
      }
      msg += '\n';
    }
  }

  if (totalTasks === 0) {
    msg += 'No pending tasks across the team.';
  }

  await sendSafe(bot, chatId, msg);
}

// ── System Prompt Injection ─────────────────────────────────────────────────

/**
 * Generate team context to inject into a team leader's system prompt.
 * This gives the leader awareness of their team when processing regular messages.
 */
export function getTeamLeaderPrompt(agentId) {
  const teams = getLeaderTeams(agentId);
  if (teams.length === 0) return '';

  const team = teams[0];
  const otherMembers = team.members.filter(m => m !== agentId);

  let prompt = `\n## Team Leader Role — ${team.name}\n`;
  prompt += `You are the **team leader** of the ${team.name} team.\n`;
  prompt += `Your team members: ${otherMembers.join(', ')}\n\n`;
  prompt += `### Team Leader Responsibilities\n`;
  prompt += `- Coordinate work across your team members\n`;
  prompt += `- Track what each member is working on\n`;
  prompt += `- Delegate tasks when appropriate using /team assign\n`;
  prompt += `- Call team meetings for cross-cutting decisions using /team meeting\n`;
  prompt += `- Report consolidated team status when asked\n`;
  prompt += `- Unblock teammates — if you know the answer to something in their domain, help\n`;
  prompt += `- Quality gate — review team output before shipping\n\n`;

  // Include current tasks info
  let hasTasks = false;
  for (const memberId of otherMembers) {
    const tasks = getPendingTasks(memberId);
    if (tasks.length > 0) {
      if (!hasTasks) {
        prompt += `### Active Team Tasks\n`;
        hasTasks = true;
      }
      for (const task of tasks) {
        prompt += `- ${memberId}: ${task.task.slice(0, 100)} (${task.status})\n`;
      }
    }
  }

  prompt += `\n### /team Commands\n`;
  prompt += `- /team status — Show all team members' current status\n`;
  prompt += `- /team assign <member> <task> — Delegate a task\n`;
  prompt += `- /team meeting <topic> — Start a team meeting\n`;
  prompt += `- /team review — Consolidated progress report\n`;
  prompt += `- /team members — List team and roles\n`;
  prompt += `- /team tasks — View pending tasks\n`;

  return prompt;
}

/**
 * Generate team membership context for non-leader team members.
 * This gives members awareness that they're part of a team.
 */
export function getTeamMemberPrompt(agentId) {
  const team = getAgentTeam(agentId);
  if (!team || team.leader === agentId) return ''; // Leaders get the leader prompt instead

  let prompt = `\n## Team Membership — ${team.name}\n`;
  prompt += `You are a member of the **${team.name}** team.\n`;
  prompt += `Team lead: **${team.leader}**\n`;
  prompt += `Teammates: ${team.members.filter(m => m !== agentId).join(', ')}\n\n`;
  prompt += `### As a Team Member\n`;
  prompt += `- Your team leader (${team.leader}) may assign you tasks — check your inbox at ${paths.agentDir(agentId)}/inbox/\n`;
  prompt += `- Report progress to your leader when completing delegated tasks\n`;
  prompt += `- Collaborate with teammates when work overlaps\n`;
  prompt += `- Escalate blockers to your team leader\n`;

  // Show pending tasks from leader
  const tasks = getPendingTasks(agentId);
  if (tasks.length > 0) {
    prompt += `\n### Your Pending Tasks\n`;
    for (const task of tasks) {
      prompt += `- ${task.task.slice(0, 150)} (from: ${task.from}, priority: ${task.priority})\n`;
    }
  }

  return prompt;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTeamHelp(team, agentId) {
  return `*${team.name} — Team Commands*\n\n` +
    `👑 You lead: ${team.members.filter(m => m !== agentId).join(', ')}\n\n` +
    `Commands:\n` +
    `- /team status — Team status overview\n` +
    `- /team assign <member> <task> — Delegate a task\n` +
    `- /team meeting <topic> — Start team meeting\n` +
    `- /team review — Progress report\n` +
    `- /team members — List team & roles\n` +
    `- /team tasks — View pending tasks`;
}

function timeSince(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function sendSafe(bot, chatId, text) {
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, text);
    }
  } else {
    // Split into chunks
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, MAX_LEN));
      remaining = remaining.slice(MAX_LEN);
    }
    for (const chunk of chunks) {
      try {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(chatId, chunk);
      }
    }
  }
}
