/**
 * Inbox Watcher v1.0 — Auto-pickup tasks from team leader
 *
 * Polls the agent's inbox directory for pending tasks delegated by the team leader.
 * When a task is found, it feeds it into the agent's processMessage function,
 * which streams the work live to the user's Telegram.
 *
 * Usage in bot.js:
 *   import { startInboxWatcher } from '../../shared/inbox-watcher.js';
 *   startInboxWatcher({ agentId, bot, processMessage, chatId: USER_CHAT_ID });
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import paths from './paths.js';

const POLL_INTERVAL = 30_000; // 30 seconds

/**
 * Start watching the agent's inbox for delegated tasks.
 *
 * @param {Object} opts
 * @param {string} opts.agentId - This agent's ID (e.g., 'hbot')
 * @param {Object} opts.bot - Telegram bot instance
 * @param {Function} opts.processMessage - (chatId, text, media?, isVoice?) => Promise
 * @param {Function} opts.isProcessing - () => boolean — check if agent is currently busy
 * @param {string} opts.chatId - User's chat ID
 * @param {number} [opts.pollInterval] - Poll interval in ms (default 30s)
 */
export function startInboxWatcher(opts) {
  const {
    agentId,
    bot,
    processMessage,
    isProcessing,
    chatId,
    pollInterval = POLL_INTERVAL,
  } = opts;

  const inboxDir = path.join(paths.agentDir(agentId), 'inbox');

  console.log(`[inbox-watcher] Started for ${agentId} — polling every ${pollInterval / 1000}s`);

  async function checkInbox() {
    try {
      // Don't pick up tasks while already processing
      if (isProcessing && isProcessing()) {
        return;
      }

      // Ensure inbox directory exists
      if (!fs.existsSync(inboxDir)) {
        return;
      }

      // Read pending tasks
      const files = fs.readdirSync(inboxDir)
        .filter(f => f.endsWith('.json'))
        .sort(); // Process oldest first

      for (const file of files) {
        const filePath = path.join(inboxDir, file);
        let task;
        try {
          task = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
          continue;
        }

        // Skip non-pending tasks
        if (task.status !== 'pending') continue;

        // Mark as in-progress immediately
        task.status = 'in-progress';
        task.startedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));

        console.log(`[inbox-watcher] Picked up task ${task.id} from ${task.from}: "${task.task?.slice(0, 80)}"`);

        // Notify user that the agent is starting the task
        const taskNotice = `*Task received from ${task.from}*\n\n${task.task}\n\nStarting work...`;
        try {
          await bot.sendMessage(chatId, taskNotice, { parse_mode: 'Markdown' }).catch(() =>
            bot.sendMessage(chatId, taskNotice)
          );
        } catch (e) {
          console.error(`[inbox-watcher] Failed to send task notice:`, e.message?.slice(0, 100));
        }

        // Build the prompt that includes task context
        const taskPrompt = [
          `[DELEGATED TASK from team leader "${task.from}"]`,
          `Task ID: ${task.id}`,
          `Priority: ${task.priority || 'P1'}`,
          ``,
          task.task,
          ``,
          `Instructions: Complete this task. Stream your progress — report what you're doing at each step.`,
          `When done, summarize what you accomplished.`,
        ].join('\n');

        try {
          await processMessage(chatId, taskPrompt, null, false);

          // Task completed
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));

          // Move to completed directory
          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) {
            fs.mkdirSync(completedDir, { recursive: true });
          }
          const destPath = path.join(completedDir, file);
          fs.renameSync(filePath, destPath);

          console.log(`[inbox-watcher] Task ${task.id} completed and archived`);
        } catch (err) {
          console.error(`[inbox-watcher] Task ${task.id} threw error:`, err.message?.slice(0, 200));

          // Mark for retry on throw
          task.status = 'pending';
          task.retryCount = (task.retryCount || 0) + 1;
          task.lastError = err.message?.slice(0, 500);
          task.lastRetryAt = new Date().toISOString();

          if (task.retryCount >= 3) {
            task.status = 'failed';
            task.failedAt = new Date().toISOString();
            try {
              await bot.sendMessage(chatId, `Task failed: ${task.task?.slice(0, 100)}\n\nError: ${err.message?.slice(0, 200)}`);
            } catch {}
          }

          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        }

        // Only process one task per cycle
        break;
      }
    } catch (err) {
      console.error(`[inbox-watcher] Error:`, err.message?.slice(0, 200));
    }
  }

  // Start polling
  const timer = setInterval(checkInbox, pollInterval);

  // Run once immediately
  setTimeout(checkInbox, 5000);

  return {
    stop: () => clearInterval(timer),
    checkNow: checkInbox,
  };
}
