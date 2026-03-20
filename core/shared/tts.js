/**
 * Text-to-Speech module using Microsoft Edge TTS (free, no API key)
 * Converts text responses to OGG Opus audio for Telegram voice messages
 *
 * Requires: edge-tts (pip), ffmpeg (for OGG conversion)
 */

import { execFile, exec } from 'child_process';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const EDGE_TTS_BIN = 'edge-tts';
const TIMEOUT_MS = 60_000; // 60 seconds max for TTS generation

// Voice presets — curated for natural conversation
const VOICES = {
  // English
  'en-male':    'en-US-GuyNeural',
  'en-female':  'en-US-JennyNeural',
  'en-casual':  'en-US-ChristopherNeural',
  // Arabic (Egyptian dialect for Tamer)
  'ar-male':    'ar-EG-ShakirNeural',
  'ar-female':  'ar-EG-SalmaNeural',
  // British
  'en-gb-male':   'en-GB-RyanNeural',
  'en-gb-female': 'en-GB-SoniaNeural',
};

const DEFAULT_VOICE = 'en-US-ChristopherNeural';

// Telegram voice messages must be OGG Opus
const OUTPUT_FORMAT = 'ogg';

/**
 * Convert text to a voice audio file (OGG Opus for Telegram)
 * @param {string} text - Text to speak
 * @param {object} [options] - Options
 * @param {string} [options.voice] - Voice preset key or full voice name
 * @param {string} [options.outputDir] - Where to save the file (defaults to tmpdir)
 * @param {string} [options.rate] - Speech rate, e.g. '+10%', '-20%' (default: '+0%')
 * @param {string} [options.pitch] - Pitch adjustment, e.g. '+5Hz', '-10Hz' (default: '+0Hz')
 * @returns {Promise<string>} Path to the generated OGG audio file
 */
export async function textToSpeech(text, options = {}) {
  const {
    voice = 'en-casual',
    outputDir = tmpdir(),
    rate = '+0%',
    pitch = '+0Hz',
  } = options;

  // Resolve voice name from preset or use raw name
  const voiceName = VOICES[voice] || voice;

  // Sanitize text for TTS — strip markdown, limit length
  const cleanText = sanitizeForTTS(text);
  if (!cleanText) {
    throw new Error('No speakable text after sanitization');
  }

  // Truncate very long text (TTS becomes impractical after ~3000 chars)
  const MAX_TTS_CHARS = 3000;
  const speakText = cleanText.length > MAX_TTS_CHARS
    ? cleanText.slice(0, MAX_TTS_CHARS) + '... (message truncated for voice)'
    : cleanText;

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const timestamp = Date.now();
  const mp3Path = join(outputDir, `tts-${timestamp}.mp3`);
  const oggPath = join(outputDir, `tts-${timestamp}.ogg`);

  const startTime = Date.now();
  console.log(`[tts] Generating (${voiceName}): "${speakText.slice(0, 80)}..."`);

  try {
    // Step 1: Generate MP3 with edge-tts
    await execFileAsync(EDGE_TTS_BIN, [
      '--voice', voiceName,
      '--rate', rate,
      '--pitch', pitch,
      '--text', speakText,
      '--write-media', mp3Path,
    ], { timeout: TIMEOUT_MS });

    if (!existsSync(mp3Path)) {
      throw new Error('edge-tts produced no output file');
    }

    // Step 2: Convert MP3 → OGG Opus (Telegram voice format)
    await execAsync(
      `ffmpeg -y -i "${mp3Path}" -c:a libopus -b:a 64k -vbr on -compression_level 10 -application voip "${oggPath}"`,
      { timeout: 30_000 }
    );

    // Clean up intermediate MP3
    try { unlinkSync(mp3Path); } catch {}

    if (!existsSync(oggPath)) {
      throw new Error('ffmpeg OGG conversion produced no output');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[tts] Done (${elapsed}s): ${oggPath}`);

    return oggPath;
  } catch (err) {
    // Clean up partial files
    try { unlinkSync(mp3Path); } catch {}
    try { unlinkSync(oggPath); } catch {}
    throw new Error(`TTS generation failed: ${err.message}`);
  }
}

/**
 * Strip markdown and special formatting so TTS reads naturally
 */
export function sanitizeForTTS(text) {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    // Remove inline code
    .replace(/`[^`]+`/g, (match) => match.slice(1, -1))
    // Remove markdown bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove markdown links — keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove raw URLs (they sound terrible in TTS)
    .replace(/https?:\/\/\S+/g, '(link)')
    // Remove bullet markers
    .replace(/^[-*•]\s+/gm, '')
    // Remove emoji (optional — some TTS handles them, but most don't)
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get available voice presets
 */
export function getVoicePresets() {
  return { ...VOICES };
}

/**
 * List all available edge-tts voices (async, calls edge-tts CLI)
 */
export async function listVoices(filter) {
  try {
    const { stdout } = await execFileAsync(EDGE_TTS_BIN, ['--list-voices'], { timeout: 10_000 });
    const lines = stdout.split('\n').filter(l => l.trim());
    if (filter) {
      return lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
    }
    return lines;
  } catch (err) {
    throw new Error(`Failed to list voices: ${err.message}`);
  }
}

export default textToSpeech;
