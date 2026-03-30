/**
 * Voice Response Middleware — auto-reply with voice when input was voice
 *
 * "Speak with Agent" mode: when a user sends a voice message, the agent
 * automatically responds with voice (TTS) — creating a real conversation feel.
 *
 * Usage in any bot:
 *   import { createVoiceResponder } from '../../shared/voice-response.js';
 *   const voiceResponder = createVoiceResponder(bot);
 *   // Then in response delivery:
 *   await voiceResponder.sendResponse(chatId, text, { isVoiceInput: true });
 *
 * Also works with persistent /voice mode (getVoiceMode).
 */

import { getVoiceMode } from './voice-mode.js';
import { prepareBroadcast } from './smart-broadcast.js';
import fs from 'fs';

// Default voice config for auto-reply (when user hasn't explicitly set a voice)
const AUTO_REPLY_CONFIG = {
  voice: 'en-casual',
  textToo: true,   // always send text too for auto-reply
  provider: undefined, // auto-detect (ElevenLabs if available, else Edge)
};

/**
 * Create a voice responder bound to a specific bot instance
 * @param {object} bot - TelegramBot instance
 * @param {object} [options]
 * @param {string} [options.agentName] - Agent name for logging
 * @returns {{ sendResponse: Function }}
 */
export function createVoiceResponder(bot, options = {}) {
  const agentName = options.agentName || 'agent';

  /**
   * Send a response — with voice if appropriate, otherwise text-only
   *
   * Voice is used when:
   * 1. The incoming message was a voice note (isVoiceInput: true) — auto-reply
   * 2. Voice mode is persistently enabled for this chat (via /voice on)
   *
   * @param {string|number} chatId
   * @param {string} text - Response text
   * @param {object} [opts]
   * @param {boolean} [opts.isVoiceInput] - Was the incoming message a voice note?
   * @param {Function} [opts.sendLongMessage] - Fallback text sender (the bot's existing sendLongMessage)
   */
  async function sendResponse(chatId, text, opts = {}) {
    const { isVoiceInput = false, sendLongMessage } = opts;

    // Check if we should respond with voice
    const persistentVoice = getVoiceMode(chatId);
    const shouldVoice = persistentVoice || isVoiceInput;

    if (!shouldVoice || !text || text.length < 5) {
      // No voice — use normal text delivery
      if (sendLongMessage) {
        return sendLongMessage(chatId, text);
      }
      return sendText(bot, chatId, text);
    }

    // Build voice config: use persistent settings if available, else auto-reply defaults
    const voiceConfig = persistentVoice || { ...AUTO_REPLY_CONFIG };

    try {
      console.log(`[voice-response][${agentName}] Preparing voice reply for chat ${chatId}`);

      // Show "recording voice" indicator
      bot.sendChatAction(chatId, 'record_voice').catch(() => {});

      const deliverables = await prepareBroadcast(text, voiceConfig);
      let voiceSent = false;
      let textSent = false;

      for (const item of deliverables) {
        if (item.type === 'voice' && item.audioPath) {
          bot.sendChatAction(chatId, 'upload_voice').catch(() => {});
          try {
            await bot.sendVoice(chatId, item.audioPath);
            voiceSent = true;
          } catch (err) {
            console.error(`[voice-response][${agentName}] sendVoice failed:`, err.message);
          }
          // Clean up temp audio file
          try { fs.unlinkSync(item.audioPath); } catch {}
        } else if (item.type === 'text') {
          if (sendLongMessage) {
            sendLongMessage(chatId, item.content);
          } else {
            await sendText(bot, chatId, item.content);
          }
          textSent = true;
        }
      }

      // If auto-reply and voice was sent but no text was sent, and it's a short message,
      // that's fine — voice-only is good for short replies
      // But if voice failed entirely, fall back to text
      if (!voiceSent && !textSent) {
        console.warn(`[voice-response][${agentName}] Voice broadcast produced nothing, falling back to text`);
        if (sendLongMessage) {
          return sendLongMessage(chatId, text);
        }
        return sendText(bot, chatId, text);
      }

      const voiceCount = deliverables.filter(d => d.type === 'voice').length;
      const textCount = deliverables.filter(d => d.type === 'text').length;
      console.log(`[voice-response][${agentName}] Delivered: ${voiceCount} voice + ${textCount} text segments`);

    } catch (err) {
      console.error(`[voice-response][${agentName}] Voice response failed, falling back to text:`, err.message);
      if (sendLongMessage) {
        return sendLongMessage(chatId, text);
      }
      return sendText(bot, chatId, text);
    }
  }

  return { sendResponse };
}

/**
 * Basic text sender with Markdown fallback (used when bot doesn't provide sendLongMessage)
 */
async function sendText(bot, chatId, text) {
  const MAX = 4096;
  if (!text) return;

  if (text.length <= MAX) {
    try {
      return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      try { return await bot.sendMessage(chatId, text); } catch (e) {
        console.error('[voice-response] Send error:', e.message);
        return null;
      }
    }
  }

  // Split long messages
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await sendText(bot, chatId, remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', MAX);
    if (splitAt < MAX * 0.3) splitAt = remaining.lastIndexOf('\n', MAX);
    if (splitAt < MAX * 0.3) splitAt = MAX;
    await sendText(bot, chatId, remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
    await new Promise(r => setTimeout(r, 300));
  }
}

export default { createVoiceResponder };
