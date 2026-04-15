/**
 * anthropic-client.js — Direct Anthropic API Client for TamerClaw
 *
 * Provides direct SDK access to all Claude models (Opus, Sonnet, Haiku)
 * with streaming support, retry logic, model routing, and cost tracking.
 *
 * This bypasses the Claude CLI for faster, more flexible API access.
 *
 * Usage:
 *   import { chat, stream, getClient, MODELS } from '../shared/anthropic-client.js';
 *
 *   // Simple completion
 *   const response = await chat('What is 2+2?', { model: 'haiku' });
 *
 *   // Streaming
 *   for await (const chunk of stream('Write a poem', { model: 'sonnet' })) {
 *     process.stdout.write(chunk.text);
 *   }
 *
 *   // Full control
 *   const client = getClient();
 *   const msg = await client.messages.create({ ... });
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { feature } from './feature-flags.js';

// ── Auth & Mode Resolution ──────────────────────────────────────────────
// Two modes:
//   1. 'sdk' — Direct Anthropic SDK with API key (fastest)
//   2. 'cli' — Claude Code CLI subprocess (uses OAuth, always works)
//
// Priority: ANTHROPIC_API_KEY → CLI fallback

let _mode = null; // 'sdk' | 'cli'

function resolveAuth() {
  // 1. Check for explicit API key → SDK mode
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    _mode = 'sdk';
    return { apiKey };
  }

  // 2. No API key → fall back to CLI mode
  _mode = 'cli';
  console.log('[anthropic] No API key found, using Claude CLI mode (OAuth)');
  return null;
}

export function getMode() { return _mode; }

// ── CLI Execution Helper ────────────────────────────────────────────────
// Uses the Claude CLI binary which has its own OAuth session management

function cliCall(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const model = resolveModel(opts.model || 'sonnet');
    const args = [
      '--model', model,
      '--max-turns', '1',
      '-p', prompt,
      '--output-format', 'json',
    ];

    if (opts.system) {
      args.push('--system-prompt', opts.system);
    }

    // Disable tools for simple chat calls (faster)
    if (opts.noTools) {
      args.push('--allowedTools', '');
    }

    const child = spawn('/usr/local/bin/claude', args, {
      env: { ...process.env, TERM: 'dumb' },
      timeout: opts.timeout || 120000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(new Error(`CLI exited ${code}: ${stderr.slice(0, 500)}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          text: parsed.result || parsed.content || stdout.trim(),
          content: [{ type: 'text', text: parsed.result || parsed.content || stdout.trim() }],
          usage: { input_tokens: parsed.input_tokens || 0, output_tokens: parsed.output_tokens || 0 },
          model,
          stopReason: 'end_turn',
          id: `cli-${Date.now()}`,
        });
      } catch {
        // Plain text output
        resolve({
          text: stdout.trim(),
          content: [{ type: 'text', text: stdout.trim() }],
          usage: { input_tokens: 0, output_tokens: 0 },
          model,
          stopReason: 'end_turn',
          id: `cli-${Date.now()}`,
        });
      }
    });

    child.on('error', reject);
  });
}

async function* cliStream(prompt, opts = {}) {
  const model = resolveModel(opts.model || 'sonnet');
  const args = [
    '--model', model,
    '--max-turns', '1',
    '-p', prompt,
    '--stream-json',
  ];

  if (opts.system) {
    args.push('--system-prompt', opts.system);
  }

  const child = spawn('/usr/local/bin/claude', args, {
    env: { ...process.env, TERM: 'dumb' },
    timeout: opts.timeout || 120000,
  });

  yield { type: 'start', model };

  let fullText = '';

  for await (const chunk of child.stdout) {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant' && event.message) {
          const delta = event.message;
          fullText += delta;
          yield { type: 'text', delta, text: fullText };
        } else if (event.type === 'result') {
          yield { type: 'done', stopReason: 'end_turn', usage: { input_tokens: event.input_tokens || 0, output_tokens: event.output_tokens || 0 } };
        }
      } catch {
        // Non-JSON line — treat as text delta
        const text = line.trim();
        if (text) {
          fullText += text;
          yield { type: 'text', delta: text, text: fullText };
        }
      }
    }
  }

  yield { type: 'done', stopReason: 'end_turn' };
}

// ── Model Registry ──────────────────────────────────────────────────────
export const MODELS = {
  // Tier 1: Full capability
  opus: {
    id: 'claude-opus-4-6',
    alias: ['opus', 'opus-4-6', 'claude-opus-4-6'],
    contextWindow: 200_000,
    maxOutput: 16_384,
    tier: 'premium',
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    bestFor: ['planning', 'architecture', 'complex-analysis', 'research', 'debugging'],
  },

  // Tier 2: Balanced
  sonnet: {
    id: 'claude-sonnet-4-6',
    alias: ['sonnet', 'sonnet-4-6', 'claude-sonnet-4-6'],
    contextWindow: 200_000,
    maxOutput: 16_384,
    tier: 'standard',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    bestFor: ['coding', 'execution', 'general', 'conversation'],
  },

  // Tier 3: Fast & cheap
  haiku: {
    id: 'claude-haiku-4-5',
    alias: ['haiku', 'haiku-4-5', 'claude-haiku-4-5'],
    contextWindow: 200_000,
    maxOutput: 8_192,
    tier: 'economy',
    costPer1kInput: 0.00025,
    costPer1kOutput: 0.00125,
    bestFor: ['classification', 'routing', 'simple-queries', 'memory-recall', 'validation'],
  },
};

// Model alias → canonical key lookup
const MODEL_ALIAS_MAP = new Map();
for (const [key, model] of Object.entries(MODELS)) {
  MODEL_ALIAS_MAP.set(key, key);
  for (const alias of model.alias) {
    MODEL_ALIAS_MAP.set(alias, key);
  }
}

// ── Client Singleton ────────────────────────────────────────────────────
let _client = null;

/**
 * Get or create the Anthropic client singleton.
 * Uses ANTHROPIC_API_KEY from environment (set by Claude Code auth).
 */
export function getClient() {
  if (!_client) {
    const auth = resolveAuth();
    if (auth) {
      _client = new Anthropic(auth);
      console.log(`[anthropic] SDK client initialized with API Key`);
    } else {
      // CLI mode — create a dummy client for reference
      _client = { _mode: 'cli' };
      console.log(`[anthropic] Using Claude CLI mode (no SDK client)`);
    }
  }
  return _client;
}

/**
 * Resolve a model alias to the full model ID.
 * @param {string} modelOrAlias - 'opus', 'sonnet', 'haiku', or full ID
 * @returns {string} Full model ID
 */
export function resolveModel(modelOrAlias) {
  const canonical = MODEL_ALIAS_MAP.get(modelOrAlias);
  if (canonical) return MODELS[canonical].id;
  // If already a full model ID, return as-is
  return modelOrAlias;
}

/**
 * Get model metadata by alias or ID.
 * @param {string} modelOrAlias
 * @returns {object|null}
 */
export function getModelInfo(modelOrAlias) {
  const canonical = MODEL_ALIAS_MAP.get(modelOrAlias);
  return canonical ? MODELS[canonical] : null;
}

// ── Cost Tracker ────────────────────────────────────────────────────────
const _costTracker = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  calls: 0,
  byModel: {},
};

function trackUsage(modelKey, usage) {
  if (!usage) return;

  const model = MODELS[modelKey] || MODELS.sonnet;
  const inputCost = (usage.input_tokens / 1000) * model.costPer1kInput;
  const outputCost = (usage.output_tokens / 1000) * model.costPer1kOutput;
  const totalCost = inputCost + outputCost;

  _costTracker.totalInputTokens += usage.input_tokens;
  _costTracker.totalOutputTokens += usage.output_tokens;
  _costTracker.totalCost += totalCost;
  _costTracker.calls++;

  if (!_costTracker.byModel[modelKey]) {
    _costTracker.byModel[modelKey] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  const m = _costTracker.byModel[modelKey];
  m.calls++;
  m.inputTokens += usage.input_tokens;
  m.outputTokens += usage.output_tokens;
  m.cost += totalCost;
}

export function getCostStats() {
  return { ..._costTracker };
}

export function resetCostStats() {
  _costTracker.totalInputTokens = 0;
  _costTracker.totalOutputTokens = 0;
  _costTracker.totalCost = 0;
  _costTracker.calls = 0;
  _costTracker.byModel = {};
}

// ── Retry Logic ─────────────────────────────────────────────────────────
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  retryableErrors: ['overloaded_error', 'rate_limit_error', 'api_error'],
  retryableStatusCodes: [429, 500, 502, 503, 529],
};

async function withRetry(fn, retries = RETRY_CONFIG.maxRetries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isRetryable =
        RETRY_CONFIG.retryableErrors.includes(error?.error?.type) ||
        RETRY_CONFIG.retryableStatusCodes.includes(error?.status);

      if (!isRetryable || attempt === retries) throw error;

      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
        RETRY_CONFIG.maxDelay
      );
      console.log(`[anthropic] Retry ${attempt + 1}/${retries} after ${Math.round(delay)}ms: ${error.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Main API Functions ──────────────────────────────────────────────────

/**
 * Send a chat message and get a complete response.
 *
 * @param {string|Array} messages - String (user message) or array of {role, content}
 * @param {object} [opts]
 * @param {string} [opts.model='sonnet'] - Model alias or full ID
 * @param {string} [opts.system] - System prompt
 * @param {number} [opts.maxTokens=4096] - Max output tokens
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {Array} [opts.tools] - Tool definitions
 * @param {string} [opts.toolChoice] - Tool choice mode
 * @param {boolean} [opts.retry=true] - Enable retry logic
 * @returns {Promise<{text: string, usage: object, model: string, stopReason: string}>}
 */
export async function chat(messages, opts = {}) {
  const client = getClient();
  const modelAlias = opts.model || 'sonnet';
  const modelId = resolveModel(modelAlias);
  const modelKey = MODEL_ALIAS_MAP.get(modelAlias) || 'sonnet';

  // CLI mode — use Claude CLI subprocess
  if (_mode === 'cli') {
    const prompt = typeof messages === 'string'
      ? messages
      : messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');

    const result = await cliCall(prompt, { ...opts, model: modelAlias });
    trackUsage(modelKey, result.usage);
    return result;
  }

  // SDK mode — direct API call
  const msgArray = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  const params = {
    model: modelId,
    messages: msgArray,
    max_tokens: opts.maxTokens || 4096,
  };

  if (opts.system) params.system = opts.system;
  if (opts.temperature !== undefined) params.temperature = opts.temperature;
  if (opts.tools) params.tools = opts.tools;
  if (opts.toolChoice) params.tool_choice = opts.toolChoice;

  const doCall = () => client.messages.create(params);
  const response = opts.retry !== false ? await withRetry(doCall) : await doCall();

  trackUsage(modelKey, response.usage);

  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  return {
    text,
    content: response.content,
    usage: response.usage,
    model: response.model,
    stopReason: response.stop_reason,
    id: response.id,
  };
}

/**
 * Stream a chat response, yielding chunks.
 *
 * @param {string|Array} messages - String or message array
 * @param {object} [opts] - Same as chat()
 * @yields {{ type: string, text?: string, delta?: string, usage?: object }}
 */
export async function* stream(messages, opts = {}) {
  const client = getClient();
  const modelAlias = opts.model || 'sonnet';
  const modelId = resolveModel(modelAlias);
  const modelKey = MODEL_ALIAS_MAP.get(modelAlias) || 'sonnet';

  // CLI mode — stream via Claude CLI subprocess
  if (_mode === 'cli') {
    const prompt = typeof messages === 'string'
      ? messages
      : messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');

    for await (const chunk of cliStream(prompt, { ...opts, model: modelAlias })) {
      yield chunk;
    }
    return;
  }

  // SDK mode — direct API streaming
  const msgArray = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;

  const params = {
    model: modelId,
    messages: msgArray,
    max_tokens: opts.maxTokens || 4096,
    stream: true,
  };

  if (opts.system) params.system = opts.system;
  if (opts.temperature !== undefined) params.temperature = opts.temperature;
  if (opts.tools) params.tools = opts.tools;
  if (opts.toolChoice) params.tool_choice = opts.toolChoice;

  const response = await client.messages.create(params);

  let fullText = '';
  let usage = null;

  for await (const event of response) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      fullText += event.delta.text;
      yield { type: 'text', delta: event.delta.text, text: fullText };
    } else if (event.type === 'message_start') {
      yield { type: 'start', model: event.message?.model };
    } else if (event.type === 'message_delta') {
      usage = event.usage;
      yield { type: 'done', stopReason: event.delta?.stop_reason, usage };
    } else if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') {
        yield { type: 'tool_use_start', name: event.content_block.name, id: event.content_block.id };
      }
    }
  }

  if (usage) trackUsage(modelKey, usage);
}

/**
 * Quick classification / routing call using Haiku (cheapest).
 * Returns the raw text response.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.system]
 * @param {number} [opts.maxTokens=256]
 * @returns {Promise<string>}
 */
export async function classify(prompt, opts = {}) {
  const result = await chat(prompt, {
    model: 'haiku',
    system: opts.system || 'You are a classifier. Respond concisely with just the answer.',
    maxTokens: opts.maxTokens || 256,
    temperature: 0,
    noTools: true,
  });
  return result.text.trim();
}

/**
 * Multi-turn conversation helper.
 * Maintains message history and streams responses.
 *
 * @param {object} config
 * @param {string} [config.model='sonnet']
 * @param {string} [config.system]
 * @param {number} [config.maxTokens=4096]
 */
export class Conversation {
  constructor(config = {}) {
    this.model = config.model || 'sonnet';
    this.system = config.system || '';
    this.maxTokens = config.maxTokens || 4096;
    this.messages = [];
    this.tools = config.tools || null;
  }

  /**
   * Send a message and get a response.
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
  async send(userMessage) {
    this.messages.push({ role: 'user', content: userMessage });

    const result = await chat(this.messages, {
      model: this.model,
      system: this.system,
      maxTokens: this.maxTokens,
      tools: this.tools,
    });

    this.messages.push({ role: 'assistant', content: result.content });
    return result.text;
  }

  /**
   * Send a message and stream the response.
   * @param {string} userMessage
   * @yields {object}
   */
  async *sendStream(userMessage) {
    this.messages.push({ role: 'user', content: userMessage });

    let fullText = '';
    for await (const chunk of stream(this.messages, {
      model: this.model,
      system: this.system,
      maxTokens: this.maxTokens,
      tools: this.tools,
    })) {
      if (chunk.type === 'text') fullText = chunk.text;
      yield chunk;
    }

    this.messages.push({ role: 'assistant', content: fullText });
  }

  /** Get conversation history */
  getHistory() { return [...this.messages]; }

  /** Clear history */
  clear() { this.messages = []; }

  /** Get token estimate (rough) */
  estimateTokens() {
    const text = this.messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join('');
    return Math.ceil(text.length / 4);
  }
}

// ── Tool Use Helper ─────────────────────────────────────────────────────

/**
 * Define a tool for the Anthropic API.
 * @param {string} name
 * @param {string} description
 * @param {object} inputSchema - JSON Schema for input
 * @returns {object}
 */
export function defineTool(name, description, inputSchema) {
  return {
    name,
    description,
    input_schema: inputSchema,
  };
}

/**
 * Run a tool-use loop: send message → get tool calls → execute → return final.
 *
 * @param {string|Array} messages
 * @param {object} opts
 * @param {Array} opts.tools - Tool definitions
 * @param {Function} opts.executor - async (toolName, input) => result
 * @param {number} [opts.maxTurns=10]
 * @returns {Promise<{text: string, toolCalls: Array}>}
 */
export async function toolLoop(messages, opts) {
  const { tools, executor, maxTurns = 10 } = opts;
  const msgArray = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : [...messages];

  const toolCalls = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await chat(msgArray, {
      ...opts,
      tools,
    });

    // Check for tool use blocks
    const toolUseBlocks = result.content.filter(c => c.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      // No more tool calls — return final response
      return { text: result.text, toolCalls, usage: result.usage };
    }

    // Add assistant message with tool use
    msgArray.push({ role: 'assistant', content: result.content });

    // Execute each tool and add results
    const toolResults = [];
    for (const block of toolUseBlocks) {
      toolCalls.push({ name: block.name, input: block.input });

      let toolResult;
      try {
        toolResult = await executor(block.name, block.input);
      } catch (err) {
        toolResult = `Error: ${err.message}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }

    msgArray.push({ role: 'user', content: toolResults });
  }

  return { text: '[Max tool turns reached]', toolCalls };
}

// ── Utility ─────────────────────────────────────────────────────────────

/**
 * Count approximate tokens for a string.
 * Claude uses ~4 chars per token on average.
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Check if the API is reachable.
 * @returns {Promise<{online: boolean, latency: number, error?: string}>}
 */
export async function healthCheck() {
  const start = Date.now();
  try {
    getClient(); // Ensure mode is resolved
    if (_mode === 'cli') {
      // Test CLI availability
      const { execFileSync } = await import('child_process');
      const version = execFileSync('/usr/local/bin/claude', ['--version'], { timeout: 5000 }).toString().trim();
      return { online: true, latency: Date.now() - start, mode: 'cli', version };
    }
    const result = await chat('Hi', {
      model: 'haiku',
      maxTokens: 5,
      temperature: 0,
      retry: false,
    });
    return { online: true, latency: Date.now() - start, mode: 'sdk', model: result.model };
  } catch (error) {
    return { online: false, latency: Date.now() - start, mode: _mode, error: error.message };
  }
}

/**
 * List all available models.
 */
export function listModels() {
  return Object.entries(MODELS).map(([key, m]) => ({
    key,
    id: m.id,
    tier: m.tier,
    contextWindow: m.contextWindow,
    maxOutput: m.maxOutput,
    bestFor: m.bestFor,
  }));
}

export default {
  chat, stream, classify, getClient, resolveModel, getModelInfo,
  listModels, healthCheck, getCostStats, resetCostStats,
  estimateTokens, Conversation, defineTool, toolLoop,
  MODELS,
};
