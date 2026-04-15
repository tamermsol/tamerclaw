/**
 * mini-meeting.js — Lightweight CTO <-> Agent task alignment meeting
 *
 * Spawns a forked agent instance to have a structured 3-turn meeting:
 *   1. CTO briefs the agent on the task + current state
 *   2. Agent reviews, flags blockers, proposes a plan
 *   3. CTO confirms or adjusts — final task JSON is written to agent's inbox
 *
 * Usage:
 *   node mini-meeting.js --from cto --to hbot --topic "App Store Screenshots"
 *
 * Or as a module:
 *   import { runMiniMeeting } from './mini-meeting.js';
 */

import { runForkedAgent } from './forked-agent.js';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import paths from './paths.js';

const AGENTS_DIR = paths.agents;
const MEETINGS_DIR = path.join(paths.home, 'user', 'meetings');

/**
 * Run a mini meeting between team leader and one agent.
 *
 * @param {Object} opts
 * @param {string} opts.from        - Leader agent ID (e.g. 'cto')
 * @param {string} opts.to          - Target agent ID (e.g. 'hbot')
 * @param {string} opts.topic       - Short topic name
 * @param {string} opts.brief       - Full task brief from the leader
 * @param {string} [opts.context]   - Additional context (files, current state, etc.)
 * @param {string} [opts.model]     - Model to use for agent (default: sonnet)
 * @param {number} [opts.timeout]   - Timeout ms (default: 120000)
 * @returns {Promise<MeetingResult>}
 */
export async function runMiniMeeting(opts) {
  const {
    from,
    to,
    topic,
    brief,
    context = '',
    model = 'sonnet',
    timeout = 120_000,
  } = opts;

  const meetingId = `meeting-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = new Date().toISOString();

  await fsp.mkdir(MEETINGS_DIR, { recursive: true });
  await fsp.mkdir(path.join(paths.agentDir(to), 'meetings'), { recursive: true });

  // -- Build the meeting prompt ------------------------------------------------
  const meetingPrompt = `
You are ${to} — a member of the TamerClaw engineering team.
Your team leader (${from}) has called a quick sync meeting to align on a task before you start work.

## Meeting Topic
${topic}

## Task Brief from ${from}
${brief}

${context ? `## Current Context / State\n${context}` : ''}

---

## Your Job in This Meeting

1. **Acknowledge** what you understand from the brief
2. **Review** any relevant files or state you need to check before confirming (you have tool access — use Read, Bash, Glob as needed)
3. **Flag** any blockers, ambiguities, or things that need clarification
4. **Propose** a concrete step-by-step execution plan (numbered list, specific commands/files)
5. **Confirm** you're ready to execute, OR ask one specific clarifying question

Keep it tight — this is a 5-minute sync, not a design doc. Output your response in this format:

### Understood
<1-2 sentences confirming what you're being asked to do>

### State Check
<Brief notes from any files/state you reviewed — or "No state check needed">

### Blockers / Risks
<List any blockers, or "None">

### Execution Plan
1. ...
2. ...
3. ...

### Ready?
<"Ready to execute" OR one specific clarifying question>
`.trim();

  console.log(`[mini-meeting] Starting: ${from} <-> ${to} | Topic: ${topic}`);
  console.log(`[mini-meeting] Meeting ID: ${meetingId}`);

  // -- Spawn the agent ---------------------------------------------------------
  let agentResponse;
  let error;

  try {
    const result = await runForkedAgent({
      agentId: to,
      prompt: meetingPrompt,
      model,
      maxTurns: opts.maxTurns || 20,
      timeout,
      outputFormat: 'text',
      onProgress: (chunk) => process.stdout.write(chunk),
    });

    agentResponse = result.output || '';

    if (result.timedOut) {
      error = 'Agent timed out during meeting';
    }
  } catch (err) {
    error = err.message;
    agentResponse = '';
  }

  // -- Write meeting record ----------------------------------------------------
  const meetingRecord = {
    id: meetingId,
    from,
    to,
    topic,
    brief,
    context: context.slice(0, 500),
    startedAt,
    completedAt: new Date().toISOString(),
    agentResponse,
    error: error || null,
  };

  const meetingPath = path.join(paths.agentDir(to), 'meetings', `${meetingId}.json`);
  await fsp.writeFile(meetingPath, JSON.stringify(meetingRecord, null, 2));

  // Also write a human-readable version
  const mdPath = path.join(paths.agentDir(to), 'meetings', `${meetingId}.md`);
  await fsp.writeFile(mdPath, `# Meeting: ${topic}\n\n**ID:** ${meetingId}  \n**Date:** ${startedAt}  \n**Participants:** ${from} (leader) <-> ${to}\n\n---\n\n## Brief from ${from}\n\n${brief}\n\n---\n\n## ${to}'s Response\n\n${agentResponse}\n`);

  console.log(`\n[mini-meeting] Complete. Record: ${meetingPath}`);

  return {
    meetingId,
    agentResponse,
    error,
    meetingPath,
    mdPath,
    ready: !error && agentResponse.toLowerCase().includes('ready to execute'),
  };
}

// -- CLI mode ------------------------------------------------------------------

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };

  const from = get('--from') || 'cto';
  const to = get('--to');
  const topic = get('--topic') || 'Task Sync';
  const brief = get('--brief');
  const contextFile = get('--context-file');

  if (!to || !brief) {
    console.error('Usage: node mini-meeting.js --from <agent> --to <agent> --topic <topic> --brief "<brief>" [--context-file <path>]');
    process.exit(1);
  }

  let context = '';
  if (contextFile && fs.existsSync(contextFile)) {
    context = fs.readFileSync(contextFile, 'utf-8');
  }

  runMiniMeeting({ from, to, topic, brief, context })
    .then((result) => {
      console.log('\n=== MEETING RESULT ===');
      console.log(`Ready: ${result.ready}`);
      console.log(`Record: ${result.meetingPath}`);
      if (result.error) console.log(`Error: ${result.error}`);
    })
    .catch(console.error);
}
