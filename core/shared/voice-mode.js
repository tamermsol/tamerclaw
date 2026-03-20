/**
 * Voice Mode Manager — tracks per-chat voice conversation state
 *
 * When voice mode is ON for a chat, agent responses are converted
 * to voice audio and sent as Telegram voice messages.
 *
 * State persists to disk so it survives restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import paths from './paths.js';

// Voice mode state file — stored in user/ dir (per-installation)
const STATE_FILE = join(paths.user, 'voice-mode.json');

// In-memory cache
let state = loadState();

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[voice-mode] Failed to load state:', err.message);
  }
  return { chats: {} };
}

function saveState() {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[voice-mode] Failed to save state:', err.message);
  }
}

/**
 * Enable voice mode for a chat
 * @param {string|number} chatId
 * @param {object} [options]
 * @param {string} [options.voice] - Voice preset (e.g. 'josh', 'rachel', 'en-male')
 * @param {string} [options.provider] - TTS provider: 'elevenlabs' or 'edge' (auto if omitted)
 * @param {string} [options.model] - ElevenLabs model: 'flash', 'quality', 'v3'
 * @param {boolean} [options.textToo] - Also send text alongside voice (default: true)
 */
export function enableVoiceMode(chatId, options = {}) {
  const id = String(chatId);
  state.chats[id] = {
    enabled: true,
    voice: options.voice || 'josh',
    provider: options.provider || null, // null = auto-detect
    model: options.model || 'flash',
    textToo: options.textToo !== false, // default true
    enabledAt: new Date().toISOString(),
  };
  saveState();
  console.log(`[voice-mode] Enabled for chat ${id} (voice: ${state.chats[id].voice}, provider: ${state.chats[id].provider || 'auto'})`);
}

/**
 * Disable voice mode for a chat
 * @param {string|number} chatId
 */
export function disableVoiceMode(chatId) {
  const id = String(chatId);
  delete state.chats[id];
  saveState();
  console.log(`[voice-mode] Disabled for chat ${id}`);
}

/**
 * Check if voice mode is active for a chat
 * @param {string|number} chatId
 * @returns {object|null} Voice mode config or null if not active
 */
export function getVoiceMode(chatId) {
  const id = String(chatId);
  const config = state.chats[id];
  if (config && config.enabled) {
    return config;
  }
  return null;
}

/**
 * Set voice preset for a chat (must already have voice mode enabled)
 * @param {string|number} chatId
 * @param {string} voice - Voice preset key or full voice name
 */
export function setVoice(chatId, voice) {
  const id = String(chatId);
  if (!state.chats[id]) {
    enableVoiceMode(chatId, { voice });
    return;
  }
  state.chats[id].voice = voice;
  saveState();
  console.log(`[voice-mode] Voice changed for chat ${id}: ${voice}`);
}

/**
 * Set TTS provider for a chat
 * @param {string|number} chatId
 * @param {string} provider - 'elevenlabs', 'edge', or null for auto
 */
export function setProvider(chatId, provider) {
  const id = String(chatId);
  if (!state.chats[id]) return;
  state.chats[id].provider = provider;
  saveState();
  console.log(`[voice-mode] Provider changed for chat ${id}: ${provider || 'auto'}`);
}

/**
 * Set ElevenLabs model for a chat
 * @param {string|number} chatId
 * @param {string} model - 'flash', 'quality', or 'v3'
 */
export function setModel(chatId, model) {
  const id = String(chatId);
  if (!state.chats[id]) return;
  state.chats[id].model = model;
  saveState();
  console.log(`[voice-mode] Model changed for chat ${id}: ${model}`);
}

/**
 * Toggle text alongside voice
 * @param {string|number} chatId
 * @param {boolean} textToo
 */
export function setTextMode(chatId, textToo) {
  const id = String(chatId);
  if (!state.chats[id]) return;
  state.chats[id].textToo = textToo;
  saveState();
}

/**
 * Get all active voice mode chats (for debugging/status)
 */
export function getActiveChats() {
  return Object.entries(state.chats)
    .filter(([_, v]) => v.enabled)
    .map(([chatId, config]) => ({ chatId, ...config }));
}

export default {
  enableVoiceMode,
  disableVoiceMode,
  getVoiceMode,
  setVoice,
  setProvider,
  setModel,
  setTextMode,
  getActiveChats,
};
