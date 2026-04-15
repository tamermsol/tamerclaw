/**
 * Inbox Watcher v2.0 — Auto-pickup tasks from team leader
 *
 * Polls the agent's inbox directory for pending tasks delegated by the team leader.
 * When a task is found, it feeds it into the agent's processMessage function,
 * which streams the work live to the user's Telegram.
 *
 * v2.0 changes:
 * - Mandatory structured reporting: agents must write an outbox report when done
 * - Blocker reporting: failed tasks auto-report blockers to delegator
 * - Loop prevention: completion reports are never re-reported back
 *
 * Usage in bot.js:
 *   import { startInboxWatcher } from '../../shared/inbox-watcher.js';
 *   startInboxWatcher({ agentId, bot, processMessage, chatId: USER_CHAT_ID });
 */

import fs from 'fs';
import path from 'path';
import paths from './paths.js';

// Optional: task-registry integration (may not exist in all installs)
let TaskRegistry = null;
try {
  const mod = await import('./task-registry.js');
  TaskRegistry = mod.TaskRegistry;
} catch {
  // task-registry not available — registry updates will be skipped
}

const AGENTS_DIR = paths.agents;
const POLL_INTERVAL = 30_000; // 30 seconds

/**
 * Read the agent's outbox report for a given task (written by the agent during processMessage).
 * Returns the report content or null if not found.
 */
function readOutboxReport(agentId, taskId) {
  const outboxDir = path.join(paths.agentDir(agentId), 'outbox');
  if (!fs.existsSync(outboxDir)) return null;
  // Look for a report file matching this task
  const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(outboxDir, file), 'utf-8'));
      if (data.taskId === taskId || data.id === taskId) {
        return data;
      }
    } catch {}
  }
  // No matching file — return null (report is optional, not a blocker)
  return null;
}

/**
 * Update the task registry when an agent completes a delegated task.
 * Finds matching tasks/subtasks and transitions their status.
 */
function updateTaskRegistryOnCompletion(agentId, task, outboxReport) {
  if (!TaskRegistry) return; // skip if task-registry not available

  try {
    const registry = new TaskRegistry();
    const status = outboxReport?.status || 'completed';

    // Strategy 1: Match by task ID embedded in the inbox task
    // The inbox task's `id` field may reference a registry task ID or contain it
    const inboxTaskId = task.id || '';
    const allActive = registry.getActiveTasks();

    for (const regTask of allActive) {
      // Check if this agent is a delegated worker for this task
      if (!regTask.delegatedTo.includes(agentId) && regTask.assignedTo !== agentId) continue;

      // Try to match subtasks assigned to this agent
      let subtaskMatched = false;
      for (const sub of regTask.subtasks) {
        if (sub.assignee === agentId && sub.status !== 'completed') {
          try {
            const output = outboxReport?.accomplished || `Completed by ${agentId}`;
            registry.updateSubtask(regTask.id, sub.id, 'completed', output);
            console.log(`[inbox-watcher] Registry: marked subtask ${sub.id} as completed for task ${regTask.id}`);
            subtaskMatched = true;
          } catch (e) {
            console.error(`[inbox-watcher] Registry subtask update failed: ${e.message?.slice(0, 150)}`);
          }
          break; // one subtask per completion
        }
      }

      // If no subtasks exist but this agent is delegated, create a subtask and mark it done
      if (!subtaskMatched && regTask.delegatedTo.includes(agentId)) {
        try {
          const sub = registry.addSubtask(regTask.id, {
            assignee: agentId,
            description: task.task?.slice(0, 200) || `Task from ${task.from || 'unknown'}`,
          });
          const output = outboxReport?.accomplished || `Completed by ${agentId}`;
          registry.updateSubtask(regTask.id, sub.id, 'completed', output);
          console.log(`[inbox-watcher] Registry: created+completed subtask ${sub.id} for task ${regTask.id}`);
        } catch (e) {
          console.error(`[inbox-watcher] Registry create+complete subtask failed: ${e.message?.slice(0, 150)}`);
        }
      }

      // If task is still in received/delegated, transition to in_progress first
      if (regTask.status === 'received' || regTask.status === 'delegated') {
        try {
          registry.updateStatus(regTask.id, 'in_progress', agentId, `Agent ${agentId} working`);
          console.log(`[inbox-watcher] Registry: task ${regTask.id} → in_progress`);
        } catch (e) {
          // May already be in_progress, that's fine
        }
      }

      // Add deliverables from outbox report
      if (outboxReport?.artifacts && Array.isArray(outboxReport.artifacts)) {
        for (const artifact of outboxReport.artifacts) {
          try {
            registry.addDeliverable(regTask.id, {
              type: 'artifact',
              value: typeof artifact === 'string' ? artifact : JSON.stringify(artifact),
              addedBy: agentId,
            });
          } catch {}
        }
      }

      // Check-in with completion summary
      try {
        const summary = outboxReport?.accomplished || 'Task completed';
        registry.checkIn(regTask.id, agentId, `COMPLETED: ${typeof summary === 'string' ? summary.slice(0, 300) : JSON.stringify(summary).slice(0, 300)}`, 100);
      } catch {}

      break; // matched one task, done
    }
  } catch (e) {
    console.error(`[inbox-watcher] Task registry update error: ${e.message?.slice(0, 200)}`);
  }
}

/**
 * Send a structured report back to the delegating agent's inbox.
 * Never sends a report for a completion report (loop prevention).
 */
function sendReportToDelegator(agentId, task, status, summary, outboxReport) {
  const isCompletionReport = (task.task || '').trimStart().startsWith('[TASK COMPLETION REPORT');
  const reportCount = ((task.id || '').match(/-report-/g) || []).length;
  if (isCompletionReport || reportCount >= 2) {
    console.log(`[inbox-watcher] Skipping report to ${task.from} — loop prevention`);
    return;
  }
  if (!task.from) return;

  const fromDir = path.join(paths.agentDir(task.from), 'inbox');
  if (!fs.existsSync(fromDir)) return;

  try {
    const ts = Date.now();
    const reportBody = [
      `[TASK COMPLETION REPORT from ${agentId}]`,
      `Task ID: ${task.id}`,
      `Status: ${status}`,
      `Started: ${task.startedAt}`,
      `Completed: ${new Date().toISOString()}`,
      ``,
      `Summary: ${summary}`,
    ];

    if (outboxReport) {
      if (outboxReport.accomplished) reportBody.push(`\nAccomplished:\n${outboxReport.accomplished}`);
      if (outboxReport.remaining)    reportBody.push(`\nRemaining:\n${outboxReport.remaining}`);
      if (outboxReport.blockers)     reportBody.push(`\nBlockers:\n${outboxReport.blockers}`);
      if (outboxReport.artifacts)    reportBody.push(`\nArtifacts:\n${JSON.stringify(outboxReport.artifacts)}`);
    }

    reportBody.push(`\nOriginal task: ${(task.task || '').slice(0, 200)}`);

    fs.writeFileSync(path.join(fromDir, `${agentId}-done-${ts}.json`), JSON.stringify({
      id: `${agentId}-report-${task.id}`,
      from: agentId,
      status: 'pending',
      priority: 'P2',
      task: reportBody.join('\n'),
      createdAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[inbox-watcher] Report sent to ${task.from} — ${status}`);
  } catch (e) {
    console.error(`[inbox-watcher] Failed to send report to ${task.from}:`, e.message?.slice(0, 100));
  }
}

/**
 * Start watching the agent's inbox for delegated tasks.
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

  console.log(`[inbox-watcher] v2.0 started for ${agentId} — polling every ${pollInterval / 1000}s`);

  async function checkInbox() {
    try {
      if (isProcessing && isProcessing()) return;
      if (!fs.existsSync(inboxDir)) return;

      const files = fs.readdirSync(inboxDir)
        .filter(f => f.endsWith('.json'))
        .sort(); // oldest first

      for (const file of files) {
        const filePath = path.join(inboxDir, file);
        let task;
        try {
          task = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch { continue; }

        // Treat missing status or undefined as 'pending' (tasks written by agents/scripts may omit it)
        if (task.status && task.status !== 'pending') continue;

        // Loop detection — auto-archive without processing
        // Only block report-of-report (2+ bounces), NOT first-level completion reports
        const reportCount = ((task.id || '').match(/-report-/g) || []).length;
        if (reportCount >= 2) {
          console.log(`[inbox-watcher] Loop detected (${reportCount} bounces) — archiving without processing`);
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          task.loopPrevented = true;
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
          fs.renameSync(filePath, path.join(completedDir, file));
          continue;
        }

        // Guard: skip nudges/continuations with empty content too
        if ((task.type === 'nudge' || task.type === 'escalation' || task.type === 'review' || task.type === 'continuation') &&
            (!task.task || (typeof task.task === 'string' && task.task.trim() === ''))) {
          console.log(`[inbox-watcher] Skipping empty ${task.type} from ${task.from || 'unknown'} — no task content`);
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          task.skippedReason = 'empty-continuation-content';
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
          fs.renameSync(filePath, path.join(completedDir, file));
          continue;
        }

        // Nudge/escalation/continuation — process through Claude so agent actually works
        // "continuation" type = autopilot telling agent to RESUME work (includes full task context)
        // "nudge"/"escalation" = older style, also processed but with continuation framing
        if (task.type === 'nudge' || task.type === 'escalation' || task.type === 'review' || task.type === 'continuation') {
          const effectiveType = task.type === 'continuation' ? 'continuation' : task.type;
          console.log(`[inbox-watcher] ${effectiveType} from ${task.from} — processing through Claude`);

          // Throttle: skip if we already processed a continuation in the last 5 minutes
          // (increased from 3 min — agents need time to work, not just respond)
          const throttleFile = path.join(inboxDir, `.last-continuation-processed`);
          const now = Date.now();
          const THROTTLE_MS = 300_000; // 5 minutes
          try {
            if (fs.existsSync(throttleFile)) {
              const lastTime = parseInt(fs.readFileSync(throttleFile, 'utf-8'), 10);
              if (now - lastTime < THROTTLE_MS) {
                console.log(`[inbox-watcher] ${effectiveType} throttled — last one was ${Math.round((now - lastTime) / 1000)}s ago`);
                task.status = 'completed';
                task.completedAt = new Date().toISOString();
                task.throttled = true;
                fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
                const completedDir = path.join(inboxDir, 'completed');
                if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
                fs.renameSync(filePath, path.join(completedDir, file));
                continue;
              }
            }
          } catch {}

          // Mark as recently processed
          try { fs.writeFileSync(throttleFile, String(now)); } catch {}

          // Build a CONTINUATION prompt — tells agent to RESUME WORK, not just report
          const outboxDir = path.join(paths.agentDir(agentId), 'outbox');
          if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });

          const actionPrompt = [
            `[SYSTEM — RESUME WORK]`,
            ``,
            `The autopilot detected you stopped working. Here is the task you need to continue:`,
            ``,
            `═══════════════════════════════════════════`,
            task.task,
            `═══════════════════════════════════════════`,
            ``,
            `INSTRUCTIONS:`,
            `1. RESUME the actual work described above — do NOT just acknowledge or report status`,
            `2. Use your tools (Read, Write, Edit, Bash) to make progress on the task`,
            `3. When the task is FULLY COMPLETE, write a completion report to: ${outboxDir}/`,
            `   Format: { "taskId": "...", "status": "completed", "accomplished": "what you did", "remaining": null, "artifacts": [] }`,
            `4. If genuinely blocked, explain exactly what's blocking you and what you've tried`,
            `5. DO NOT delegate. DO NOT just say "I'll work on it." Actually DO the work NOW.`,
          ].join('\n');

          task.status = 'in-progress';
          task.startedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));

          try {
            await processMessage(chatId, actionPrompt, null, false);
          } catch (e) {
            console.error(`[inbox-watcher] ${effectiveType} processing error:`, e.message?.slice(0, 200));
          }

          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
          fs.renameSync(filePath, path.join(completedDir, file));
          continue;
        }

        // Guard: skip tasks with empty/missing content (phantom tasks)
        if (!task.task || (typeof task.task === 'string' && task.task.trim() === '')) {
          console.log(`[inbox-watcher] Skipping empty task (no content) from ${task.from || 'unknown'} — moving to completed`);
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          task.skippedReason = 'empty-task-content';
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
          fs.renameSync(filePath, path.join(completedDir, file));
          continue;
        }

        // Guard: skip tasks with undefined/malformed ID
        if (task.id === 'undefined' || task.id === undefined || task.id === null) {
          console.log(`[inbox-watcher] Skipping task with undefined/null id from ${task.from || 'unknown'} — moving to completed`);
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          task.skippedReason = 'malformed-task-id';
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
          fs.renameSync(filePath, path.join(completedDir, file));
          continue;
        }

        // Mark in-progress
        task.status = 'in-progress';
        task.startedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        console.log(`[inbox-watcher] Picked up task ${task.id} from ${task.from}: "${task.task?.slice(0, 80)}"`);

        // Notify user
        const taskNotice = `*Task received from ${task.from}*\n\n${task.task?.slice(0, 300)}\n\nStarting work...`;
        try {
          await bot.sendMessage(chatId, taskNotice, { parse_mode: 'Markdown' }).catch(() =>
            bot.sendMessage(chatId, taskNotice)
          );
        } catch (e) {
          console.error(`[inbox-watcher] Failed to send task notice:`, e.message?.slice(0, 100));
        }

        // Ensure outbox dir exists so agent can write reports there
        const outboxDir = path.join(paths.agentDir(agentId), 'outbox');
        if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });

        // Build prompt — includes mandatory outbox reporting and strict stopping rules
        const taskPrompt = [
          `[DELEGATED TASK from team leader "${task.from}"]`,
          `Task ID: ${task.id}`,
          `Priority: ${task.priority || 'P1'}`,
          ``,
          task.task,
          ``,
          `═══════════════════════════════════════════`,
          `STOPPING RULES — READ BEFORE YOU STOP WORKING`,
          `═══════════════════════════════════════════`,
          ``,
          `1. DO NOT STOP until the task goal is ACTUALLY achieved and verified.`,
          `   - "I wrote the code" is NOT done. Running it and verifying the output is done.`,
          `   - "I flashed the firmware" is NOT done. Confirming it works end-to-end is done.`,
          `   - "Tim needs to physically do X" is NOT acceptable — find an automated way using GUI, serial, MQTT, or scripts.`,
          ``,
          `2. When you hit a blocker, exhaust ALL alternatives before reporting it:`,
          `   - Try a different approach`,
          `   - Use GUI automation on Mac Mini if hardware interaction is needed`,
          `   - Use serial/MQTT to simulate input if physical touch is needed`,
          `   - Only report a TRUE blocker if you have literally tried everything`,
          ``,
          `3. MANDATORY REPORT: Write a JSON report to ${outboxDir}/${task.id}-report.json BEFORE stopping:`,
          `{`,
          `  "taskId": "${task.id}",`,
          `  "status": "completed" | "blocked",`,
          `  "accomplished": "bullet list of what was VERIFIED working, not just attempted",`,
          `  "remaining": "what is left, or null if truly done",`,
          `  "blockers": "only real blockers after exhausting all alternatives, or null",`,
          `  "artifacts": ["file paths or URLs produced"]`,
          `}`,
          ``,
          `4. After writing the report, WAIT. Do not declare yourself idle. CTO will review and send next instructions.`,
          `   Do NOT stop working until CTO explicitly confirms the task is complete.`,
          ``,
          `5. YOU CANNOT GO IDLE. After finishing a task:`,
          `   - Write your outbox report`,
          `   - Send a message to the user's chat summarizing what you accomplished`,
          `   - Then IMMEDIATELY look for more work: check your inbox for new tasks, review your previous work for improvements, or audit related code`,
          `   - If genuinely nothing left, send CTO a message asking "What should I work on next?" — do NOT just stop silently`,
          `   - CTO decides when you're done, not you`,
          `═══════════════════════════════════════════`,
        ].join('\n');

        try {
          await processMessage(chatId, taskPrompt, null, false);

          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));

          const completedDir = path.join(inboxDir, 'completed');
          if (!fs.existsSync(completedDir)) fs.mkdirSync(completedDir, { recursive: true });
          fs.renameSync(filePath, path.join(completedDir, file));
          console.log(`[inbox-watcher] Task ${task.id} completed`);

          // Read outbox report if agent wrote one
          const outboxReport = readOutboxReport(agentId, task.id);
          const summary = outboxReport
            ? `Agent filed outbox report — ${outboxReport.status || 'completed'}`
            : 'Task processed (no outbox report filed)';

          sendReportToDelegator(agentId, task, 'COMPLETED', summary, outboxReport);

          // Update task registry — this is what triggers the delivery pipeline
          updateTaskRegistryOnCompletion(agentId, task, outboxReport);

        } catch (err) {
          console.error(`[inbox-watcher] Task ${task.id} error:`, err.message?.slice(0, 200));

          task.retryCount = (task.retryCount || 0) + 1;
          task.lastError = err.message?.slice(0, 500);
          task.lastRetryAt = new Date().toISOString();

          if (task.retryCount >= 3) {
            task.status = 'failed';
            task.failedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
            // Report failure/blockers back to delegator
            sendReportToDelegator(agentId, task, 'FAILED', `Failed after ${task.retryCount} attempts. Error: ${err.message?.slice(0, 300)}`, null);
            try {
              await bot.sendMessage(chatId, `Task failed after 3 attempts: ${task.task?.slice(0, 100)}\n\nError: ${err.message?.slice(0, 200)}`);
            } catch {}
          } else {
            task.status = 'pending';
            fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          }
        }

        break; // one task per cycle
      }
    } catch (err) {
      console.error(`[inbox-watcher] Error:`, err.message?.slice(0, 200));
    }
  }

  const timer = setInterval(checkInbox, pollInterval);
  setTimeout(checkInbox, 5000);

  return {
    stop: () => clearInterval(timer),
    checkNow: checkInbox,
  };
}
