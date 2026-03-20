/**
 * ElevenLabs TTS Provider — high-quality text-to-speech
 *
 * Uses ElevenLabs API for natural-sounding voice synthesis.
 * Supports voice settings (stability, similarity, style) and
 * multiple models (Flash v2.5 for speed, Multilingual v2 for quality).
 *
 * Requires: ELEVENLABS_API_KEY in environment or user config
 */

import { writeFile, unlink, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import paths from './paths.js';

const execAsync = promisify(exec);

// --- Models ---
// Flash v2.5: low latency (~75ms), 32 languages, up to 40k chars
// Multilingual v2: highest quality, 29 languages, up to 10k chars
// V3: newest, 70+ languages, 5k chars, supports emotion tags
const MODELS = {
  'flash':        'eleven_flash_v2_5',
  'quality':      'eleven_multilingual_v2',
  'v3':           'eleven_v3',
};
const DEFAULT_MODEL = 'flash';

// --- Voice presets mapped to ElevenLabs voice IDs ---
// These are curated ElevenLabs voices that sound natural
const VOICES = {
  // Male voices
  'adam':       { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',      desc: 'Deep, warm American male' },
  'josh':       { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',      desc: 'Conversational young male' },
  'daniel':     { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel',    desc: 'British authoritative male' },
  'marcus':     { id: 'IdkGFuOA97uOcGMWJl7I', name: 'Marcus',    desc: 'Warm professional male' },
  'chris':      { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris',     desc: 'Casual American male' },
  'brian':      { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian',     desc: 'Deep narrator male' },
  'george':     { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George',    desc: 'Warm British male' },

  // Female voices
  'rachel':     { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',    desc: 'Calm, clear American female' },
  'sarah':      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah',    desc: 'Soft-spoken young female' },
  'emily':      { id: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily',    desc: 'Conversational female' },
  'charlotte':  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', desc: 'Elegant British female' },
  'jessica':    { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica',   desc: 'Warm expressive female' },
  'lily':       { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily',      desc: 'Warm British female' },
  'aria':       { id: '9BWtsMINqrJLrRacOk9x', name: 'Aria',      desc: 'Expressive American female' },
};

const DEFAULT_VOICE = 'josh';

// --- Default voice settings ---
// Tuned for natural, warm conversational delivery (ElevenLabs-quality)
const DEFAULT_SETTINGS = {
  stability: 0.45,          // 0-1: slightly lower for more expressiveness and natural variation
  similarity_boost: 0.78,   // 0-1: high fidelity without reproducing artifacts
  style: 0.0,               // 0-1: disabled — reduces latency with negligible quality loss
  use_speaker_boost: true,  // subtle clarity enhancement
  speed: 0.95,              // 0.7-1.2: slightly slower for a more thoughtful, unhurried cadence
};

/**
 * Generate speech using ElevenLabs API
 * @param {string} text - Text to speak
 * @param {object} [options]
 * @param {string} [options.voice] - Voice preset key or raw voice ID
 * @param {string} [options.model] - Model key: 'flash', 'quality', or 'v3'
 * @param {string} [options.outputDir] - Where to save the audio
 * @param {object} [options.settings] - Voice settings overrides
 * @returns {Promise<string>} Path to the generated OGG audio file
 */
export async function elevenLabsTTS(text, options = {}) {
  const {
    voice = DEFAULT_VOICE,
    model = DEFAULT_MODEL,
    outputDir = tmpdir(),
    settings = {},
  } = options;

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('ElevenLabs API key not configured. Set ELEVENLABS_API_KEY env var or add to user/config.json');
  }

  // Resolve voice ID
  const voiceEntry = VOICES[voice];
  const voiceId = voiceEntry ? voiceEntry.id : voice; // allow raw voice ID passthrough

  // Resolve model
  const modelId = MODELS[model] || model;

  // Prepare text with prosody hints for natural speech
  const processedText = preprocessForElevenLabs(text, model);
  if (!processedText) {
    throw new Error('No speakable text after preprocessing');
  }

  // Merge settings
  const voiceSettings = { ...DEFAULT_SETTINGS, ...settings };

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const timestamp = Date.now();
  const mp3Path = join(outputDir, `tts-11labs-${timestamp}.mp3`);
  const oggPath = join(outputDir, `tts-11labs-${timestamp}.ogg`);

  const startTime = Date.now();
  const voiceName = voiceEntry ? voiceEntry.name : voice;
  console.log(`[tts-11labs] Generating (${voiceName}/${model}): "${processedText.slice(0, 80)}..."`);

  try {
    // Call ElevenLabs API
    const audioBuffer = await callElevenLabsAPI(voiceId, modelId, processedText, voiceSettings, apiKey);

    // Write MP3
    await writeFile(mp3Path, audioBuffer);

    // Convert to OGG Opus for Telegram with broadcast-quality audio processing:
    //   1. High-pass: remove sub-bass rumble below 80Hz
    //   2. EQ: boost low-mids (250Hz) for warmth, cut mud (500Hz), presence boost (3kHz)
    //   3. Compressor: even out dynamics so whispers and emphasis are both clear
    //   4. Loudnorm: broadcast-standard loudness targeting -16 LUFS
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

    // Cleanup MP3
    try { await unlink(mp3Path); } catch {}

    if (!existsSync(oggPath)) {
      throw new Error('ffmpeg OGG conversion produced no output');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[tts-11labs] Done (${elapsed}s): ${oggPath}`);

    return oggPath;
  } catch (err) {
    try { await unlink(mp3Path); } catch {}
    try { await unlink(oggPath); } catch {}
    throw new Error(`ElevenLabs TTS failed: ${err.message}`);
  }
}

/**
 * Call the ElevenLabs text-to-speech API
 */
function callElevenLabsAPI(voiceId, modelId, text, voiceSettings, apiKey) {
  return new Promise((resolve, reject) => {
    // Build request body with model-specific enhancements
    const requestBody = {
      text,
      model_id: modelId,
      voice_settings: voiceSettings,
    };

    // Enable text normalization for Flash model (disabled by default in Flash v2.5)
    if (modelId === 'eleven_flash_v2_5') {
      requestBody.apply_text_normalization = 'on';
    }

    const body = JSON.stringify(requestBody);

    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60_000,
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', chunk => errBody += chunk);
        res.on('end', () => {
          reject(new Error(`ElevenLabs API ${res.statusCode}: ${errBody}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ElevenLabs API request timed out'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Preprocess text for ElevenLabs — add prosody hints for natural speech
 * Different strategies based on model capabilities
 *
 * Enhanced pipeline:
 *   1. Strip markdown/formatting
 *   2. Expand abbreviations & numbers for natural pronunciation
 *   3. Model-specific prosody enhancement (SSML breaks / V3 emotion tags)
 *   4. Sentence rhythm variation for organic speech flow
 *   5. Final cleanup
 */
export function preprocessForElevenLabs(rawText, model = 'flash') {
  let text = rawText
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '. ')
    // Remove inline code but keep words
    .replace(/`([^`]+)`/g, '$1')
    // Remove markdown headers — keep as topic shifts
    .replace(/^#{1,6}\s+(.+)$/gm, '$1.')
    // Remove bold/italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove markdown links — keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove raw URLs
    .replace(/https?:\/\/\S+/g, '')
    // Remove emoji
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');

  // Expand abbreviations and normalize text for natural pronunciation
  text = expandAbbreviations(text);
  text = normalizeNumbersForSpeech(text);

  if (model === 'v3') {
    // V3 supports emotion tags — enhance prosody naturally
    text = enhanceForV3(text);
  } else {
    // Flash/Multilingual — use SSML break tags for precise pauses
    text = enhanceWithSSML(text);
  }

  // Final cleanup
  text = text
    .replace(/\n\s*\n+/g, '. ')    // paragraph breaks → pause
    .replace(/\n/g, ', ')           // line breaks → short pause
    .replace(/^[,.\s]+/, '')        // clean start
    .replace(/\s+\./g, '.')         // fix spacing before periods
    .replace(/\.\s*\./g, '.')       // remove double periods
    .replace(/([.!?])\s*[,.]+/g, '$1 ')
    .replace(/,\s*[,.]+/g, ', ')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Ensure clean ending
  if (text && !/[.!?]$/.test(text)) {
    text += '.';
  }

  // Model-specific char limits
  const maxChars = model === 'v3' ? 4500 : model === 'quality' ? 9000 : 35000;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '... message truncated.';
  }

  return text;
}

// --- Abbreviation Expansion ---
// Common abbreviations that TTS engines mispronounce or rush through
const ABBREVIATIONS = {
  'API':    'A P I',
  'APIs':   'A P Is',
  'CLI':    'C L I',
  'UI':     'U I',
  'UX':     'U X',
  'URL':    'U R L',
  'URLs':   'U R Ls',
  'CSS':    'C S S',
  'HTML':   'H T M L',
  'JSON':   'jason',
  'JS':     'javascript',
  'TS':     'typescript',
  'DB':     'database',
  'SQL':    'sequel',
  'AWS':    'A W S',
  'GCP':    'G C P',
  'SSH':    'S S H',
  'TLS':    'T L S',
  'SSL':    'S S L',
  'DNS':    'D N S',
  'PR':     'pull request',
  'PRs':    'pull requests',
  'e.g.':   'for example',
  'i.e.':   'that is',
  'vs':     'versus',
  'etc':    'etcetera',
  'approx': 'approximately',
  'env':    'environment',
  'config': 'configuration',
  'configs': 'configurations',
  'repo':   'repository',
  'repos':  'repositories',
  'dev':    'development',
  'devs':   'developers',
  'docs':   'documentation',
  'OGG':    'ogg',
  'MP3':    'M P 3',
  'TTS':    'text to speech',
  'AI':     'A I',
  'ML':     'machine learning',
  'npm':    'N P M',
  'SDK':    'S D K',
  'IDE':    'I D E',
  'CPU':    'C P U',
  'GPU':    'G P U',
  'RAM':    'ram',
  'SSD':    'S S D',
  'HTTPS':  'H T T P S',
  'HTTP':   'H T T P',
  'CORS':   'cors',
  'JWT':    'J W T',
  'OAuth':  'oh-auth',
  'YAML':   'yammel',
  'XML':    'X M L',
  'PDF':    'P D F',
  'CSV':    'C S V',
  'CRUD':   'crud',
  'CI/CD':  'C I C D',
  'TLDR':   'T L D R',
  'TL;DR':  'T L D R',
  'ASAP':   'A S A P',
  'FYI':    'F Y I',
  'ETA':    'E T A',
  'iOS':    'I O S',
  'CMD':    'command',
};

/**
 * Expand abbreviations for natural pronunciation
 */
function expandAbbreviations(text) {
  // Word-boundary-aware replacement for standalone abbreviations
  for (const [abbr, expansion] of Object.entries(ABBREVIATIONS)) {
    // Escape special regex characters in the abbreviation
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'g');
    text = text.replace(regex, expansion);
  }
  return text;
}

/**
 * Normalize numbers and currency for natural speech
 * "$1,000" → "one thousand dollars", "v2.1" → "version 2 point 1"
 */
function normalizeNumbersForSpeech(text) {
  // Currency: $X → X dollars
  text = text.replace(/\$(\d[\d,]*\.?\d*)\s*(million|billion|trillion|k|m|b)?/gi, (_, num, suffix) => {
    const cleaned = num.replace(/,/g, '');
    const suffixMap = { k: 'thousand', m: 'million', b: 'billion' };
    const unit = suffix ? (suffixMap[suffix.toLowerCase()] || suffix) : '';
    return `${cleaned} ${unit} dollars`.trim();
  });

  // Version numbers: v2.1 → version 2 point 1
  text = text.replace(/\bv(\d+)\.(\d+)(?:\.(\d+))?\b/gi, (_, major, minor, patch) => {
    let result = `version ${major} point ${minor}`;
    if (patch) result += ` point ${patch}`;
    return result;
  });

  // Percentages: 50% → 50 percent
  text = text.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');

  // File sizes: 64k → 64 K, 2MB → 2 megabytes
  text = text.replace(/(\d+)\s*KB/gi, '$1 kilobytes');
  text = text.replace(/(\d+)\s*MB/gi, '$1 megabytes');
  text = text.replace(/(\d+)\s*GB/gi, '$1 gigabytes');
  text = text.replace(/(\d+)\s*TB/gi, '$1 terabytes');

  // Time durations: 30s → 30 seconds, 5m → 5 minutes, 2h → 2 hours
  text = text.replace(/\b(\d+)\s*ms\b/g, '$1 milliseconds');
  text = text.replace(/\b(\d+)\s*s\b/g, '$1 seconds');

  return text;
}

/**
 * Enhance text with V3 emotion/audio tags for natural delivery
 * V3 understands: [sigh], [pause], [short pause], [long pause],
 * [whispers], [excited], [sarcastic], [crying], [laughs]
 */
function enhanceForV3(text) {
  text = text
    // List items → natural spoken list with pauses
    .replace(/^[\t ]*[-*•]\s+/gm, '[short pause] ')
    .replace(/^[\t ]*\d+[.)]\s+/gm, '[short pause] ')
    // Colons get a beat before explanation
    .replace(/:\s*\n/g, ': [pause] ')
    // Topic shifts get longer pauses
    .replace(/\n\s*\n/g, '. [long pause] ')
    // Exclamation-heavy text gets subtle excitement
    .replace(/!{2,}/g, '! [excited] ')
    // Question marks get natural inquisitive tone from punctuation — no tag needed
    // Parenthetical asides → whispered for natural conversational feel
    .replace(/\(([^)]{5,60})\)/g, '[whispers] $1 [pause]');

  // Add breathing pauses for long sentences
  const sentences = text.split(/(?<=[.!?])\s+/);
  const enhanced = sentences.map(s => {
    if (s.length > 120) {
      const midComma = s.indexOf(',', Math.floor(s.length * 0.3));
      if (midComma > 0 && midComma < s.length * 0.7) {
        return s.slice(0, midComma + 1) + ' [short pause]' + s.slice(midComma + 1);
      }
    }
    return s;
  });

  return enhanced.join(' ');
}

/**
 * Enhance text with SSML break tags for Flash/Multilingual models
 * These models support <break time="Xs" /> for precise pauses up to 3 seconds.
 * Produces much more natural speech than imprecise ellipses.
 */
function enhanceWithSSML(text) {
  text = text
    // List items → spoken with clear pauses between items
    .replace(/^[\t ]*[-*•]\s+/gm, '<break time="0.3s" /> ')
    .replace(/^[\t ]*\d+[.)]\s+/gm, '<break time="0.3s" /> ')
    // Colon followed by content → beat before the explanation
    .replace(/:\s*\n/g, ': <break time="0.5s" /> ')
    // Topic shifts (double newlines) → longer pause
    .replace(/\n\s*\n/g, '. <break time="0.6s" /> ');

  // Split into sentences and add natural breathing rhythm
  const sentences = text.split(/(?<=[.!?])\s+/);
  const breathBreaks = ['0.2s', '0.3s', '0.4s']; // vary for organic rhythm
  let breakIdx = 0;

  const enhanced = sentences.map((s, i) => {
    // For long sentences, add a breath-like pause at a natural clause boundary
    if (s.length > 120) {
      // Try to break at conjunctions first, then commas
      const conjunctionBreak = s.search(/\b(and|but|however|so|then|because|although|while|yet)\b/i);
      if (conjunctionBreak > s.length * 0.25 && conjunctionBreak < s.length * 0.75) {
        const breakPoint = s.indexOf(' ', conjunctionBreak);
        if (breakPoint > 0) {
          s = s.slice(0, breakPoint) + ` <break time="${breathBreaks[breakIdx % 3]}" />` + s.slice(breakPoint);
          breakIdx++;
        }
      } else {
        // Fall back to mid-comma
        const midComma = s.indexOf(',', Math.floor(s.length * 0.3));
        if (midComma > 0 && midComma < s.length * 0.7) {
          s = s.slice(0, midComma + 1) + ` <break time="${breathBreaks[breakIdx % 3]}" />` + s.slice(midComma + 1);
          breakIdx++;
        }
      }
    }

    // Add a small inter-sentence pause (varies to avoid robotic rhythm)
    if (i < sentences.length - 1 && i > 0) {
      const pause = breathBreaks[breakIdx % 3];
      breakIdx++;
      return s + ` <break time="${pause}" />`;
    }
    return s;
  });

  return enhanced.join(' ');
}

/**
 * Get ElevenLabs API key from environment or user config
 */
async function getApiKey() {
  // Check environment first
  if (process.env.ELEVENLABS_API_KEY) {
    return process.env.ELEVENLABS_API_KEY;
  }

  // Check user config
  try {
    const configPath = paths.config;
    if (existsSync(configPath)) {
      const config = JSON.parse(await readFile(configPath, 'utf-8'));
      if (config.elevenlabs?.apiKey) return config.elevenlabs.apiKey;
      if (config.tts?.elevenlabs?.apiKey) return config.tts.elevenlabs.apiKey;
    }
  } catch {}

  return null;
}

/**
 * Check if ElevenLabs is available (API key configured)
 */
export async function isAvailable() {
  const key = await getApiKey();
  return !!key;
}

/**
 * Get available voice presets
 */
export function getVoicePresets() {
  return Object.entries(VOICES).map(([key, v]) => ({
    key,
    name: v.name,
    description: v.desc,
  }));
}

/**
 * Get available models
 */
export function getModels() {
  return Object.entries(MODELS).map(([key, id]) => ({ key, id }));
}

export default elevenLabsTTS;
