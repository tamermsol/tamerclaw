/**
 * smart-memory.js — Intelligent Memory Recall & Extraction for TamerClaw Agents
 *
 * Adapted from Claude Code's findRelevantMemories / extractMemories patterns.
 *
 * Recall: Scans agent memory files, reads YAML frontmatter, uses Haiku side-query
 *   to select up to 5 most relevant memories for the current user message.
 *
 * Extract: After each complete agent response, uses Haiku to identify key facts,
 *   decisions, preferences, and writes them to auto/ memory with deduplication.
 *
 * Usage:
 *   import { findRelevantMemories, extractMemories } from '../shared/smart-memory.js';
 *   const { files, tokensUsed } = await findRelevantMemories('flutter', userMsg);
 *   const { extracted, skipped } = await extractMemories('flutter', history);
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AGENTS_BASE = path.join(BASE_DIR, 'agents');
const MAX_RELEVANT = 5;
const MAX_FRONTMATTER_SCAN = 50; // max memory files to scan for frontmatter
const HAIKU_TIMEOUT_MS = 30_000;

// ── Haiku Side-Query ────────────────────────────────────────────────────────

/**
 * Run a prompt through Claude Haiku and return the parsed JSON response.
 * @param {string} prompt
 * @param {number} [timeout]
 * @returns {Promise<object|string>}
 */
async function haikuQuery(prompt, timeout = HAIKU_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', 'haiku', '--output-format', 'json', '--max-turns', '1'];
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: BASE_DIR,
      env: { ...cleanEnv(), HOME: process.env.HOME || '/root' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Haiku query timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`Haiku exited ${code}: ${stderr.slice(0, 200)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        // claude --output-format json returns { result: "..." }
        const text = parsed.result || parsed.content || stdout;
        // Try to parse the inner text as JSON
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      } catch {
        // Raw text output
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete env[key];
  }
  return env;
}

// ── YAML Frontmatter Parsing ────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file's content.
 * Returns { frontmatter: {}, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fmBlock = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of fmBlock.split('\n')) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (kvMatch) {
      let val = kvMatch[2].trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Parse arrays like ["a", "b"]
      if (val.startsWith('[') && val.endsWith(']')) {
        try { val = JSON.parse(val); } catch { /* keep as string */ }
      }
      frontmatter[kvMatch[1]] = val;
    }
  }

  return { frontmatter, body };
}

// ── Memory Directory Scanner ────────────────────────────────────────────────

/**
 * Scan an agent's memory directory and return file metadata.
 * Reads frontmatter from .md files in memory/ and memory/auto/.
 */
async function scanMemoryFiles(agentId) {
  const memDir = path.join(AGENTS_BASE, agentId, 'memory');
  const results = [];

  const scanDir = async (dir, prefix = '') => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await scanDir(path.join(dir, entry.name), path.join(prefix, entry.name));
        continue;
      }

      if (!entry.name.endsWith('.md')) continue;
      if (results.length >= MAX_FRONTMATTER_SCAN) break;

      const filePath = path.join(dir, entry.name);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);
        const stat = await fs.stat(filePath);

        results.push({
          path: filePath,
          relativePath: path.join(prefix, entry.name),
          name: frontmatter.name || entry.name.replace('.md', ''),
          description: frontmatter.description || '',
          type: frontmatter.type || 'unknown',
          tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
          lastUpdated: frontmatter.last_updated || stat.mtime.toISOString().slice(0, 10),
          sizeChars: content.length,
          content,
        });
      } catch (err) {
        console.error(`[smart-memory] Failed to read ${filePath}:`, err.message);
      }
    }
  };

  await scanDir(memDir);

  // Also scan MEMORY.md index at agent root
  const indexPath = path.join(AGENTS_BASE, agentId, 'MEMORY.md');
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    results.push({
      path: indexPath,
      relativePath: 'MEMORY.md',
      name: 'Memory Index',
      description: 'Index of all topic memories',
      type: 'index',
      tags: [],
      lastUpdated: (await fs.stat(indexPath)).mtime.toISOString().slice(0, 10),
      sizeChars: content.length,
      content,
    });
  } catch { /* no index file */ }

  return results;
}

// ── findRelevantMemories ────────────────────────────────────────────────────

/**
 * Find memories relevant to the current user message.
 *
 * Phase 1: Scan agent's memory directory, read YAML frontmatter headers.
 * Phase 2: Use Haiku side-query to select up to 5 relevant memories.
 *
 * @param {string} agentId - Agent identifier (directory name under agents/)
 * @param {string} userMessage - The current user message to find relevant context for
 * @param {Set<string>} [alreadySurfaced] - Paths already injected in this session
 * @returns {Promise<{files: Array<{path, content, relevanceReason}>, tokensUsed: number}>}
 */
export async function findRelevantMemories(agentId, userMessage, alreadySurfaced = new Set()) {
  const startTime = Date.now();

  try {
    // Phase 1: Scan memory files
    const allFiles = await scanMemoryFiles(agentId);

    if (allFiles.length === 0) {
      return { files: [], tokensUsed: 0 };
    }

    // Filter out already-surfaced files
    const candidates = allFiles.filter(f => !alreadySurfaced.has(f.path));

    if (candidates.length === 0) {
      return { files: [], tokensUsed: 0 };
    }

    // Build compact catalog for Haiku
    const catalog = candidates.map((f, i) => ({
      id: i,
      name: f.name,
      description: f.description,
      type: f.type,
      tags: f.tags,
      lastUpdated: f.lastUpdated,
      sizeChars: f.sizeChars,
      relativePath: f.relativePath,
    }));

    const catalogJson = JSON.stringify(catalog, null, 1);
    const tokensEst = Math.ceil((catalogJson.length + userMessage.length) / 4);

    // Phase 2: Haiku selects relevant memories
    const selectionPrompt = `You are a memory retrieval system. Given a user message and a catalog of memory files, select the most relevant files (up to ${MAX_RELEVANT}).

USER MESSAGE:
${userMessage}

MEMORY CATALOG:
${catalogJson}

Respond with ONLY a JSON array of objects, each with:
- "id": the file id from the catalog
- "reason": brief explanation of why this memory is relevant (1 sentence)

Select files that would provide useful context for responding to the user message. If no files are relevant, return an empty array [].

IMPORTANT: Return ONLY valid JSON, no markdown fencing, no explanation.`;

    let selections = [];
    try {
      const result = await haikuQuery(selectionPrompt);
      if (Array.isArray(result)) {
        selections = result;
      } else if (typeof result === 'string') {
        // Try to extract JSON array from response
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          selections = JSON.parse(jsonMatch[0]);
        }
      }
    } catch (err) {
      console.error(`[smart-memory] Haiku selection failed for ${agentId}:`, err.message);
      // Fallback: return most recently updated files
      const sorted = candidates.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
      return {
        files: sorted.slice(0, 3).map(f => ({
          path: f.path,
          content: f.content,
          relevanceReason: 'Fallback: most recently updated memory',
        })),
        tokensUsed: 0,
      };
    }

    // Map selections back to full file data
    const selectedFiles = [];
    for (const sel of selections.slice(0, MAX_RELEVANT)) {
      const idx = typeof sel.id === 'number' ? sel.id : parseInt(sel.id, 10);
      if (isNaN(idx) || idx < 0 || idx >= candidates.length) continue;

      const file = candidates[idx];
      selectedFiles.push({
        path: file.path,
        content: file.content,
        relevanceReason: sel.reason || 'Selected by relevance model',
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[smart-memory] findRelevantMemories(${agentId}): ${selectedFiles.length} files selected in ${duration}ms`);

    return {
      files: selectedFiles,
      tokensUsed: tokensEst,
    };
  } catch (err) {
    console.error(`[smart-memory] findRelevantMemories failed for ${agentId}:`, err.message);
    return { files: [], tokensUsed: 0 };
  }
}

// ── extractMemories ─────────────────────────────────────────────────────────

/**
 * Extract key facts from a conversation and write them to auto-memory files.
 *
 * Called after each complete agent response (no tool calls pending).
 * Uses Haiku to identify: decisions made, preferences learned, facts discovered,
 * files mentioned. Writes to agents/{agentId}/memory/auto/ with YAML frontmatter.
 * Deduplicates against existing auto-memories before writing.
 *
 * @param {string} agentId
 * @param {Array<{role: string, content: string}>} conversationHistory
 * @returns {Promise<{extracted: Array<{type, content, file}>, skipped: number}>}
 */
export async function extractMemories(agentId, conversationHistory) {
  const startTime = Date.now();
  const autoDir = path.join(AGENTS_BASE, agentId, 'memory', 'auto');

  try {
    // Ensure auto directory exists
    await fs.mkdir(autoDir, { recursive: true });

    // Load existing auto-memories for deduplication
    const existingMemories = await loadExistingAutoMemories(autoDir);

    // Build conversation summary for Haiku (last N messages, trimmed)
    const recentHistory = conversationHistory.slice(-20);
    const historyText = recentHistory
      .map(m => `[${m.role}]: ${(m.content || '').slice(0, 500)}`)
      .join('\n\n');

    if (historyText.length < 50) {
      return { extracted: [], skipped: 0 };
    }

    const existingSummary = existingMemories.length > 0
      ? `\nEXISTING MEMORIES (do NOT duplicate these):\n${existingMemories.map(m => `- [${m.type}] ${m.name}: ${m.description}`).join('\n')}`
      : '';

    const extractionPrompt = `You are a memory extraction system. Analyze this conversation and extract key facts worth remembering for future sessions.

CONVERSATION:
${historyText}
${existingSummary}

Extract facts in these categories:
- "decision": Architectural or strategic decisions made
- "preference": User preferences or working style learned
- "fact": Important facts discovered (file paths, endpoints, credentials patterns, etc.)
- "context": Project context that would help in future conversations

Respond with ONLY a JSON array of objects, each with:
- "type": one of "decision", "preference", "fact", "context"
- "title": short title (3-8 words)
- "content": the fact/decision/preference in 1-3 sentences
- "tags": array of 1-3 relevant tags

Rules:
- Only extract genuinely useful, non-obvious information
- Do NOT duplicate any existing memories listed above
- If nothing worth extracting, return []
- Maximum 5 extractions per call

IMPORTANT: Return ONLY valid JSON, no markdown fencing.`;

    let extractions = [];
    try {
      const result = await haikuQuery(extractionPrompt);
      if (Array.isArray(result)) {
        extractions = result;
      } else if (typeof result === 'string') {
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          extractions = JSON.parse(jsonMatch[0]);
        }
      }
    } catch (err) {
      console.error(`[smart-memory] Haiku extraction failed for ${agentId}:`, err.message);
      return { extracted: [], skipped: 0 };
    }

    // Write new memories with deduplication
    const extracted = [];
    let skipped = 0;

    for (const item of extractions.slice(0, 5)) {
      if (!item.type || !item.content || !item.title) {
        skipped++;
        continue;
      }

      // Check for duplicates by comparing content similarity
      const isDuplicate = existingMemories.some(existing =>
        contentSimilar(existing.description, item.content) ||
        contentSimilar(existing.name, item.title)
      );

      if (isDuplicate) {
        skipped++;
        continue;
      }

      // Generate filename from title
      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
      const hash = crypto.randomBytes(3).toString('hex');
      const filename = `${slug}-${hash}.md`;
      const filePath = path.join(autoDir, filename);

      // Build memory file with YAML frontmatter
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const now = new Date().toISOString();
      const memoryContent = `---
name: "${escapeYaml(item.title)}"
description: "${escapeYaml(item.content.slice(0, 200))}"
type: ${item.type}
agent: ${agentId}
tags: ${JSON.stringify(tags)}
created: "${now.slice(0, 10)}"
last_updated: "${now.slice(0, 10)}"
source: auto-extract
---

# ${item.title}

${item.content}

---
*Auto-extracted on ${now.slice(0, 10)} at ${now.slice(11, 16)} UTC*
`;

      await fs.writeFile(filePath, memoryContent, 'utf-8');

      extracted.push({
        type: item.type,
        content: item.content,
        file: filePath,
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[smart-memory] extractMemories(${agentId}): ${extracted.length} extracted, ${skipped} skipped in ${duration}ms`);

    return { extracted, skipped };
  } catch (err) {
    console.error(`[smart-memory] extractMemories failed for ${agentId}:`, err.message);
    return { extracted: [], skipped: 0 };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load existing auto-memory files for deduplication.
 */
async function loadExistingAutoMemories(autoDir) {
  const memories = [];
  try {
    const entries = await fs.readdir(autoDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      try {
        const content = await fs.readFile(path.join(autoDir, entry), 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        memories.push({
          file: entry,
          name: frontmatter.name || entry,
          description: frontmatter.description || '',
          type: frontmatter.type || 'unknown',
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* directory doesn't exist yet */ }
  return memories;
}

/**
 * Simple content similarity check using normalized Jaccard-like comparison.
 * Returns true if texts share significant overlap.
 */
function contentSimilar(a, b) {
  if (!a || !b) return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const similarity = overlap / Math.min(wordsA.size, wordsB.size);
  return similarity > 0.6;
}

/**
 * Escape a string for use in YAML double-quoted values.
 */
function escapeYaml(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export default { findRelevantMemories, extractMemories };
