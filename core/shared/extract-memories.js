/**
 * extract-memories.js — Post-Conversation Memory Extraction for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's post-conversation hook that forks a subagent
 * to extract durable facts into memory files.
 *
 * This creates a "short-term → medium-term" memory pipeline:
 *   1. After each conversation turn, a lightweight Haiku call evaluates
 *      whether the turn contains extractable facts
 *   2. Durable facts (preferences, decisions, project context, relationships)
 *      are extracted and classified
 *   3. Facts are written to structured memory files with deduplication
 *   4. Memory files are organized by category (preferences, decisions, context, etc.)
 *
 * This differs from auto-dream.js (which does end-of-day consolidation).
 * Extract-memories runs per-turn for real-time memory capture.
 *
 * Usage:
 *   import { extractMemories, MemoryExtractor } from './extract-memories.js';
 *
 *   // After a conversation turn:
 *   await extractMemories('agent-id', [
 *     { role: 'user', content: 'I prefer dark mode for all UIs' },
 *     { role: 'assistant', content: 'Noted, I\'ll use dark mode...' },
 *   ]);
 */

import fs from 'fs';
import path from 'path';
import paths from './paths.js';
import { feature } from './feature-flags.js';

// ── Memory Categories ───────────────────────────────────────────────────
export const MEMORY_CATEGORIES = {
  PREFERENCE: 'preference',     // User likes/dislikes, style preferences
  DECISION: 'decision',         // Architectural/design decisions made
  CONTEXT: 'context',           // Project context, relationships, goals
  TECHNICAL: 'technical',       // Technical facts (stack, APIs, patterns)
  RELATIONSHIP: 'relationship', // People, roles, teams
  WORKFLOW: 'workflow',         // How the user works, processes
  CORRECTION: 'correction',     // Things the user corrected/clarified
};

// ── Extraction Prompt ───────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze this conversation turn and extract durable facts worth remembering long-term.

Rules:
- Only extract FACTS, not opinions or transient states
- Skip greetings, acknowledgments, status updates
- Focus on: user preferences, decisions made, project context, technical choices, corrections
- Each fact must be self-contained (readable without the conversation)
- Classify each fact into exactly one category
- Return JSON array of extracted facts, or empty array if nothing worth extracting

Categories: preference, decision, context, technical, relationship, workflow, correction

Example output:
[
  {"category": "preference", "fact": "User prefers dark mode for all UI designs", "confidence": 0.95},
  {"category": "decision", "fact": "Using PostgreSQL instead of MongoDB for the trading backend", "confidence": 0.9},
  {"category": "correction", "fact": "The mos Linux user is a colleague's account, not an agent", "confidence": 1.0}
]

Return ONLY the JSON array, no other text.`;

// ── MemoryExtractor Class ───────────────────────────────────────────────
export class MemoryExtractor {
  constructor(opts = {}) {
    this.minConfidence = opts.minConfidence || 0.7;
    this.maxFactsPerTurn = opts.maxFactsPerTurn || 5;
    this.deduplicationWindow = opts.deduplicationWindow || 100; // Recent facts to check
    this._recentFacts = [];     // Ring buffer for dedup
    this._stats = {
      turnsProcessed: 0,
      factsExtracted: 0,
      factsDeduped: 0,
      errors: 0,
    };
    this._classifier = opts.classifier || null; // Optional custom classifier
  }

  /**
   * Extract memories from a conversation turn.
   * @param {string} agentId
   * @param {Array<{role: string, content: string}>} messages - Recent turn
   * @param {object} [opts]
   * @returns {Promise<Array<{category: string, fact: string, confidence: number}>>}
   */
  async extract(agentId, messages, opts = {}) {
    this._stats.turnsProcessed++;

    // Quick check: skip very short turns
    const totalContent = messages.map(m => m.content || '').join(' ');
    if (totalContent.length < 50) return [];

    try {
      // Use Haiku for cheap/fast classification
      const facts = await this._callClassifier(messages, opts);

      if (!Array.isArray(facts) || facts.length === 0) return [];

      // Filter by confidence
      const confident = facts
        .filter(f => f.confidence >= this.minConfidence)
        .slice(0, this.maxFactsPerTurn);

      // Deduplicate against recent facts
      const novel = this._dedup(confident);

      // Write to memory files
      if (novel.length > 0) {
        await this._writeToMemory(agentId, novel);
        this._stats.factsExtracted += novel.length;
      }

      return novel;
    } catch (err) {
      this._stats.errors++;
      console.warn(`[extract-memories] Error for ${agentId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Get extractor stats.
   */
  getStats() {
    return { ...this._stats, recentFactsBufferSize: this._recentFacts.length };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _callClassifier(messages, opts) {
    // If a custom classifier function is provided, use it
    if (this._classifier) {
      return this._classifier(messages, EXTRACTION_PROMPT);
    }

    // Try to use the anthropic client for Haiku classification
    try {
      const { classify } = await import('./anthropic-client.js');
      const conversationText = messages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');

      const result = await classify(
        `${EXTRACTION_PROMPT}\n\nConversation turn:\n${conversationText}`,
        { maxTokens: 1000 }
      );

      // Parse JSON from response
      const text = typeof result === 'string' ? result : result.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return [];
    } catch (err) {
      // Fallback: simple keyword-based extraction
      return this._fallbackExtract(messages);
    }
  }

  /**
   * Fallback extraction using keyword patterns (no AI needed).
   */
  _fallbackExtract(messages) {
    const facts = [];
    const patterns = [
      { regex: /(?:i prefer|i like|i want|i always|i never|please always|please never)\s+(.{10,100})/i, category: 'preference' },
      { regex: /(?:let's use|we'll go with|decided to|choosing|switching to)\s+(.{10,100})/i, category: 'decision' },
      { regex: /(?:the project|our app|the system|the codebase)\s+(.{10,100})/i, category: 'context' },
      { regex: /(?:using|stack is|built with|powered by|running on)\s+(.{10,80})/i, category: 'technical' },
      { regex: /(?:no no|actually|i meant|not that|i mean)\s+(.{10,100})/i, category: 'correction' },
    ];

    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const content = msg.content || '';

      for (const { regex, category } of patterns) {
        const match = content.match(regex);
        if (match) {
          facts.push({
            category,
            fact: content.slice(0, 200).trim(),
            confidence: 0.6, // Lower confidence for pattern-based
          });
          break; // One fact per message max in fallback mode
        }
      }
    }

    return facts;
  }

  /**
   * Deduplicate against recent facts using similarity.
   */
  _dedup(facts) {
    const novel = [];

    for (const fact of facts) {
      const normalized = fact.fact.toLowerCase().replace(/[^a-z0-9\s]/g, '');

      // Check against recent facts
      const isDup = this._recentFacts.some(existing => {
        const existingNorm = existing.toLowerCase().replace(/[^a-z0-9\s]/g, '');
        return this._similarity(normalized, existingNorm) > 0.75;
      });

      if (!isDup) {
        novel.push(fact);
        this._recentFacts.push(fact.fact);

        // Ring buffer: keep only recent N
        if (this._recentFacts.length > this.deduplicationWindow) {
          this._recentFacts.shift();
        }
      } else {
        this._stats.factsDeduped++;
      }
    }

    return novel;
  }

  /**
   * Jaccard similarity on word sets.
   */
  _similarity(a, b) {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Write extracted facts to per-category memory files.
   */
  async _writeToMemory(agentId, facts) {
    const memoryDir = paths.memory(agentId);

    // Ensure memory dir exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const extractedPath = path.join(memoryDir, 'extracted-facts.md');
    const now = new Date().toISOString().split('T')[0];

    // Group by category
    const grouped = {};
    for (const fact of facts) {
      const cat = fact.category || 'context';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(fact);
    }

    // Append to extracted-facts.md
    let content = '';
    if (fs.existsSync(extractedPath)) {
      content = fs.readFileSync(extractedPath, 'utf-8');
    } else {
      content = `# Extracted Facts\n\nAuto-extracted durable facts from conversations.\n\n`;
    }

    for (const [category, catFacts] of Object.entries(grouped)) {
      const header = `## ${category.charAt(0).toUpperCase() + category.slice(1)}`;

      // Ensure category section exists
      if (!content.includes(header)) {
        content += `\n${header}\n\n`;
      }

      // Append facts under category
      const insertPoint = content.indexOf(header) + header.length;
      const nextSection = content.indexOf('\n## ', insertPoint + 1);
      const sectionEnd = nextSection > -1 ? nextSection : content.length;

      const newFacts = catFacts
        .map(f => `- ${f.fact} _(${now}, confidence: ${f.confidence})_`)
        .join('\n');

      content = content.slice(0, sectionEnd) + '\n' + newFacts + '\n' + content.slice(sectionEnd);
    }

    fs.writeFileSync(extractedPath, content, 'utf-8');
  }
}

// ── Singleton ───────────────────────────────────────────────────────────
let _extractor = null;

/**
 * Get or create the global memory extractor.
 * @param {object} [opts]
 * @returns {MemoryExtractor}
 */
export function getExtractor(opts) {
  if (!_extractor) {
    _extractor = new MemoryExtractor(opts);
  }
  return _extractor;
}

/**
 * Extract memories from a conversation turn (convenience function).
 * @param {string} agentId
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @returns {Promise<Array>}
 */
export async function extractMemories(agentId, messages, opts = {}) {
  if (!feature('EXTRACT_MEMORIES')) return [];
  const extractor = getExtractor(opts);
  return extractor.extract(agentId, messages, opts);
}

export default MemoryExtractor;
