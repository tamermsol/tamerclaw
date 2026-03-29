/**
 * Meeting Orchestrator v1.0 — Agent Brainstorming Sessions
 *
 * Enables 2+ agents to have structured brainstorming meetings with:
 * - Round-robin turn-taking with full transcript context
 * - User feedback injection at any point
 * - Agent-to-user questions ([ASK_USER: ...]) that pause the meeting
 * - Real-time Telegram updates
 * - Meeting summary generation
 *
 * Usage:
 *   import { MeetingOrchestrator } from './orchestrator.js';
 *   const meeting = new MeetingOrchestrator({
 *     agents: ['smarty', 'hbot'],
 *     topic: 'Design the new dashboard',
 *     chatId: '123456',
 *     sendMessage: async (text) => { ... },
 *     maxRounds: 5
 *   });
 *   await meeting.start();
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import paths from '../shared/paths.js';

const CLAUDE_BIN = '/root/.local/bin/claude';
const AGENTS_DIR = paths.agents;
const MEETINGS_DIR = paths.meetingsRuntime;
const ACTIVE_DIR = paths.meetingsActive;
const REQUESTS_DIR = paths.meetingsRequests;
const INBOX_DIR = paths.meetingsInbox;

// Ensure directories exist
for (const dir of [MEETINGS_DIR, ACTIVE_DIR, REQUESTS_DIR, INBOX_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Load an agent's identity/system prompt for meeting context
 */
function loadAgentIdentity(agentId) {
  const identityPath = paths.agentIdentity(agentId);
  try {
    return fs.readFileSync(identityPath, 'utf-8');
  } catch {
    return `Agent: ${agentId}`;
  }
}

/**
 * Load agent's allowed tools
 */
function loadAgentTools(agentId) {
  const toolsPath = paths.agentTools(agentId);
  try {
    const content = fs.readFileSync(toolsPath, 'utf-8');
    // Extract tool names from markdown list
    const tools = content.match(/- (\w+)/g)?.map(t => t.replace('- ', '')) || [];
    return tools.length > 0 ? tools.join(' ') : 'Read Glob Grep Bash WebSearch WebFetch';
  } catch {
    return 'Read Glob Grep Bash WebSearch WebFetch';
  }
}

/**
 * Get the workspace directory for an agent
 */
function getAgentWorkspace(agentId) {
  const agentDir = paths.agentDir(agentId);
  const workspace = path.join(agentDir, 'workspace');
  if (fs.existsSync(workspace)) return workspace;
  return agentDir;
}

/**
 * Call Claude CLI for a single agent turn in the meeting
 */
function callClaudeForMeeting(agentId, systemPrompt, userMessage, model = 'sonnet') {
  return new Promise((resolve, reject) => {
    const cwd = getAgentWorkspace(agentId);
    const tools = loadAgentTools(agentId);

    const args = [
      '-p', userMessage,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '50',
      '--model', model,
      '--system-prompt', systemPrompt,
      '--allowedTools', tools
    ];

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
    }
    env.HOME = '/root';

    const proc = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let rawStdout = '';
    let stderr = '';
    let resultText = '';
    let lineBuffer = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Agent ${agentId} timed out after 5 minutes`));
    }, 5 * 60 * 1000);

    proc.stdout.on('data', (chunk) => {
      rawStdout += chunk.toString();
      lineBuffer += chunk.toString();

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Extract assistant text from stream events
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') resultText += block.text;
            }
          }
          if (event.type === 'content_block_delta' && event.delta?.text) {
            resultText += event.delta.text;
          }
          if (event.type === 'result' && event.result) {
            if (typeof event.result === 'string') {
              resultText = event.result;
            } else if (Array.isArray(event.result)) {
              resultText = event.result.filter(b => b.type === 'text').map(b => b.text).join('');
            }
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!resultText && rawStdout) {
        // Try to extract from raw output
        try {
          const lastResult = rawStdout.split('\n').reverse().find(l => {
            try { return JSON.parse(l).type === 'result'; } catch { return false; }
          });
          if (lastResult) {
            const parsed = JSON.parse(lastResult);
            if (typeof parsed.result === 'string') resultText = parsed.result;
          }
        } catch {}
      }
      if (resultText) {
        resolve(resultText.trim());
      } else if (code !== 0) {
        reject(new Error(`Agent ${agentId} exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve('[No response generated]');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Meeting states
 */
const MEETING_STATUS = {
  ACTIVE: 'active',
  PAUSED_FOR_USER: 'paused_for_user',
  PENDING_APPROVAL: 'pending_approval',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

/**
 * MeetingOrchestrator — Manages a brainstorming session between agents
 */
export class MeetingOrchestrator {
  constructor(config) {
    this.id = config.id || randomUUID().slice(0, 8);
    this.agents = config.agents;           // Array of agent IDs
    this.topic = config.topic;             // Meeting topic/goal
    this.chatId = config.chatId;           // Telegram chat ID for updates
    this.sendMessage = config.sendMessage; // async fn(text) to send Telegram messages
    this.maxRounds = config.maxRounds || 5;
    this.model = config.model || 'sonnet';
    this.status = MEETING_STATUS.ACTIVE;
    this.transcript = [];                  // Array of {agent, role, content, timestamp}
    this.pendingQuestion = null;           // {agent, question} when waiting for user
    this.userFeedback = [];                // Queue of user feedback to inject
    this.currentRound = 0;
    this.currentAgentIndex = 0;
    this.stateFile = path.join(ACTIVE_DIR, `${this.id}.json`);
    this._resolveUserAnswer = null;        // Promise resolver for user answers
    this._waitingForUser = false;
  }

  /**
   * Save meeting state to disk
   */
  async saveState() {
    const state = {
      id: this.id,
      agents: this.agents,
      topic: this.topic,
      chatId: this.chatId,
      status: this.status,
      transcript: this.transcript,
      pendingQuestion: this.pendingQuestion,
      currentRound: this.currentRound,
      currentAgentIndex: this.currentAgentIndex,
      maxRounds: this.maxRounds,
      model: this.model,
      createdAt: this.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(this.stateFile, JSON.stringify(state, null, 2));
  }

  /**
   * Build the system prompt for an agent participating in the meeting
   */
  buildMeetingPrompt(agentId) {
    const identity = loadAgentIdentity(agentId);
    const otherAgents = this.agents.filter(a => a !== agentId);

    return `${identity}

# Meeting Mode — Brainstorming Session

You are in a live brainstorming meeting with these participants:
${this.agents.map(a => `- **${a}**`).join('\n')}

## Meeting Topic
${this.topic}

## Your Role
You are **${agentId}**. Contribute your unique expertise to this discussion. Be direct, opinionated, and constructive.

## Rules
1. Build on what others have said — don't repeat points
2. Challenge ideas respectfully if you disagree
3. Propose concrete, actionable suggestions
4. Keep your response focused (2-4 paragraphs max)
5. If you need information from the user/boss to proceed, use this EXACT format on its own line:
   [ASK_USER: your specific question here]
   The meeting will pause and the boss will answer your question.
6. After receiving user feedback, integrate it into your thinking
7. When you feel the topic is well-covered, say [MEETING_RESOLVED] to signal you're satisfied

## Important
- You're talking to other agents AND the boss (user) is watching
- The boss can inject feedback at any time — treat it as high-priority input
- Be yourself — use your domain expertise and personality
- Don't be a yes-man. Push back on bad ideas.
- After the meeting, notes will be saved to your meetings/ folder — follow up on action items from your own chat
- You can request a cross-review meeting from your own chat: /meeting request agent1,agent2 topic`;
  }

  /**
   * Build the user message for a given turn
   */
  buildTurnMessage(agentId) {
    let msg = `## Meeting Transcript So Far\n\n`;

    if (this.transcript.length === 0) {
      msg += `*No discussion yet — you're kicking things off.*\n\n`;
      msg += `## Topic to Discuss\n${this.topic}\n\n`;
      msg += `Please share your initial thoughts and perspective on this topic.`;
    } else {
      // Include full transcript
      for (const entry of this.transcript) {
        if (entry.role === 'agent') {
          msg += `### ${entry.agent} said:\n${entry.content}\n\n`;
        } else if (entry.role === 'user_feedback') {
          msg += `### Boss (User) Feedback:\n${entry.content}\n\n`;
        } else if (entry.role === 'user_answer') {
          msg += `### Boss (User) Answer to ${entry.forAgent}'s Question:\n${entry.content}\n\n`;
        }
      }

      msg += `---\n\nIt's your turn, **${agentId}**. `;
      msg += `Round ${this.currentRound + 1}/${this.maxRounds}. `;
      msg += `Respond to what's been said, add your perspective, or build on the ideas.`;
    }

    return msg;
  }

  /**
   * Check if an agent's response contains a question for the user
   */
  extractUserQuestion(response) {
    const match = response.match(/\[ASK_USER:\s*(.+?)\]/s);
    return match ? match[1].trim() : null;
  }

  /**
   * Check if the meeting is being marked as resolved
   */
  checkResolved(response) {
    return response.includes('[MEETING_RESOLVED]');
  }

  /**
   * Run a single agent's turn
   */
  async runAgentTurn(agentId) {
    const systemPrompt = this.buildMeetingPrompt(agentId);
    const turnMessage = this.buildTurnMessage(agentId);

    await this.sendMessage(`\u{1F399} **${agentId}** is thinking...`);

    try {
      const response = await callClaudeForMeeting(agentId, systemPrompt, turnMessage, this.model);

      // Add to transcript
      this.transcript.push({
        agent: agentId,
        role: 'agent',
        content: response,
        timestamp: new Date().toISOString()
      });

      // Send the response to Telegram (truncate if very long)
      const displayText = response.length > 3500
        ? response.slice(0, 3500) + '\n\n... (truncated)'
        : response;
      await this.sendMessage(`\u{1F4AC} **${agentId}:**\n\n${displayText}`);

      // Check for user question
      const question = this.extractUserQuestion(response);
      if (question) {
        return { type: 'ask_user', question, agent: agentId };
      }

      // Check if resolved
      if (this.checkResolved(response)) {
        return { type: 'resolved', agent: agentId };
      }

      return { type: 'continue' };
    } catch (err) {
      await this.sendMessage(`\u26A0\uFE0F **${agentId}** encountered an error: ${err.message}`);
      return { type: 'error', error: err.message };
    }
  }

  /**
   * Inject user feedback into the meeting
   */
  async addUserFeedback(feedback) {
    this.transcript.push({
      role: 'user_feedback',
      content: feedback,
      timestamp: new Date().toISOString()
    });
    await this.saveState();

    // If we're in active meeting (not paused), the feedback will be picked up next turn
    // If paused for a question, this is separate from the answer
  }

  /**
   * Answer a pending agent question
   */
  async answerQuestion(answer) {
    if (!this.pendingQuestion) return false;

    this.transcript.push({
      role: 'user_answer',
      forAgent: this.pendingQuestion.agent,
      content: answer,
      timestamp: new Date().toISOString()
    });

    const agent = this.pendingQuestion.agent;
    this.pendingQuestion = null;
    this.status = MEETING_STATUS.ACTIVE;
    await this.saveState();

    await this.sendMessage(`\u2705 Answer received. Resuming meeting — **${agent}** will process your input.`);

    // Resolve the waiting promise so the meeting loop continues
    if (this._resolveUserAnswer) {
      this._resolveUserAnswer(answer);
      this._resolveUserAnswer = null;
    } else {
      // Meeting was restored from disk — no running loop. Restart it.
      // Give the answering agent a follow-up turn, then resume the main loop
      console.log(`[meeting] Restored meeting ${this.id} — resuming loop after user answer`);
      this.resumeAfterRestore(agent).catch(err => {
        console.error(`[meeting] Resume error: ${err.message}`);
      });
    }

    return true;
  }

  /**
   * Resume a meeting that was restored from disk after a user answer
   */
  async resumeAfterRestore(answeringAgent) {
    // Give the agent that asked the question a follow-up turn
    await this.sendMessage(`\u{1F4E5} Feeding your answer back to **${answeringAgent}**...`);
    const followUp = await this.runAgentTurn(answeringAgent);
    await this.saveState();

    // Now resume the main loop from where we left off
    // Advance to the next agent after the one that asked
    const askingIdx = this.agents.indexOf(answeringAgent);
    if (askingIdx >= 0) {
      this.currentAgentIndex = askingIdx + 1;
    }
    await this.runLoop();
  }

  /**
   * Wait for user to answer a question (returns a promise)
   */
  waitForUserAnswer() {
    this._waitingForUser = true;
    return new Promise((resolve) => {
      this._resolveUserAnswer = resolve;
      // Also set a timeout — if no answer in 10 minutes, resume anyway
      setTimeout(() => {
        if (this._waitingForUser) {
          this._waitingForUser = false;
          this._resolveUserAnswer = null;
          resolve('[No answer provided — the boss was unavailable. Continue with your best judgment.]');
        }
      }, 10 * 60 * 1000);
    });
  }

  /**
   * Start the meeting
   */
  async start() {
    this.createdAt = new Date().toISOString();
    await this.saveState();

    // Announce the meeting
    const agentList = this.agents.map(a => `  - ${a}`).join('\n');
    await this.sendMessage(
      `\u{1F3AF} **Meeting Started**\n\n` +
      `Topic: ${this.topic}\n` +
      `Participants:\n${agentList}\n` +
      `Max Rounds: ${this.maxRounds}\n\n` +
      `Commands:\n` +
      `- /meeting feedback <text> — inject your thoughts\n` +
      `- /meeting answer <text> — answer an agent's question\n` +
      `- /meeting approve — accept output when discussion ends\n` +
      `- /meeting more <direction> — request more rounds\n` +
      `- /meeting end — end the meeting early\n` +
      `- /meeting status — check meeting status`
    );

    // Run the meeting loop
    await this.runLoop();
  }

  /**
   * Main meeting loop — round-robin agent turns
   */
  async runLoop() {
    let resolvedCount = 0;

    for (this.currentRound = 0; this.currentRound < this.maxRounds; this.currentRound++) {
      if (this.status === MEETING_STATUS.CANCELLED) break;

      await this.sendMessage(`\u{1F504} **Round ${this.currentRound + 1}/${this.maxRounds}**`);

      for (this.currentAgentIndex = 0; this.currentAgentIndex < this.agents.length; this.currentAgentIndex++) {
        if (this.status === MEETING_STATUS.CANCELLED) break;

        // Check for any queued user feedback and inject it
        while (this.userFeedback.length > 0) {
          const fb = this.userFeedback.shift();
          await this.addUserFeedback(fb);
        }

        const agentId = this.agents[this.currentAgentIndex];
        const result = await this.runAgentTurn(agentId);

        await this.saveState();

        if (result.type === 'ask_user') {
          // Pause meeting for user question
          this.pendingQuestion = { agent: result.agent, question: result.question };
          this.status = MEETING_STATUS.PAUSED_FOR_USER;
          await this.saveState();

          await this.sendMessage(
            `\u2753 **${result.agent}** has a question for you:\n\n` +
            `${result.question}\n\n` +
            `Reply with: /meeting answer <your answer>`
          );

          // Wait for user answer
          const answer = await this.waitForUserAnswer();
          this._waitingForUser = false;

          // Now give the asking agent a follow-up turn with the answer
          await this.sendMessage(`\u{1F4E5} Feeding your answer back to **${result.agent}**...`);
          const followUp = await this.runAgentTurn(result.agent);
          await this.saveState();

          if (followUp.type === 'resolved') resolvedCount++;
        } else if (result.type === 'resolved') {
          resolvedCount++;
          // If all agents are satisfied, end early
          if (resolvedCount >= this.agents.length) {
            await this.sendMessage(`\u2705 All participants are satisfied. Wrapping up.`);
            break;
          }
        } else if (result.type === 'error') {
          // Continue with next agent on error
          continue;
        }
      }

      // Check if all resolved
      if (resolvedCount >= this.agents.length) break;
    }

    // Meeting rounds done — ask user for approval before closing
    await this.requestApproval();
  }

  /**
   * Request user approval before closing the meeting
   */
  async requestApproval() {
    this.status = MEETING_STATUS.PENDING_APPROVAL;
    this._waitingForApproval = true;
    await this.saveState();

    await this.sendMessage(
      `\u{1F4CB} **Meeting Discussion Complete**\n\n` +
      `The agents have finished ${this.currentRound + 1} rounds of discussion.\n\n` +
      `What would you like to do?\n` +
      `- /meeting approve — Accept the output and close\n` +
      `- /meeting more <direction> — Continue with more rounds (add optional direction)\n` +
      `- /meeting feedback <text> — Add feedback and continue\n` +
      `- /meeting end — Cancel without summary`
    );

    // Wait for user decision
    const decision = await this.waitForApproval();
    this._waitingForApproval = false;

    if (decision.action === 'approve') {
      await this.wrapUp();
    } else if (decision.action === 'more') {
      // Inject any direction as feedback
      if (decision.direction) {
        await this.addUserFeedback(decision.direction);
      }
      // Run more rounds
      const extraRounds = decision.extraRounds || 3;
      this.maxRounds = this.currentRound + 1 + extraRounds;
      this.status = MEETING_STATUS.ACTIVE;
      await this.saveState();
      await this.sendMessage(`\u{1F504} Continuing for ${extraRounds} more rounds...`);
      await this.runLoop();
    } else if (decision.action === 'cancel') {
      await this.cancel();
    }
  }

  /**
   * Wait for user approval decision
   */
  waitForApproval() {
    return new Promise((resolve) => {
      this._resolveApproval = resolve;
      // Timeout after 30 minutes — default to approve
      setTimeout(() => {
        if (this._waitingForApproval) {
          this._waitingForApproval = false;
          this._resolveApproval = null;
          resolve({ action: 'approve' });
        }
      }, 30 * 60 * 1000);
    });
  }

  /**
   * Handle the user's approval decision
   */
  async handleApproval(action, direction = '') {
    if (!this._resolveApproval) {
      // Meeting was restored from disk — handle directly
      if (action === 'approve') {
        await this.wrapUp();
      } else if (action === 'more') {
        if (direction) await this.addUserFeedback(direction);
        const extraRounds = 3;
        this.maxRounds = this.currentRound + 1 + extraRounds;
        this.status = MEETING_STATUS.ACTIVE;
        await this.saveState();
        await this.sendMessage(`\u{1F504} Continuing for ${extraRounds} more rounds...`);
        await this.runLoop();
      }
      return;
    }
    this._resolveApproval({ action, direction });
    this._resolveApproval = null;
  }

  /**
   * Distribute meeting notes to each participating agent's workspace
   */
  async distributeMeetingNotes(summary) {
    const timestamp = new Date().toISOString().slice(0, 10);
    const noteContent = `# Meeting Notes — ${timestamp}
## Meeting ID: ${this.id}
## Topic: ${this.topic}
## Participants: ${this.agents.join(', ')}
## Rounds: ${this.currentRound + 1}

## Summary
${summary}

## Full Transcript
${this.transcript.map(entry => {
  if (entry.role === 'agent') return `### ${entry.agent}:\n${entry.content}\n`;
  if (entry.role === 'user_feedback') return `### Boss (User) Feedback:\n${entry.content}\n`;
  if (entry.role === 'user_answer') return `### Boss answered ${entry.forAgent}:\n${entry.content}\n`;
  return '';
}).join('\n')}

## Action Items
Review the summary above and follow up on any items assigned to you.
You can request a cross-review meeting with another agent using:
[REQUEST_MEETING: agent1,agent2 topic description]
`;

    for (const agentId of this.agents) {
      const notesDir = path.join(paths.agentDir(agentId), 'meetings');
      try {
        if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
        const noteFile = path.join(notesDir, `meeting-${this.id}-${timestamp}.md`);
        await fsp.writeFile(noteFile, noteContent);

        // Also write a latest-meeting.md for easy access
        const latestFile = path.join(notesDir, 'latest-meeting.md');
        await fsp.writeFile(latestFile, noteContent);
      } catch (err) {
        console.error(`[meeting] Failed to write notes for ${agentId}: ${err.message}`);
      }
    }
  }

  /**
   * End the meeting and generate a summary
   */
  async wrapUp() {
    this.status = MEETING_STATUS.COMPLETED;
    await this.saveState();

    // Use the first agent to generate a summary
    const summaryAgent = this.agents[0];
    const summaryPrompt = `You were in a meeting. Here's the full transcript. Generate a concise summary with:
1. Key decisions made
2. Action items (who does what)
3. Open questions remaining
4. Main ideas discussed

Be concise — bullet points preferred.`;

    const transcriptText = this.transcript.map(entry => {
      if (entry.role === 'agent') return `**${entry.agent}:** ${entry.content}`;
      if (entry.role === 'user_feedback') return `**Boss (User):** ${entry.content}`;
      if (entry.role === 'user_answer') return `**Boss answered ${entry.forAgent}:** ${entry.content}`;
      return '';
    }).join('\n\n');

    const summaryMessage = `${summaryPrompt}\n\n## Full Transcript\n\n${transcriptText}`;

    try {
      await this.sendMessage(`\u{1F4DD} Generating meeting summary...`);
      const summary = await callClaudeForMeeting(
        summaryAgent,
        `You are a meeting note-taker. Summarize meetings concisely.`,
        summaryMessage,
        'haiku'
      );

      await this.sendMessage(
        `\u{1F3AF} **Meeting Complete**\n\n` +
        `## Summary\n${summary}\n\n` +
        `Meeting ID: ${this.id}\n` +
        `Duration: ${this.transcript.length} exchanges over ${this.currentRound + 1} rounds\n\n` +
        `Meeting notes have been distributed to all participating agents. ` +
        `They can follow up from their own chats.`
      );

      // Distribute notes to all agents
      await this.distributeMeetingNotes(summary);
    } catch (err) {
      // Fallback: just announce completion
      const fallbackSummary = `Meeting on "${this.topic}" — ${this.transcript.length} exchanges over ${this.currentRound + 1} rounds.`;
      await this.sendMessage(
        `\u{1F3AF} **Meeting Complete**\n\n` +
        `${fallbackSummary}\n` +
        `Meeting ID: ${this.id}\n\n` +
        `Meeting notes have been distributed to all participating agents.`
      );
      await this.distributeMeetingNotes(fallbackSummary);
    }

    // Archive the meeting
    const archivePath = path.join(MEETINGS_DIR, `archive-${this.id}.json`);
    try {
      await fsp.rename(this.stateFile, archivePath);
    } catch {}
  }

  /**
   * Cancel the meeting
   */
  async cancel() {
    this.status = MEETING_STATUS.CANCELLED;
    await this.saveState();

    // If waiting for user answer, resolve to unblock
    if (this._resolveUserAnswer) {
      this._resolveUserAnswer('[Meeting cancelled]');
      this._resolveUserAnswer = null;
    }

    await this.sendMessage(`\u274C **Meeting cancelled.** ${this.transcript.length} exchanges recorded.`);
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      id: this.id,
      status: this.status,
      topic: this.topic,
      agents: this.agents,
      round: `${this.currentRound + 1}/${this.maxRounds}`,
      exchanges: this.transcript.length,
      pendingQuestion: this.pendingQuestion
    };
  }
}

/**
 * Load a meeting from disk (for resuming after restart)
 */
export async function loadMeeting(meetingId, sendMessage) {
  const stateFile = path.join(ACTIVE_DIR, `${meetingId}.json`);
  try {
    const state = JSON.parse(await fsp.readFile(stateFile, 'utf-8'));
    const meeting = new MeetingOrchestrator({
      id: state.id,
      agents: state.agents,
      topic: state.topic,
      chatId: state.chatId,
      sendMessage,
      maxRounds: state.maxRounds,
      model: state.model
    });
    meeting.transcript = state.transcript || [];
    meeting.status = state.status;
    meeting.pendingQuestion = state.pendingQuestion;
    meeting.currentRound = state.currentRound || 0;
    meeting.currentAgentIndex = state.currentAgentIndex || 0;
    meeting.createdAt = state.createdAt;
    return meeting;
  } catch {
    return null;
  }
}

/**
 * List active meetings
 */
export async function listActiveMeetings() {
  try {
    const files = await fsp.readdir(ACTIVE_DIR);
    const meetings = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const state = JSON.parse(await fsp.readFile(path.join(ACTIVE_DIR, file), 'utf-8'));
        meetings.push({
          id: state.id,
          topic: state.topic,
          agents: state.agents,
          status: state.status,
          chatId: state.chatId,
          exchanges: (state.transcript || []).length,
          round: `${(state.currentRound || 0) + 1}/${state.maxRounds}`
        });
      } catch {}
    }
    return meetings;
  } catch {
    return [];
  }
}

export { MEETING_STATUS };
