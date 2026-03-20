/**
 * Smart Voice Broadcast — intelligent response delivery for voice mode
 *
 * Instead of dumping the entire response as one voice note, this module:
 * 1. Analyzes the response content type (conversational vs technical)
 * 2. Segments into voice-friendly chunks vs text-only blocks
 * 3. Delivers each segment in the optimal format
 * 4. Handles mixed content (explanation + code) gracefully
 *
 * Delivery strategies:
 * - SHORT conversational (< 300 chars)  → voice only
 * - MEDIUM conversational (300-1500)     → voice + text
 * - LONG conversational (> 1500)         → chunked voice notes + text
 * - TECHNICAL (code, JSON, file paths)   → text only
 * - MIXED (explanation + code)           → voice the explanations, text the code
 */

import textToSpeech, { sanitizeForTTS } from './tts.js';

// Content classification thresholds
const SHORT_THRESHOLD = 300;
const MEDIUM_THRESHOLD = 1500;
const MAX_VOICE_CHUNK = 2500;    // chars per voice note
const MIN_VOICE_CHUNK = 50;      // don't voice tiny fragments

// Patterns that indicate non-voice content
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]{20,}`/g;  // long inline code (short ones are fine to speak)
const FILE_PATH_RE = /(?:^|\s)(\/[\w\-./]+(?:\.\w+)?)/gm;
const JSON_BLOCK_RE = /^\s*[{[]/m;
const URL_RE = /https?:\/\/\S{40,}/g;  // long URLs (short ones get replaced by TTS sanitizer)
const LOG_OUTPUT_RE = /^\s*\[[\w-]+\]\s/m;  // log-style output like [tts] or [bridge]

/**
 * Analyze a response and decide the best delivery strategy
 * @param {string} text - Full response text
 * @returns {{ strategy: string, segments: Array<{type: 'voice'|'text', content: string}> }}
 */
export function analyzeResponse(text) {
  if (!text || !text.trim()) {
    return { strategy: 'empty', segments: [] };
  }

  const trimmed = text.trim();
  const codeBlocks = trimmed.match(CODE_BLOCK_RE) || [];
  const codeRatio = codeBlocks.join('').length / trimmed.length;

  // Pure technical content — don't voice it at all
  if (codeRatio > 0.6 || isFullyTechnical(trimmed)) {
    return {
      strategy: 'text-only',
      segments: [{ type: 'text', content: trimmed }],
    };
  }

  // No code at all — pure conversational
  if (codeBlocks.length === 0 && !hasTechnicalContent(trimmed)) {
    return analyzeConversational(trimmed);
  }

  // Mixed content — split into voice-able and text-only segments
  return analyzeMixed(trimmed);
}

/**
 * Pure conversational response — decide voice delivery based on length
 */
function analyzeConversational(text) {
  if (text.length <= SHORT_THRESHOLD) {
    return {
      strategy: 'voice-only',
      segments: [{ type: 'voice', content: text }],
    };
  }

  if (text.length <= MEDIUM_THRESHOLD) {
    return {
      strategy: 'voice-and-text',
      segments: [{ type: 'voice', content: text }, { type: 'text', content: text }],
    };
  }

  // Long conversational — chunk into multiple voice notes + send full text
  const chunks = chunkText(text, MAX_VOICE_CHUNK);
  const segments = chunks.map(c => ({ type: 'voice', content: c }));
  segments.push({ type: 'text', content: text });

  return { strategy: 'chunked-voice', segments };
}

/**
 * Mixed content — extract conversational parts for voice, keep technical as text
 */
function analyzeMixed(text) {
  const segments = [];
  let voiceBuffer = '';

  // Split by code blocks, keeping track of what's code and what's not
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.match(/^```/)) {
      // Code block — flush any voice buffer first, then add as text
      if (voiceBuffer.trim().length >= MIN_VOICE_CHUNK) {
        segments.push({ type: 'voice', content: voiceBuffer.trim() });
      }
      voiceBuffer = '';
      // Don't add standalone code blocks — they'll be in the full text
    } else if (part.trim()) {
      // Conversational text — accumulate for voice
      voiceBuffer += part;

      // If buffer is getting long, flush it
      if (voiceBuffer.length > MAX_VOICE_CHUNK) {
        const chunks = chunkText(voiceBuffer, MAX_VOICE_CHUNK);
        for (const chunk of chunks) {
          if (chunk.trim().length >= MIN_VOICE_CHUNK) {
            segments.push({ type: 'voice', content: chunk.trim() });
          }
        }
        voiceBuffer = '';
      }
    }
  }

  // Flush remaining voice buffer
  if (voiceBuffer.trim().length >= MIN_VOICE_CHUNK) {
    segments.push({ type: 'voice', content: voiceBuffer.trim() });
  }

  // Always send full text for mixed content (user needs to see code)
  segments.push({ type: 'text', content: text });

  // If no voice segments survived, it was too technical
  if (!segments.some(s => s.type === 'voice')) {
    return { strategy: 'text-only', segments: [{ type: 'text', content: text }] };
  }

  return { strategy: 'mixed', segments };
}

/**
 * Check if text is fully technical (no conversational value in voicing it)
 */
function isFullyTechnical(text) {
  const lines = text.split('\n');
  let technicalLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith('{') || trimmed.startsWith('[') ||
      trimmed.startsWith('//') || trimmed.startsWith('#!') ||
      trimmed.startsWith('import ') || trimmed.startsWith('export ') ||
      trimmed.startsWith('const ') || trimmed.startsWith('let ') ||
      trimmed.startsWith('function ') || trimmed.startsWith('class ') ||
      trimmed.match(/^\w+\(/) ||  // function calls
      trimmed.match(/^\s*[\w.]+\s*=/) ||  // assignments
      LOG_OUTPUT_RE.test(trimmed)
    ) {
      technicalLines++;
    }
  }

  const nonEmptyLines = lines.filter(l => l.trim()).length;
  return nonEmptyLines > 0 && technicalLines / nonEmptyLines > 0.5;
}

/**
 * Check if text has significant technical content mixed in
 */
function hasTechnicalContent(text) {
  return (
    INLINE_CODE_RE.test(text) ||
    URL_RE.test(text) ||
    JSON_BLOCK_RE.test(text) ||
    (text.match(FILE_PATH_RE) || []).length > 3
  );
}

/**
 * Split text into natural chunks at paragraph/sentence boundaries
 */
function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxLen && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }

    // If a single paragraph is too long, split by sentences
    if (current.length > maxLen) {
      const sentences = current.match(/[^.!?]+[.!?]+\s*/g) || [current];
      current = '';
      for (const sentence of sentences) {
        if ((current + sentence).length > maxLen && current) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current += sentence;
        }
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Execute smart broadcast — generates voice files and returns delivery plan
 * @param {string} text - Full response text
 * @param {object} voiceConfig - Voice mode config (from getVoiceMode)
 * @returns {Promise<Array<{type: 'voice'|'text', content: string, audioPath?: string}>>}
 */
export async function prepareBroadcast(text, voiceConfig) {
  const { strategy, segments } = analyzeResponse(text);

  console.log(`[smart-broadcast] Strategy: ${strategy} | Segments: ${segments.length} | Text length: ${text.length}`);

  const deliverables = [];

  for (const seg of segments) {
    if (seg.type === 'voice') {
      try {
        const audioPath = await textToSpeech(seg.content, {
          voice: voiceConfig.voice || 'en-casual',
        });
        deliverables.push({
          type: 'voice',
          content: seg.content,
          audioPath,
        });
      } catch (err) {
        console.error(`[smart-broadcast] TTS failed for segment, converting to text:`, err.message);
        // Fallback: deliver as text
        deliverables.push({ type: 'text', content: seg.content });
      }
    } else {
      deliverables.push({ type: 'text', content: seg.content });
    }
  }

  return deliverables;
}

export default { analyzeResponse, prepareBroadcast };
