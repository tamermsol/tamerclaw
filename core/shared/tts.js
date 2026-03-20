/**
 * Text-to-Speech — multi-provider router
 *
 * Supports multiple TTS engines:
 *   - 'elevenlabs' — High-quality ElevenLabs voices (requires API key)
 *   - 'edge'       — Free Microsoft Edge TTS (fallback, no API key needed)
 *
 * The active provider is selected per-chat via voice-mode settings,
 * or defaults to ElevenLabs if available, Edge TTS otherwise.
 *
 * Requires: edge-tts (pip), ffmpeg, optionally ELEVENLABS_API_KEY
 */

import { execFile, exec } from 'child_process';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { elevenLabsTTS, isAvailable as elevenLabsAvailable, getVoicePresets as getElevenLabsPresets, preprocessForElevenLabs } from './tts-elevenlabs.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const EDGE_TTS_BIN = 'edge-tts';
const TIMEOUT_MS = 60_000;

// --- Edge TTS voice presets ---
const EDGE_VOICES = {
  'en-male':      'en-US-GuyNeural',
  'en-female':    'en-US-JennyNeural',
  'en-casual':    'en-US-GuyNeural',
  'en-sharp':     'en-US-ChristopherNeural',
  'ar-male':      'ar-EG-ShakirNeural',
  'ar-female':    'ar-EG-SalmaNeural',
  'en-gb-male':   'en-GB-RyanNeural',
  'en-gb-female': 'en-GB-SoniaNeural',
};

const DEFAULT_EDGE_VOICE = 'en-US-GuyNeural';

/**
 * Convert text to a voice audio file (OGG Opus for Telegram)
 *
 * Auto-selects provider:
 *   1. If options.provider is set, use that
 *   2. If ElevenLabs API key is configured, use ElevenLabs
 *   3. Otherwise fall back to Edge TTS
 *
 * @param {string} text - Text to speak
 * @param {object} [options]
 * @param {string} [options.provider] - 'elevenlabs' or 'edge' (auto-detect if omitted)
 * @param {string} [options.voice] - Voice preset key
 * @param {string} [options.model] - ElevenLabs model: 'flash', 'quality', 'v3'
 * @param {string} [options.outputDir] - Where to save the file
 * @param {string} [options.rate] - Edge TTS speech rate
 * @param {string} [options.pitch] - Edge TTS pitch adjustment
 * @param {object} [options.settings] - ElevenLabs voice settings overrides
 * @returns {Promise<string>} Path to generated OGG audio file
 */
export async function textToSpeech(text, options = {}) {
  const provider = await resolveProvider(options.provider);

  if (provider === 'elevenlabs') {
    try {
      return await elevenLabsTTS(text, {
        voice: options.voice || 'josh',
        model: options.model || 'flash',
        outputDir: options.outputDir,
        settings: options.settings,
      });
    } catch (err) {
      console.warn(`[tts] ElevenLabs failed, falling back to Edge TTS: ${err.message}`);
      return await edgeTTS(text, options);
    }
  }

  return await edgeTTS(text, options);
}

/**
 * Edge TTS — free Microsoft neural voices (fallback provider)
 */
async function edgeTTS(text, options = {}) {
  const {
    voice = 'en-casual',
    outputDir = tmpdir(),
    rate = '-5%',
    pitch = '-2Hz',
  } = options;

  const voiceName = EDGE_VOICES[voice] || voice;
  const cleanText = sanitizeForTTS(text);
  if (!cleanText) throw new Error('No speakable text after sanitization');

  const MAX_TTS_CHARS = 3000;
  const speakText = cleanText.length > MAX_TTS_CHARS
    ? cleanText.slice(0, MAX_TTS_CHARS) + '... (message truncated for voice)'
    : cleanText;

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const timestamp = Date.now();
  const mp3Path = join(outputDir, `tts-${timestamp}.mp3`);
  const oggPath = join(outputDir, `tts-${timestamp}.ogg`);

  const startTime = Date.now();
  console.log(`[tts-edge] Generating (${voiceName}): "${speakText.slice(0, 80)}..."`);

  try {
    await execFileAsync(EDGE_TTS_BIN, [
      '--voice', voiceName,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      '--text', speakText,
      '--write-media', mp3Path,
    ], { timeout: TIMEOUT_MS });

    if (!existsSync(mp3Path)) throw new Error('edge-tts produced no output file');

    // Enhanced audio pipeline: warmth EQ, compression, loudness normalization
    const audioFilters = [
      'highpass=f=80',
      'equalizer=f=250:t=q:w=1.5:g=2',
      'equalizer=f=500:t=q:w=2:g=-1',
      'equalizer=f=3000:t=q:w=1.5:g=1.5',
      'acompressor=threshold=0.03:ratio=4:attack=5:release=100:makeup=2',
      'loudnorm=I=-16:LRA=11:TP=-1.5',
    ].join(',');
    await execAsync(
      `ffmpeg -y -i "${mp3Path}" -af "${audioFilters}" -c:a libopus -b:a 64k -vbr on -compression_level 10 -application voip "${oggPath}"`,
      { timeout: 30_000 }
    );

    try { unlinkSync(mp3Path); } catch {}
    if (!existsSync(oggPath)) throw new Error('ffmpeg OGG conversion produced no output');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[tts-edge] Done (${elapsed}s): ${oggPath}`);
    return oggPath;
  } catch (err) {
    try { unlinkSync(mp3Path); } catch {}
    try { unlinkSync(oggPath); } catch {}
    throw new Error(`Edge TTS failed: ${err.message}`);
  }
}

/**
 * Determine which provider to use
 */
async function resolveProvider(explicit) {
  if (explicit === 'elevenlabs' || explicit === 'edge') return explicit;

  // Auto: prefer ElevenLabs if configured
  if (await elevenLabsAvailable()) return 'elevenlabs';
  return 'edge';
}

/**
 * Strip markdown and special formatting for natural TTS reading
 */
export function sanitizeForTTS(text) {
  let result = text
    .replace(/```[\s\S]*?```/g, '. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+(.+)$/gm, '$1.')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '(link)')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/^[\t ]*[-*•]\s+/gm, '\n')
    .replace(/^[\t ]*\d+[.)]\s+/gm, '\n')
    .replace(/:\s*\n\s*\n/g, '. ... ')
    .replace(/:\s*\n/g, ': ... ')
    .replace(/\n\s*\n+/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/^[,.\s]+/, '')
    .replace(/\s+\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/([.!?])\s*[,.]+/g, '$1 ')
    .replace(/,\s*[,.]+/g, ', ')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (result && !/[.!?]$/.test(result)) {
    result += '.';
  }

  return result;
}

/**
 * Get all available voice presets across providers
 */
export function getVoicePresets() {
  return {
    edge: { ...EDGE_VOICES },
    elevenlabs: getElevenLabsPresets(),
  };
}

/**
 * List all available edge-tts voices
 */
export async function listVoices(filter) {
  try {
    const { stdout } = await execFileAsync(EDGE_TTS_BIN, ['--list-voices'], { timeout: 10_000 });
    const lines = stdout.split('\n').filter(l => l.trim());
    if (filter) return lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
    return lines;
  } catch (err) {
    throw new Error(`Failed to list voices: ${err.message}`);
  }
}

/**
 * Get the currently active provider name
 */
export async function getActiveProvider() {
  return await resolveProvider();
}

export default textToSpeech;
