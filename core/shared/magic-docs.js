/**
 * Magic Docs — Auto-Updating Documentation Files
 *
 * Tracks files with `# MAGIC DOC: [title]` headers and auto-updates them
 * after agent sessions based on new information learned during conversations.
 *
 * Updates only trigger when:
 *   - The last assistant turn had no tool calls (natural conversation break)
 *   - The doc hasn't been updated recently (debounce)
 *   - Conversation contains info relevant to the doc's topic
 *
 * Usage:
 *   import { MagicDocs } from '../shared/magic-docs.js';
 *   const docs = new MagicDocs('my-agent');
 *   await docs.updateAll(workingDir, conversationHistory);
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// -- Constants -----------------------------------------------------------------

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/root/.local/bin/claude';
const MAGIC_HEADER_RE = /^#\s+MAGIC\s+DOC:\s+(.+)$/m;
const LOG_PREFIX = '[magic-docs]';
const HAIKU_TIMEOUT_MS = 45000;
const MIN_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes debounce
const MAX_CONVERSATION_CHARS = 12000;          // Truncate context for Haiku
const CHARS_PER_TOKEN = 3.5;

// -- Helpers -------------------------------------------------------------------

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

/**
 * Run a Haiku side-query via the Claude CLI.
 * @param {string} prompt
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>} Response text or null on failure
 */
function queryHaiku(prompt, timeoutMs = HAIKU_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p', prompt,
      '--model', 'haiku',
      '--output-format', 'text',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        logError('Haiku side-query timed out');
        resolve(null);
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0 || !stdout.trim()) {
        logError(`Haiku exited with code ${code}`, stderr.slice(0, 200));
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      logError('Haiku spawn error:', err.message);
      resolve(null);
    });
  });
}

/**
 * Check if the last assistant turn in a conversation had any tool calls.
 * @param {Array} history - Conversation messages array
 * @returns {boolean} True if last assistant turn had tool use
 */
function lastTurnHadToolCalls(history) {
  if (!Array.isArray(history) || history.length === 0) return true;

  // Walk backwards to find last assistant message
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'assistant') {
      // Check for tool_use content blocks
      if (Array.isArray(msg.content)) {
        return msg.content.some(
          (block) => block.type === 'tool_use' || block.type === 'tool_call'
        );
      }
      // Plain text response = no tool calls
      return false;
    }
  }
  return true; // No assistant message found, skip update
}

/**
 * Extract conversation text for context, truncated to fit Haiku limits.
 * Prioritizes recent messages.
 * @param {Array} history
 * @param {number} maxChars
 * @returns {string}
 */
function extractConversationContext(history, maxChars = MAX_CONVERSATION_CHARS) {
  if (!Array.isArray(history) || history.length === 0) return '';

  const parts = [];
  let totalChars = 0;

  // Walk backwards to get most recent context first
  for (let i = history.length - 1; i >= 0 && totalChars < maxChars; i--) {
    const msg = history[i];
    const role = msg.role || 'unknown';

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }

    if (!text) continue;

    const truncated = text.slice(0, maxChars - totalChars);
    parts.unshift(`[${role}]: ${truncated}`);
    totalChars += truncated.length;
  }

  return parts.join('\n\n');
}

// -- MagicDocs Class -----------------------------------------------------------

export class MagicDocs {
  /**
   * @param {string} agentId - The agent that owns these docs
   */
  constructor(agentId) {
    this.agentId = agentId;
    /** @type {Map<string, {title: string, mtime: number, lastUpdate: number}>} */
    this.tracked = new Map();
    /** @type {Set<string>} Files read during this session */
    this.filesRead = new Set();
  }

  /**
   * Scan a directory tree for MAGIC DOC files.
   * Looks for markdown files with the `# MAGIC DOC: [title]` header.
   *
   * @param {string} workingDir - Root directory to scan
   * @returns {Promise<Array<{filePath: string, title: string}>>} Found magic docs
   */
  async scan(workingDir) {
    const results = [];

    const scanDir = (dir, depth = 0) => {
      if (depth > 4) return; // Max depth to avoid runaway recursion

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden dirs, node_modules, dist, build
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') ||
              entry.name === 'node_modules' ||
              entry.name === 'dist' ||
              entry.name === 'build' ||
              entry.name === '__pycache__') {
            continue;
          }
          scanDir(fullPath, depth + 1);
          continue;
        }

        // Only check .md files
        if (!entry.name.endsWith('.md')) continue;

        try {
          // Read just the first 200 bytes to check for header
          const fd = fs.openSync(fullPath, 'r');
          const buf = Buffer.alloc(200);
          const bytesRead = fs.readSync(fd, buf, 0, 200, 0);
          fs.closeSync(fd);

          const head = buf.toString('utf-8', 0, bytesRead);
          const match = head.match(MAGIC_HEADER_RE);

          if (match) {
            const title = match[1].trim();
            const stat = fs.statSync(fullPath);

            this.tracked.set(fullPath, {
              title,
              mtime: stat.mtimeMs,
              lastUpdate: this.tracked.get(fullPath)?.lastUpdate || 0,
            });

            results.push({ filePath: fullPath, title });
          }
        } catch {
          // Skip unreadable files
        }
      }
    };

    scanDir(workingDir);
    log(`Scanned ${workingDir}: found ${results.length} magic doc(s)`);
    return results;
  }

  /**
   * Check if a specific magic doc needs updating based on conversation content.
   *
   * @param {string} filePath - Path to the magic doc
   * @param {Array} conversationHistory - Recent conversation messages
   * @returns {Promise<boolean>} True if the doc should be updated
   */
  async shouldUpdate(filePath, conversationHistory) {
    const entry = this.tracked.get(filePath);
    if (!entry) return false;

    // Debounce: don't update if recently updated
    const now = Date.now();
    if (now - entry.lastUpdate < MIN_UPDATE_INTERVAL_MS) {
      log(`Skipping ${entry.title}: updated ${Math.round((now - entry.lastUpdate) / 1000)}s ago`);
      return false;
    }

    // Skip if last assistant turn had tool calls (not a natural break)
    if (lastTurnHadToolCalls(conversationHistory)) {
      return false;
    }

    // Check if conversation has enough substance to warrant update
    const context = extractConversationContext(conversationHistory, 3000);
    if (estimateTokens(context) < 50) {
      return false;
    }

    // Ask Haiku if the conversation contains info relevant to this doc
    let currentContent;
    try {
      currentContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return false;
    }

    const prompt = `You are checking if a documentation file needs updating based on a recent conversation.

Document title: "${entry.title}"
Document preview (first 500 chars):
${currentContent.slice(0, 500)}

Recent conversation excerpt:
${context.slice(0, 2000)}

Does this conversation contain NEW information that should be added to or updated in this document? Answer with exactly "YES" or "NO" and nothing else.`;

    const answer = await queryHaiku(prompt);
    if (!answer) return false;

    return answer.trim().toUpperCase().startsWith('YES');
  }

  /**
   * Update a magic doc file with new information from the conversation.
   *
   * @param {string} filePath - Path to the magic doc
   * @param {Array} conversationHistory - Recent conversation messages
   * @returns {Promise<boolean>} True if update was successful
   */
  async update(filePath, conversationHistory) {
    const entry = this.tracked.get(filePath);
    if (!entry) {
      logError(`Cannot update untracked file: ${filePath}`);
      return false;
    }

    let currentContent;
    try {
      currentContent = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logError(`Cannot read ${filePath}:`, err.message);
      return false;
    }

    const context = extractConversationContext(conversationHistory);

    const prompt = `You are updating a "Magic Doc" — an auto-maintained documentation file.

RULES:
- Preserve the "# MAGIC DOC: ${entry.title}" header line exactly as-is
- Preserve the overall structure and sections of the document
- Add new information learned from the conversation
- Update any outdated information
- Remove duplicates
- Keep the document concise and well-organized
- Do NOT add commentary like "Updated on..." — just update the content
- Output the COMPLETE updated document (not a diff)

CURRENT DOCUMENT:
${currentContent}

RECENT CONVERSATION CONTEXT:
${context}

Output the complete updated document:`;

    const updated = await queryHaiku(prompt, 60000);
    if (!updated) {
      logError(`Haiku returned empty update for ${entry.title}`);
      return false;
    }

    // Sanity check: must still contain the magic header
    if (!MAGIC_HEADER_RE.test(updated)) {
      logError(`Update for ${entry.title} lost magic header — discarding`);
      return false;
    }

    // Sanity check: don't accept dramatically shorter docs (likely truncated)
    if (updated.length < currentContent.length * 0.5 && currentContent.length > 200) {
      logError(`Update for ${entry.title} too short (${updated.length} vs ${currentContent.length}) — discarding`);
      return false;
    }

    // Atomic write: tmp file + rename
    try {
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, updated);
      fs.renameSync(tmpPath, filePath);

      entry.lastUpdate = Date.now();
      entry.mtime = fs.statSync(filePath).mtimeMs;
      log(`Updated: ${entry.title} (${filePath})`);
      return true;
    } catch (err) {
      logError(`Failed to write ${filePath}:`, err.message);
      return false;
    }
  }

  /**
   * Scan for all magic docs and update any that need it.
   *
   * @param {string} workingDir - Root directory to scan
   * @param {Array} conversationHistory - Recent conversation messages
   * @returns {Promise<{scanned: number, updated: string[]}>}
   */
  async updateAll(workingDir, conversationHistory) {
    const docs = await this.scan(workingDir);
    const updated = [];

    for (const { filePath, title } of docs) {
      try {
        const needs = await this.shouldUpdate(filePath, conversationHistory);
        if (needs) {
          const success = await this.update(filePath, conversationHistory);
          if (success) updated.push(title);
        }
      } catch (err) {
        logError(`Error processing ${title}:`, err.message);
      }
    }

    if (updated.length > 0) {
      log(`Session complete: updated ${updated.length} doc(s): ${updated.join(', ')}`);
    }

    return { scanned: docs.length, updated };
  }

  /**
   * Register that a file was read during this session.
   * Used to track which docs' topics came up in conversation.
   *
   * @param {string} filePath - The file that was read
   */
  registerFileReadListener(filePath) {
    this.filesRead.add(filePath);

    // If this is a tracked magic doc, note the read
    const entry = this.tracked.get(filePath);
    if (entry) {
      log(`Magic doc read: ${entry.title}`);
    }
  }
}

/**
 * Fork a background update check after an agent session ends.
 * Spawns a detached process that scans and updates magic docs
 * without blocking the main agent.
 *
 * @param {string} agentId
 * @param {string} workingDir
 * @param {Array} conversationHistory
 */
export async function forkBackgroundUpdate(agentId, workingDir, conversationHistory) {
  // Skip if last turn had tool calls (not a natural break)
  if (lastTurnHadToolCalls(conversationHistory)) {
    return;
  }

  const context = extractConversationContext(conversationHistory, 6000);
  if (estimateTokens(context) < 50) {
    return;
  }

  // Write conversation context to a temp file for the background process
  const tmpDir = path.join('/tmp', 'magic-docs');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch { /* exists */ }

  const contextFile = path.join(tmpDir, `${agentId}-${Date.now()}.json`);

  try {
    fs.writeFileSync(contextFile, JSON.stringify({
      agentId,
      workingDir,
      context,
      timestamp: Date.now(),
    }));
  } catch (err) {
    logError('Failed to write context file:', err.message);
    return;
  }

  // Spawn detached background worker
  const workerScript = `
    import fs from 'fs';
    import { MagicDocs } from '${path.resolve(path.dirname(new URL(import.meta.url).pathname), 'magic-docs.js')}';

    const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
    const docs = new MagicDocs(data.agentId);

    // Build a minimal conversation history from the context string
    const history = [{ role: 'assistant', content: data.context }];

    try {
      await docs.updateAll(data.workingDir, history);
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(process.argv[2]); } catch {}
    }
  `;

  const workerFile = path.join(tmpDir, `worker-${agentId}-${Date.now()}.mjs`);

  try {
    fs.writeFileSync(workerFile, workerScript);

    const child = spawn('node', [workerFile, contextFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    log(`Forked background update for ${agentId} (pid ${child.pid})`);
  } catch (err) {
    logError('Failed to fork background worker:', err.message);
    // Clean up
    try { fs.unlinkSync(workerFile); } catch {}
    try { fs.unlinkSync(contextFile); } catch {}
  }
}

export default MagicDocs;
