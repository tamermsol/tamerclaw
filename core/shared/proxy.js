/**
 * Shared Proxy Module — Dynamic Model Routing
 *
 * Allows agents to switch between:
 *   /proxy 1 — Original model (as configured in config.json)
 *   /proxy 2 — Dynamic routing: haiku for simple queries, opus for complex ones
 *
 * This preserves the opus rate limit by routing simple messages through haiku.
 * State is persisted per-agent in proxy-state.json.
 */

import fs from 'fs';
import { paths } from './paths.js';

const STATE_FILE = paths.proxyState;

// ── State Management ──────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[proxy] Failed to save state:', e.message);
  }
}

/**
 * Get proxy mode for an agent.
 * @returns {number} 1 = original, 2 = dynamic routing
 */
export function getProxyMode(agentId) {
  const state = loadState();
  return state[agentId]?.mode || 1;
}

/**
 * Set proxy mode for an agent.
 * @param {string} agentId
 * @param {number} mode - 1 or 2
 */
export function setProxyMode(agentId, mode) {
  const state = loadState();
  state[agentId] = {
    mode,
    setAt: new Date().toISOString()
  };
  saveState(state);
}

/**
 * Get all agents currently in proxy mode 2.
 */
export function getProxiedAgents() {
  const state = loadState();
  return Object.entries(state)
    .filter(([_, v]) => v.mode === 2)
    .map(([k]) => k);
}

// ── Message Complexity Classifier ─────────────────────────────────────────────

/**
 * Classify a message as 'simple' or 'complex' based on content patterns.
 */
export function classifyComplexity(text) {
  if (!text) return 'simple';

  const complexPatterns = [
    /\b(debug|fix|refactor|optimize|rewrite|migration|deploy|build)\b/i,
    /\b(implement|create|design|develop|integrate|configure|setup|architect)\b/i,
    /\b(error|bug|crash|broken|failing|issue|exception|traceback)\b/i,
    /\b(code|script|function|class|component|module|api|database|server)\b/i,
    /\b(analyze|review|audit|inspect|investigate|diagnose)\b/i,
    /\b(pagespeed|performance|render|animation|responsive)\b/i,
    /\b(test|spec|coverage|ci|cd|pipeline|workflow)\b/i,
    /```/,              // Code blocks
    /\n.*\n.*\n.*\n/,   // 4+ line messages
  ];

  if (text.length > 500) return 'complex';
  for (const pattern of complexPatterns) {
    if (pattern.test(text)) return 'complex';
  }
  return 'simple';
}

/**
 * Get the dynamic model CLI flag based on message complexity.
 * Simple → haiku (preserves opus rate limit)
 * Complex → opus (needs full power)
 *
 * @returns {string} CLI flag: 'haiku' or 'opus'
 */
export function getDynamicModel(text) {
  const complexity = classifyComplexity(text);
  return complexity === 'complex' ? 'opus' : 'haiku';
}

/**
 * Resolve the CLI model flag for an agent, respecting proxy mode.
 *
 * @param {string} agentId - The agent ID
 * @param {string} originalCliFlag - The agent's configured CLI flag (e.g. 'opus', 'sonnet')
 * @param {string} messageText - The user's message (for dynamic routing)
 * @returns {{ model: string, proxied: boolean, complexity: string|null }}
 */
export function resolveProxyModel(agentId, originalCliFlag, messageText) {
  const mode = getProxyMode(agentId);

  if (mode === 2) {
    const complexity = classifyComplexity(messageText);
    const model = complexity === 'complex' ? 'opus' : 'haiku';
    return { model, proxied: true, complexity };
  }

  return { model: originalCliFlag, proxied: false, complexity: null };
}
