/**
 * Meeting Commands v1.0 — Telegram command handler for agent meetings
 *
 * Integrates with any standalone bot that uses bot-template.js.
 * Adds /meeting command support to manage brainstorming sessions.
 *
 * Usage in a bot.js:
 *   import { MeetingCommandHandler } from '../../meetings/meeting-commands.js';
 *   const meetingHandler = new MeetingCommandHandler(bot, agentId);
 *   // In your message handler: if (meetingHandler.handle(msg)) return;
 */

import { MeetingOrchestrator, loadMeeting, listActiveMeetings, MEETING_STATUS } from './orchestrator.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import paths from '../shared/paths.js';

const MEETINGS_DIR = paths.meetingsRuntime;
const REQUESTS_DIR = paths.meetingsRequests;
const INBOX_DIR = paths.meetingsInbox;

// Global registry of active meetings per chat
const activeMeetings = new Map(); // chatId -> MeetingOrchestrator

export class MeetingCommandHandler {
  constructor(telegramBot, agentId) {
    this.bot = telegramBot;
    this.agentId = agentId;
  }

  /**
   * Create a sendMessage function bound to a chat
   */
  createSender(chatId) {
    return async (text) => {
      // Split long messages
      const MAX_LEN = 4000;
      if (text.length <= MAX_LEN) {
        try {
          await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch {
          // Fallback without markdown if parsing fails
          await this.bot.sendMessage(chatId, text);
        }
      } else {
        const parts = splitMessage(text, MAX_LEN);
        for (const part of parts) {
          try {
            await this.bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
          } catch {
            await this.bot.sendMessage(chatId, part);
          }
        }
      }
    };
  }

  /**
   * Handle a message — returns true if it was a meeting command
   */
  async handle(msg) {
    const text = (msg.text || '').trim();
    const chatId = String(msg.chat.id);

    if (!text.startsWith('/meeting')) return false;

    const parts = text.replace('/meeting', '').trim();
    const [subcommand, ...rest] = parts.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (subcommand) {
      case 'start':
        await this.handleStart(chatId, arg);
        break;
      case 'feedback':
        await this.handleFeedback(chatId, arg);
        break;
      case 'answer':
        await this.handleAnswer(chatId, arg);
        break;
      case 'approve':
        await this.handleApprove(chatId);
        break;
      case 'more':
        await this.handleMore(chatId, arg);
        break;
      case 'request':
        await this.handleRequest(chatId, arg);
        break;
      case 'end':
      case 'cancel':
        await this.handleEnd(chatId);
        break;
      case 'status':
        await this.handleStatus(chatId);
        break;
      case 'list':
        await this.handleList(chatId);
        break;
      default:
        await this.sendHelp(chatId);
        break;
    }

    return true;
  }

  /**
   * /meeting start agent1,agent2 Topic goes here
   */
  async handleStart(chatId, arg) {
    const send = this.createSender(chatId);

    // Check if there's already an active meeting in this chat
    const existing = activeMeetings.get(chatId);
    if (existing && existing.status === MEETING_STATUS.ACTIVE) {
      await send(`There's already an active meeting (${existing.id}). End it first with /meeting end`);
      return;
    }

    // Parse: agents topic
    // Format: /meeting start smarty,hbot Design the new dashboard
    const match = arg.match(/^([\w,]+)\s+(.+)$/s);
    if (!match) {
      await send(
        `Usage: /meeting start agent1,agent2 Topic description\n\n` +
        `Example:\n/meeting start smarty,hbot Design the smart home dashboard`
      );
      return;
    }

    const agents = match[1].split(',').map(a => a.trim()).filter(Boolean);
    const topic = match[2].trim();

    if (agents.length < 2) {
      await send(`Need at least 2 agents for a meeting. Got: ${agents.join(', ')}`);
      return;
    }

    // Validate agents exist
    const { existsSync } = await import('fs');
    const invalid = agents.filter(a => !existsSync(paths.agentDir(a)));
    if (invalid.length > 0) {
      await send(`Unknown agents: ${invalid.join(', ')}`);
      return;
    }

    const meeting = new MeetingOrchestrator({
      agents,
      topic,
      chatId,
      sendMessage: send,
      maxRounds: 5,
      model: 'sonnet'
    });

    activeMeetings.set(chatId, meeting);

    // Start the meeting in the background (non-blocking)
    meeting.start().catch(async (err) => {
      await send(`Meeting error: ${err.message}`);
      activeMeetings.delete(chatId);
    }).then(() => {
      // Clean up when done
      if (meeting.status === MEETING_STATUS.COMPLETED || meeting.status === MEETING_STATUS.CANCELLED) {
        activeMeetings.delete(chatId);
      }
    });
  }

  /**
   * /meeting feedback Your thoughts here
   */
  async handleFeedback(chatId, feedback) {
    const send = this.createSender(chatId);
    const meeting = activeMeetings.get(chatId);

    if (!meeting) {
      await send(`No active meeting. Start one with /meeting start`);
      return;
    }

    if (!feedback) {
      await send(`Usage: /meeting feedback Your thoughts or direction here`);
      return;
    }

    // If meeting is pending approval, feedback = continue with direction
    if (meeting.status === MEETING_STATUS.PENDING_APPROVAL) {
      await meeting.handleApproval('more', feedback);
      return;
    }

    await meeting.addUserFeedback(feedback);
    await send(`Feedback noted. It'll be included in the next agent's turn.`);
  }

  /**
   * /meeting answer Your answer to the agent's question
   */
  async handleAnswer(chatId, answer) {
    const send = this.createSender(chatId);
    const meeting = activeMeetings.get(chatId);

    if (!meeting) {
      await send(`No active meeting.`);
      return;
    }

    if (meeting.status !== MEETING_STATUS.PAUSED_FOR_USER) {
      await send(`No pending question. The meeting is running.`);
      return;
    }

    if (!answer) {
      await send(
        `An agent asked: ${meeting.pendingQuestion?.question}\n\n` +
        `Reply with: /meeting answer Your answer here`
      );
      return;
    }

    await meeting.answerQuestion(answer);
  }

  /**
   * /meeting approve — Accept the meeting output
   */
  async handleApprove(chatId) {
    const send = this.createSender(chatId);
    const meeting = activeMeetings.get(chatId);

    if (!meeting) {
      await send(`No active meeting.`);
      return;
    }

    if (meeting.status !== MEETING_STATUS.PENDING_APPROVAL) {
      await send(`Meeting isn't waiting for approval. Current status: ${meeting.status}`);
      return;
    }

    await meeting.handleApproval('approve');
    // Clean up after wrap-up completes
    if (meeting.status === MEETING_STATUS.COMPLETED) {
      activeMeetings.delete(chatId);
    }
  }

  /**
   * /meeting more <optional direction> — Continue the meeting with more rounds
   */
  async handleMore(chatId, direction) {
    const send = this.createSender(chatId);
    const meeting = activeMeetings.get(chatId);

    if (!meeting) {
      await send(`No active meeting.`);
      return;
    }

    if (meeting.status !== MEETING_STATUS.PENDING_APPROVAL) {
      await send(`Meeting isn't waiting for approval. Use /meeting feedback to add thoughts during active discussion.`);
      return;
    }

    await meeting.handleApproval('more', direction || '');
  }

  /**
   * /meeting request agent1,agent2 Topic — Agent-initiated meeting request
   * Can be called by an agent from its own chat to request a cross-review
   */
  async handleRequest(chatId, arg) {
    const send = this.createSender(chatId);

    const match = arg.match(/^([\w,]+)\s+(.+)$/s);
    if (!match) {
      await send(
        `Usage: /meeting request agent1,agent2 Topic\n\n` +
        `Example:\n/meeting request smarty,hbot Cross-review the dashboard implementation`
      );
      return;
    }

    const agents = match[1].split(',').map(a => a.trim()).filter(Boolean);
    const topic = match[2].trim();

    // Write a meeting request file that other agents/relay can pick up
    if (!fs.existsSync(REQUESTS_DIR)) fs.mkdirSync(REQUESTS_DIR, { recursive: true });

    const requestId = randomUUID().slice(0, 8);
    const request = {
      id: requestId,
      requestedBy: this.agentId,
      agents,
      topic,
      chatId,
      createdAt: new Date().toISOString(),
      status: 'pending'
    };

    await fsp.writeFile(
      path.join(REQUESTS_DIR, `${requestId}.json`),
      JSON.stringify(request, null, 2)
    );

    await send(
      `\u{1F4E8} **Meeting Request Created**\n\n` +
      `- ID: ${requestId}\n` +
      `- Requested by: ${this.agentId}\n` +
      `- Participants: ${agents.join(', ')}\n` +
      `- Topic: ${topic}\n\n` +
      `The boss will be notified to approve and start this meeting.\n` +
      `To start it: /meeting start ${agents.join(',')} ${topic}`
    );

    // Also write to a shared inbox for the relay/supreme to pick up
    if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(INBOX_DIR, `request-${requestId}.json`),
      JSON.stringify(request, null, 2)
    );
  }

  /**
   * /meeting end
   */
  async handleEnd(chatId) {
    const send = this.createSender(chatId);
    const meeting = activeMeetings.get(chatId);

    if (!meeting) {
      await send(`No active meeting to end.`);
      return;
    }

    await meeting.cancel();
    activeMeetings.delete(chatId);
  }

  /**
   * /meeting status
   */
  async handleStatus(chatId) {
    const send = this.createSender(chatId);
    const meeting = activeMeetings.get(chatId);

    if (!meeting) {
      await send(`No active meeting.`);
      return;
    }

    const status = meeting.getStatus();
    let msg = `Meeting ${status.id}\n`;
    msg += `- Status: ${status.status}\n`;
    msg += `- Topic: ${status.topic}\n`;
    msg += `- Agents: ${status.agents.join(', ')}\n`;
    msg += `- Round: ${status.round}\n`;
    msg += `- Exchanges: ${status.exchanges}`;

    if (status.pendingQuestion) {
      msg += `\n\nPending question from ${status.pendingQuestion.agent}:\n${status.pendingQuestion.question}`;
    }

    await send(msg);
  }

  /**
   * /meeting list
   */
  async handleList(chatId) {
    const send = this.createSender(chatId);
    const meetings = await listActiveMeetings();

    if (meetings.length === 0) {
      await send(`No active meetings.`);
      return;
    }

    let msg = `Active Meetings:\n\n`;
    for (const m of meetings) {
      msg += `- ${m.id}: "${m.topic}" (${m.agents.join(', ')}) — ${m.status}, ${m.exchanges} exchanges\n`;
    }
    await send(msg);
  }

  /**
   * /meeting (help)
   */
  async sendHelp(chatId) {
    const send = this.createSender(chatId);
    await send(
      `Meeting Commands:\n\n` +
      `- /meeting start agent1,agent2 Topic\n` +
      `  Start a brainstorming session\n\n` +
      `- /meeting feedback Your thoughts\n` +
      `  Inject feedback during discussion\n\n` +
      `- /meeting answer Your answer\n` +
      `  Answer an agent's question\n\n` +
      `- /meeting approve\n` +
      `  Accept the meeting output and close\n\n` +
      `- /meeting more <direction>\n` +
      `  Continue with more rounds (optional direction)\n\n` +
      `- /meeting request agent1,agent2 Topic\n` +
      `  Agent requests a cross-review meeting\n\n` +
      `- /meeting status\n` +
      `  Check meeting progress\n\n` +
      `- /meeting end\n` +
      `  End the meeting early\n\n` +
      `Example:\n` +
      `/meeting start smarty,hbot Plan the IoT dashboard features`
    );
  }
}

/**
 * Get the active meeting for a chat (for external access)
 */
export function getActiveMeeting(chatId) {
  return activeMeetings.get(chatId) || null;
}

/**
 * Split long messages
 */
function splitMessage(text, maxLen) {
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Find a good split point
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return parts;
}
