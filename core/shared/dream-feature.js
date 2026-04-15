/**
 * Dream Feature v1.0 — Capture ideas now, plan & execute later
 *
 * /dream of <description>   — Capture a new dream/idea/vision
 * /dream list               — Show all captured dreams
 * /dream view <id>          — View a specific dream with details
 * /dream plan <id>          — Convert a dream into an executable plan
 * /dream execute <id>       — Execute a dream's plan via Claude
 * /dream delete <id>        — Remove a dream
 *
 * Dreams are stored per-agent in agents/<agentId>/dreams/ as JSON files.
 * When "plan" is invoked, the dream is expanded into a full plan using
 * the plan-manager system. When "execute" is invoked, the plan is sent
 * to Claude as a task.
 */

import { readFile, writeFile, readdir, mkdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { createPlan, listPlans, readPlan, updatePlanStatus } from './plan-manager.js';
import paths from './paths.js';

const AGENTS_DIR = paths.agents;
const DREAMS_DIR_NAME = 'dreams';

// -- Dream Storage -------------------------------------------------------------

function getDreamsDir(agentId) {
  return join(AGENTS_DIR, agentId, DREAMS_DIR_NAME);
}

async function ensureDreamsDir(agentId) {
  const dir = getDreamsDir(agentId);
  await mkdir(dir, { recursive: true });
  return dir;
}

function generateDreamId() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `dream-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

// -- CRUD Operations -----------------------------------------------------------

/**
 * Save a new dream
 * @param {string} agentId
 * @param {string} description - The dream vision/idea
 * @param {string} [author] - Who dreamed it (username)
 * @returns {object} The saved dream object
 */
export async function saveDream(agentId, description, author = 'user') {
  const dir = await ensureDreamsDir(agentId);
  const id = generateDreamId();
  const dream = {
    id,
    description: description.trim(),
    author,
    status: 'captured',  // captured -> planned -> executing -> done | abandoned
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planPath: null,       // set when /dream plan is called
    tags: extractTags(description),
    notes: [],
  };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(dream, null, 2), 'utf-8');
  return dream;
}

/**
 * List all dreams for an agent
 */
export async function listDreams(agentId) {
  const dir = getDreamsDir(agentId);
  try {
    const files = await readdir(dir);
    const dreams = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await readFile(join(dir, f), 'utf-8');
        dreams.push(JSON.parse(content));
      } catch (e) {
        console.error(`[dream] Failed to read ${f}:`, e.message);
      }
    }
    // Sort by creation date, newest first
    dreams.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return dreams;
  } catch {
    return [];
  }
}

/**
 * Get a specific dream by ID or index (1-based)
 */
export async function getDream(agentId, idOrIndex) {
  const dreams = await listDreams(agentId);
  // Try as numeric index first (1-based)
  const idx = parseInt(idOrIndex);
  if (!isNaN(idx) && idx >= 1 && idx <= dreams.length) {
    return dreams[idx - 1];
  }
  // Try as ID match (partial or full)
  return dreams.find(d => d.id === idOrIndex || d.id.includes(idOrIndex));
}

/**
 * Update a dream
 */
export async function updateDream(agentId, dreamId, updates) {
  const dir = getDreamsDir(agentId);
  const filepath = join(dir, `${dreamId}.json`);
  if (!existsSync(filepath)) return null;
  const dream = JSON.parse(await readFile(filepath, 'utf-8'));
  Object.assign(dream, updates, { updatedAt: new Date().toISOString() });
  await writeFile(filepath, JSON.stringify(dream, null, 2), 'utf-8');
  return dream;
}

/**
 * Delete a dream
 */
export async function deleteDream(agentId, dreamId) {
  const dir = getDreamsDir(agentId);
  const filepath = join(dir, `${dreamId}.json`);
  if (!existsSync(filepath)) return false;
  await unlink(filepath);
  return true;
}

// -- Dream -> Plan Conversion --------------------------------------------------

/**
 * Convert a dream into a structured plan.
 * Returns a prompt string that Claude should process to generate the full plan.
 */
export function dreamToPlanPrompt(dream) {
  return `You are converting a dream/vision into a concrete, executable plan.

## The Dream
"${dream.description}"

## Your Task
Analyze this dream and create a detailed implementation plan. Think through:

1. **What exactly needs to be built/done?** Break the dream into concrete deliverables.
2. **What are the steps?** Number them in execution order. Each step should be specific enough to act on.
3. **What files/systems are involved?** List specific paths, services, APIs.
4. **What are the risks?** What could go wrong, and how to mitigate.
5. **How do we verify success?** Define clear "done" criteria.

Output the plan as a structured response with:
- Clear title
- Context paragraph
- Numbered implementation steps (each with files, commands, verification)
- Risks & mitigations
- Test/verification plan

Be specific and actionable — this plan will be executed directly.`;
}

/**
 * Mark a dream as "planned" and link it to a plan file
 */
export async function linkDreamToPlan(agentId, dreamId, planPath) {
  return updateDream(agentId, dreamId, {
    status: 'planned',
    planPath,
  });
}

/**
 * Mark a dream as executing
 */
export async function markDreamExecuting(agentId, dreamId) {
  return updateDream(agentId, dreamId, { status: 'executing' });
}

/**
 * Mark a dream as done
 */
export async function markDreamDone(agentId, dreamId, notes = '') {
  const updates = { status: 'done' };
  if (notes) {
    const dream = await getDream(agentId, dreamId);
    updates.notes = [...(dream?.notes || []), { at: new Date().toISOString(), text: notes }];
  }
  return updateDream(agentId, dreamId, updates);
}

// -- Formatting ----------------------------------------------------------------

const STATUS_EMOJI = {
  captured: '💭',
  planned: '📋',
  executing: '⚡',
  done: '✅',
  abandoned: '❌',
};

/**
 * Format a dream for Telegram display
 */
export function formatDream(dream, index) {
  const emoji = STATUS_EMOJI[dream.status] || '💭';
  const age = getRelativeTime(dream.createdAt);
  const tags = dream.tags.length ? ` [${dream.tags.join(', ')}]` : '';
  const planNote = dream.planPath ? '\n   Plan: linked' : '';
  const preview = dream.description.length > 120
    ? dream.description.slice(0, 120) + '...'
    : dream.description;
  return `${emoji} #${index} — ${preview}${tags}\n   Status: ${dream.status} | ${age}${planNote}`;
}

/**
 * Format dream list for Telegram
 */
export function formatDreamList(dreams) {
  if (dreams.length === 0) return 'No dreams captured yet. Use /dream of <your idea> to start dreaming.';
  const header = `Dreams (${dreams.length})\n`;
  const items = dreams.map((d, i) => formatDream(d, i + 1)).join('\n\n');
  return header + '\n' + items;
}

/**
 * Format detailed dream view
 */
export function formatDreamDetail(dream) {
  const emoji = STATUS_EMOJI[dream.status] || '💭';
  const age = getRelativeTime(dream.createdAt);
  let text = `${emoji} Dream\n\n"${dream.description}"\n\n`;
  text += `Status: ${dream.status}\n`;
  text += `Created: ${age}\n`;
  if (dream.tags.length) text += `Tags: ${dream.tags.join(', ')}\n`;
  if (dream.planPath) text += `Plan: linked\n`;
  if (dream.notes && dream.notes.length) {
    text += '\nNotes:\n';
    dream.notes.forEach(n => { text += `  - ${n.text}\n`; });
  }
  return text;
}

// -- Helpers -------------------------------------------------------------------

function extractTags(text) {
  const tags = [];
  // Extract #hashtags
  const hashtags = text.match(/#\w+/g);
  if (hashtags) tags.push(...hashtags.map(t => t.slice(1)));
  // Detect common domains
  const domains = [
    ['ui', /\b(ui|ux|design|interface|screen|page|layout)\b/i],
    ['api', /\b(api|endpoint|backend|server|route)\b/i],
    ['data', /\b(data|database|db|schema|migration)\b/i],
    ['infra', /\b(deploy|infra|ci|cd|docker|server|kubernetes)\b/i],
    ['mobile', /\b(mobile|flutter|ios|android|app)\b/i],
    ['web', /\b(web|website|next|react|frontend)\b/i],
    ['ai', /\b(ai|ml|model|training|inference|llm)\b/i],
    ['automation', /\b(automat|cron|schedule|pipeline|workflow)\b/i],
  ];
  for (const [tag, regex] of domains) {
    if (regex.test(text)) tags.push(tag);
  }
  return [...new Set(tags)];
}

function getRelativeTime(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// -- Command Handler (for bot-template integration) ----------------------------

/**
 * Create the /dream command handler for use in bot-template customCommands
 * @param {string} agentId - The agent's ID
 * @returns {function} Command handler: async (msg, bot, ctx) => {}
 */
export function createDreamCommand(agentId) {
  return async (msg, bot, ctx) => {
    const text = (msg.text || '').trim();
    const args = text.replace(/^\/dream\s*/i, '').trim();

    // /dream (no args) or /dream help
    if (!args || args === 'help') {
      const help = `Dream — Capture ideas, plan later, execute when ready

/dream of <your idea>  — Capture a new dream
/dream list            — View all dreams
/dream view <#>        — View dream details
/dream plan <#>        — Convert dream -> executable plan
/dream execute <#>     — Execute via Claude
/dream done <#>        — Mark as completed
/dream delete <#>      — Remove a dream

Example: /dream of a voice-controlled dashboard that shows real-time trading data`;
      bot.sendMessage(ctx.chatId, help);
      return;
    }

    // Known subcommand names (for bare-subcommand detection)
    const SUBCOMMANDS = ['of', 'list', 'ls', 'view', 'plan', 'execute', 'exec', 'do', 'done', 'delete', 'rm', 'help'];
    const firstWord = args.split(/\s+/)[0].toLowerCase();

    // /dream of <description>
    if (args.startsWith('of ') || firstWord === 'of') {
      const description = args.slice(args.indexOf(' ') + 1).trim();
      if (!description || firstWord === args.trim()) {
        bot.sendMessage(ctx.chatId, 'Dream of what? Usage: /dream of <your idea>');
        return;
      }
      const dream = await saveDream(agentId, description, ctx.username || 'user');
      const dreams = await listDreams(agentId);
      const idx = dreams.findIndex(d => d.id === dream.id) + 1;
      const tagLine = dream.tags.length ? `\nTags: ${dream.tags.join(', ')}` : '';
      bot.sendMessage(ctx.chatId,
        `Dream #${idx} captured${tagLine}\n\n"${dream.description}"\n\n/dream plan ${idx} — turn it into a plan\n/dream execute ${idx} — build it now\n/dream list — see all dreams`
      );
      return;
    }

    // /dream list
    if (args === 'list' || args === 'ls') {
      const dreams = await listDreams(agentId);
      bot.sendMessage(ctx.chatId, formatDreamList(dreams));
      return;
    }

    // /dream view <id>
    if (firstWord === 'view') {
      const target = args.slice(5).trim();
      if (!target) {
        bot.sendMessage(ctx.chatId, 'Which dream? Usage: /dream view <number>');
        return;
      }
      const dream = await getDream(agentId, target);
      if (!dream) {
        bot.sendMessage(ctx.chatId, `Dream not found: ${target}`);
        return;
      }
      bot.sendMessage(ctx.chatId, formatDreamDetail(dream));
      return;
    }

    // /dream plan <id> — convert to plan prompt, send to Claude
    if (firstWord === 'plan') {
      const target = args.slice(5).trim();
      if (!target) {
        bot.sendMessage(ctx.chatId, 'Which dream? Usage: /dream plan <number>\nUse /dream list to see your dreams.');
        return;
      }
      const dream = await getDream(agentId, target);
      if (!dream) {
        bot.sendMessage(ctx.chatId, `Dream not found: ${target}`);
        return;
      }
      // Send the dream-to-plan prompt to Claude for processing
      const planPrompt = String(dreamToPlanPrompt(dream));
      await updateDream(agentId, dream.id, { status: 'planned' });
      // Process via Claude — use callClaude directly if available (avoids garbled-input
      // filter issues), otherwise fall back to processMessage, then plain message.
      if (typeof ctx.callClaude === 'function') {
        try {
          await bot.sendMessage(ctx.chatId, `Converting dream to plan...\n"${dream.description.slice(0, 100)}"`);
          const result = await ctx.callClaude(planPrompt, ctx.chatId, ctx.userId, null);
          // callClaude delivers streamed responses itself; only send if not streamed
          const wasStreamed = typeof result === 'object' && result.streamed;
          if (!wasStreamed) {
            const responseText = typeof result === 'object' ? (result.text || '') : (typeof result === 'string' ? result : '');
            if (responseText && typeof ctx.sendLongMessage === 'function') {
              ctx.sendLongMessage(ctx.chatId, responseText);
            } else if (responseText) {
              bot.sendMessage(ctx.chatId, responseText);
            }
          }
        } catch (e) {
          bot.sendMessage(ctx.chatId, `Plan generation failed: ${e.message}`);
        }
      } else if (typeof ctx.processMessage === 'function') {
        try {
          await bot.sendMessage(ctx.chatId, `Converting dream to plan...\n"${dream.description.slice(0, 100)}"`);
          await ctx.processMessage(ctx.chatId, planPrompt, null, ctx.userId);
        } catch (e) {
          bot.sendMessage(ctx.chatId, `Plan generation failed: ${e.message}`);
        }
      } else {
        bot.sendMessage(ctx.chatId, `Dream #${target} marked as planned: "${dream.description.slice(0, 100)}"\n\nTo execute it, tell me what to do and reference this dream.`);
      }
      return;
    }

    // /dream execute <id> — execute the dream directly
    if (firstWord === 'execute' || firstWord === 'exec' || firstWord === 'do') {
      const target = args.replace(/^(execute|exec|do)\s*/, '').trim();
      if (!target) {
        bot.sendMessage(ctx.chatId, 'Which dream? Usage: /dream execute <number>\nUse /dream list to see your dreams.');
        return;
      }
      const dream = await getDream(agentId, target);
      if (!dream) {
        bot.sendMessage(ctx.chatId, `Dream not found: ${target}`);
        return;
      }
      await updateDream(agentId, dream.id, { status: 'executing' });

      const execPrompt = `Execute this dream/vision NOW. Do the actual implementation work — create files, write code, configure systems, whatever it takes.

## The Dream
"${dream.description}"

## Instructions
- Break this into concrete steps and execute each one
- Create any necessary files, configs, or code
- Test/verify your work as you go
- Report what you built and how to use it when done
- If anything is ambiguous, make a reasonable choice and note it

Go.`;

      // Process via Claude — use callClaude directly if available (avoids garbled-input
      // filter issues), otherwise fall back to processMessage, then plain message.
      const execPromptStr = String(execPrompt);
      if (typeof ctx.callClaude === 'function') {
        try {
          await bot.sendMessage(ctx.chatId, `Executing dream: "${dream.description.slice(0, 80)}..."`);
          const result = await ctx.callClaude(execPromptStr, ctx.chatId, ctx.userId, null);
          // callClaude delivers streamed responses itself; only send if not streamed
          const wasStreamed = typeof result === 'object' && result.streamed;
          if (!wasStreamed) {
            const responseText = typeof result === 'object' ? (result.text || '') : (typeof result === 'string' ? result : '');
            if (responseText && typeof ctx.sendLongMessage === 'function') {
              ctx.sendLongMessage(ctx.chatId, responseText);
            } else if (responseText) {
              bot.sendMessage(ctx.chatId, responseText);
            }
          }
          await updateDream(agentId, dream.id, { status: 'done' });
        } catch (e) {
          bot.sendMessage(ctx.chatId, `Execution failed: ${e.message}`);
        }
      } else if (typeof ctx.processMessage === 'function') {
        try {
          await bot.sendMessage(ctx.chatId, `Executing dream: "${dream.description.slice(0, 80)}..."`);
          await ctx.processMessage(ctx.chatId, execPromptStr, null, ctx.userId);
          await updateDream(agentId, dream.id, { status: 'done' });
        } catch (e) {
          bot.sendMessage(ctx.chatId, `Execution failed: ${e.message}`);
        }
      } else {
        bot.sendMessage(ctx.chatId, `Dream #${target} marked as executing: "${dream.description.slice(0, 100)}"\n\nTell me to start working on it and I'll execute.`);
      }
      return;
    }

    // /dream done <id>
    if (firstWord === 'done') {
      const target = args.slice(5).trim();
      if (!target) {
        bot.sendMessage(ctx.chatId, 'Which dream? Usage: /dream done <number>');
        return;
      }
      const dream = await getDream(agentId, target);
      if (!dream) {
        bot.sendMessage(ctx.chatId, `Dream not found: ${target}`);
        return;
      }
      await markDreamDone(agentId, dream.id, 'Marked done by user');
      bot.sendMessage(ctx.chatId, `Dream marked as done: "${dream.description.slice(0, 80)}..."`);
      return;
    }

    // /dream delete <id>
    if (firstWord === 'delete' || firstWord === 'rm') {
      const target = args.replace(/^(delete|rm)\s*/, '').trim();
      if (!target) {
        bot.sendMessage(ctx.chatId, 'Which dream? Usage: /dream delete <number>');
        return;
      }
      const dream = await getDream(agentId, target);
      if (!dream) {
        bot.sendMessage(ctx.chatId, `Dream not found: ${target}`);
        return;
      }
      await deleteDream(agentId, dream.id);
      bot.sendMessage(ctx.chatId, `Dream deleted: "${dream.description.slice(0, 80)}..."`);
      return;
    }

    // If first word looks like a subcommand but wasn't handled, show help
    if (SUBCOMMANDS.includes(firstWord)) {
      bot.sendMessage(ctx.chatId, `Unknown usage. Try /dream help`);
      return;
    }

    // Otherwise treat as a dream capture (shorthand: /dream build a dashboard)
    const dream = await saveDream(agentId, args, ctx.username || 'user');
    const dreams = await listDreams(agentId);
    const idx = dreams.findIndex(d => d.id === dream.id) + 1;
    const tagLine = dream.tags.length ? `\nTags: ${dream.tags.join(', ')}` : '';
    bot.sendMessage(ctx.chatId,
      `Dream #${idx} captured${tagLine}\n\n"${dream.description}"\n\n/dream plan ${idx} — turn it into a plan\n/dream execute ${idx} — build it now\n/dream list — see all dreams`
    );
  };
}

export default {
  saveDream,
  listDreams,
  getDream,
  updateDream,
  deleteDream,
  dreamToPlanPrompt,
  linkDreamToPlan,
  markDreamExecuting,
  markDreamDone,
  formatDream,
  formatDreamList,
  formatDreamDetail,
  createDreamCommand,
};
