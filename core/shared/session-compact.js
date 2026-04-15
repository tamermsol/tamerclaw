/**
 * session-compact.js — Session Memory Compaction for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's session memory compaction strategy.
 * Instead of re-summarizing conversation history with Haiku,
 * this replaces old messages with a persistent session memory file + recent tail.
 *
 * How it works:
 *   1. When conversation exceeds threshold, split into "compacted" and "recent"
 *   2. Compacted portion is summarized into a session-memory.md file
 *   3. Next turn loads: [session-memory summary] + [recent N messages]
 *   4. Summary grows incrementally (append-only, never re-summarizes)
 *
 * This is cheaper and faster than our old 4-tier compaction because:
 *   - Only new content gets summarized (not the whole history)
 *   - Summary file persists across session restarts
 *   - Recent messages stay verbatim (no information loss)
 *   - Works without AI fallback (rule-based extraction)
 *
 * Usage:
 *   import { SessionCompactor, compactSession } from './session-compact.js';
 *
 *   const compactor = new SessionCompactor('agent-id');
 *   const result = compactor.compact(messages, { recentCount: 10 });
 *   // result.summary → session memory text
 *   // result.recent  → last N messages (verbatim)
 */

import fs from 'fs';
import path from 'path';
import paths from './paths.js';
import { feature } from './feature-flags.js';

// ── Defaults ────────────────────────────────────────────────────────────
const DEFAULT_OPTS = {
  compactThreshold: 30,    // Compact when messages exceed this
  recentCount: 10,         // Keep last N messages verbatim
  maxSummarySize: 8000,    // Max chars in summary file before rotating
  useAI: true,             // Use Haiku for smart summarization
  preserveCodeBlocks: true, // Don't truncate code blocks in recent
  preserveDecisions: true,  // Extract decisions into summary
  summaryFormat: 'structured', // 'structured' or 'narrative'
};

// ── SessionCompactor ────────────────────────────────────────────────────
export class SessionCompactor {
  /**
   * @param {string} agentId
   * @param {object} [opts]
   */
  constructor(agentId, opts = {}) {
    this.agentId = agentId;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this._summaryPath = path.join(
      paths.sessions(agentId) || paths.agentDir(agentId),
      'session-memory.md'
    );
    this._stats = {
      compactions: 0,
      messagesCompacted: 0,
      tokensEstimatedSaved: 0,
    };
  }

  /**
   * Check if compaction is needed.
   * @param {Array} messages
   * @returns {boolean}
   */
  needsCompaction(messages) {
    return messages.length > this.opts.compactThreshold;
  }

  /**
   * Compact a message history.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [opts] - Override defaults
   * @returns {Promise<{summary: string, recent: Array, compacted: number, saved: boolean}>}
   */
  async compact(messages, opts = {}) {
    const mergedOpts = { ...this.opts, ...opts };

    if (messages.length <= mergedOpts.compactThreshold) {
      return { summary: null, recent: messages, compacted: 0, saved: false };
    }

    const recentCount = Math.min(mergedOpts.recentCount, messages.length);
    const cutoff = messages.length - recentCount;
    const toCompact = messages.slice(0, cutoff);
    const recent = messages.slice(cutoff);

    // Generate summary of compacted messages
    let summary;
    if (mergedOpts.useAI) {
      summary = await this._aiSummarize(toCompact, mergedOpts);
    } else {
      summary = this._ruleSummarize(toCompact, mergedOpts);
    }

    // Load existing session memory and append
    const existing = this._loadSessionMemory();
    const combined = this._mergeSummary(existing, summary, mergedOpts);

    // Save to file
    this._saveSessionMemory(combined);

    // Update stats
    this._stats.compactions++;
    this._stats.messagesCompacted += toCompact.length;
    // Rough token estimate: ~4 chars per token
    this._stats.tokensEstimatedSaved += Math.round(
      toCompact.reduce((s, m) => s + (m.content?.length || 0), 0) / 4
    );

    return {
      summary: combined,
      recent,
      compacted: toCompact.length,
      saved: true,
    };
  }

  /**
   * Build the system prompt section from session memory.
   * @returns {string}
   */
  buildPromptSection() {
    const memory = this._loadSessionMemory();
    if (!memory) return '';

    return `\n<session-memory>\n${memory}\n</session-memory>\n`;
  }

  /**
   * Get compaction stats.
   */
  getStats() {
    return {
      ...this._stats,
      summaryExists: fs.existsSync(this._summaryPath),
      summarySize: fs.existsSync(this._summaryPath)
        ? fs.statSync(this._summaryPath).size
        : 0,
    };
  }

  /**
   * Clear the session memory (start fresh).
   */
  clear() {
    if (fs.existsSync(this._summaryPath)) {
      fs.unlinkSync(this._summaryPath);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * AI-powered summarization using Haiku.
   */
  async _aiSummarize(messages, opts) {
    try {
      const { classify } = await import('./anthropic-client.js');
      const conversation = messages
        .map(m => `[${m.role}]: ${(m.content || '').slice(0, 500)}`)
        .join('\n');

      const prompt = `Summarize this conversation segment for future context. Focus on:
- Decisions made
- Tasks completed or in-progress
- User preferences expressed
- Technical details (files, APIs, configs mentioned)
- Action items or next steps

Be concise but preserve all important details. Use bullet points.
Do NOT include greetings, acknowledgments, or filler.

Conversation:
${conversation}`;

      const result = await classify(prompt, { maxTokens: 1500 });
      return typeof result === 'string' ? result : result.text || '';
    } catch (err) {
      console.warn(`[session-compact] AI summarization failed, using rules: ${err.message}`);
      return this._ruleSummarize(messages, opts);
    }
  }

  /**
   * Rule-based summarization (no AI needed — fast and free).
   */
  _ruleSummarize(messages, opts) {
    const sections = {
      decisions: [],
      tasks: [],
      context: [],
      technical: [],
    };

    for (const msg of messages) {
      const content = msg.content || '';

      // Extract decisions
      if (/(?:decided|let's|going to|will use|switching to|chose)/i.test(content)) {
        const snippet = content.slice(0, 200).trim();
        sections.decisions.push(`- ${msg.role}: ${snippet}`);
      }

      // Extract tasks/commands
      if (/(?:created|implemented|fixed|updated|deployed|built|installed)/i.test(content) && msg.role === 'assistant') {
        const snippet = content.slice(0, 200).trim();
        sections.tasks.push(`- ${snippet}`);
      }

      // Extract file/path mentions
      const fileMentions = content.match(/(?:\/[\w\-./]+\.\w+)/g);
      if (fileMentions) {
        sections.technical.push(...fileMentions.slice(0, 3));
      }

      // Extract user preferences/instructions
      if (msg.role === 'user' && content.length > 30) {
        if (/(?:always|never|prefer|want|need|make sure|important)/i.test(content)) {
          sections.context.push(`- User: ${content.slice(0, 150).trim()}`);
        }
      }
    }

    // Build structured summary
    let summary = `### Compacted at ${new Date().toISOString().split('T')[0]} (${messages.length} messages)\n`;

    if (sections.decisions.length > 0) {
      summary += `\n**Decisions:**\n${sections.decisions.slice(0, 5).join('\n')}\n`;
    }
    if (sections.tasks.length > 0) {
      summary += `\n**Completed:**\n${sections.tasks.slice(0, 8).join('\n')}\n`;
    }
    if (sections.context.length > 0) {
      summary += `\n**Context:**\n${sections.context.slice(0, 5).join('\n')}\n`;
    }
    if (sections.technical.length > 0) {
      const uniqueFiles = [...new Set(sections.technical)].slice(0, 10);
      summary += `\n**Files mentioned:** ${uniqueFiles.join(', ')}\n`;
    }

    return summary;
  }

  /**
   * Merge new summary into existing session memory.
   */
  _mergeSummary(existing, newSummary, opts) {
    if (!existing) return newSummary;

    const combined = existing + '\n\n---\n\n' + newSummary;

    // If too large, trim the oldest section
    if (combined.length > opts.maxSummarySize) {
      const sections = combined.split('\n\n---\n\n');
      // Keep the most recent sections that fit
      let trimmed = '';
      for (let i = sections.length - 1; i >= 0; i--) {
        const candidate = sections[i] + (trimmed ? '\n\n---\n\n' + trimmed : '');
        if (candidate.length > opts.maxSummarySize && trimmed) break;
        trimmed = candidate;
      }
      return trimmed;
    }

    return combined;
  }

  /**
   * Load existing session memory file.
   */
  _loadSessionMemory() {
    try {
      if (fs.existsSync(this._summaryPath)) {
        return fs.readFileSync(this._summaryPath, 'utf-8');
      }
    } catch (err) {
      console.warn(`[session-compact] Failed to load session memory: ${err.message}`);
    }
    return null;
  }

  /**
   * Save session memory file.
   */
  _saveSessionMemory(content) {
    try {
      const dir = path.dirname(this._summaryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._summaryPath, content, 'utf-8');
    } catch (err) {
      console.warn(`[session-compact] Failed to save session memory: ${err.message}`);
    }
  }
}

// ── Per-agent compactor cache ───────────────────────────────────────────
const _compactors = new Map();

/**
 * Get or create a compactor for an agent.
 * @param {string} agentId
 * @param {object} [opts]
 * @returns {SessionCompactor}
 */
export function getCompactor(agentId, opts) {
  if (!_compactors.has(agentId)) {
    _compactors.set(agentId, new SessionCompactor(agentId, opts));
  }
  return _compactors.get(agentId);
}

/**
 * Compact a session (convenience function).
 * @param {string} agentId
 * @param {Array} messages
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function compactSession(agentId, messages, opts = {}) {
  if (!feature('SESSION_COMPACT')) return { summary: null, recent: messages, compacted: 0, saved: false };
  const compactor = getCompactor(agentId, opts);
  return compactor.compact(messages, opts);
}

export default SessionCompactor;
