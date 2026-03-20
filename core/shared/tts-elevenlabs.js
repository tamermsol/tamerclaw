/**
 * ElevenLabs TTS Provider — broadcast-quality text-to-speech
 *
 * Enhanced with techniques from ElevenLabs' production pipeline:
 *   - Streaming API for faster first-byte latency
 *   - Context continuity (previous_text/next_text) for natural chunk transitions
 *   - Adaptive voice settings per content type
 *   - Professional audio pipeline (de-essing, warmth, presence, air)
 *   - Pronunciation dictionary for domain-specific terms
 *   - Sentence-level prosody control
 *   - Retry with exponential backoff
 *
 * Requires: ELEVENLABS_API_KEY in environment or user config
 */

import { writeFile, unlink, readFile } from 'fs/promises';
import { existsSync, mkdirSync, createWriteStream } from 'fs';
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

// --- Adaptive voice settings ---
// ElevenLabs key insight: different content types need different voice parameters
// Lower stability = more expressiveness, higher = more consistent
const VOICE_PROFILES = {
  // Default conversational — natural and warm
  default: {
    stability: 0.45,
    similarity_boost: 0.78,
    style: 0.15,               // slight style exaggeration for personality
    use_speaker_boost: true,
    speed: 0.95,
  },
  // Questions — slightly more animated, rising intonation works better with lower stability
  question: {
    stability: 0.38,
    similarity_boost: 0.75,
    style: 0.20,
    use_speaker_boost: true,
    speed: 0.93,
  },
  // Explanations/teaching — clearer, more measured
  explanation: {
    stability: 0.52,
    similarity_boost: 0.80,
    style: 0.10,
    use_speaker_boost: true,
    speed: 0.90,
  },
  // Short/casual — more expressive and natural
  casual: {
    stability: 0.35,
    similarity_boost: 0.72,
    style: 0.25,
    use_speaker_boost: true,
    speed: 1.0,
  },
  // Lists/instructions — clear and paced
  instructional: {
    stability: 0.55,
    similarity_boost: 0.82,
    style: 0.05,
    use_speaker_boost: true,
    speed: 0.88,
  },
};

// --- Pronunciation Dictionary ---
// Domain-specific words that ElevenLabs might mispronounce
// Format: { pattern: RegExp, replacement: string }
// Uses phonetic spellings that TTS engines handle correctly
const PRONUNCIATION_DICT = [
  // Product/brand names
  { pattern: /\bTamerClaw\b/g, replacement: 'Tamer Claw' },
  { pattern: /\bNginx\b/gi, replacement: 'engine-X' },
  { pattern: /\bKubernetes\b/gi, replacement: 'koo-ber-net-eez' },
  { pattern: /\bPostgreSQL\b/gi, replacement: 'post-gress' },
  { pattern: /\bMySQL\b/gi, replacement: 'my sequel' },
  { pattern: /\bRedis\b/gi, replacement: 'reddis' },
  { pattern: /\bLinux\b/gi, replacement: 'Linux' },
  { pattern: /\bsudo\b/g, replacement: 'sue-doh' },
  { pattern: /\bgit\b/g, replacement: 'git' },
  { pattern: /\bGithub\b/gi, replacement: 'git hub' },
  { pattern: /\bDocker\b/gi, replacement: 'Docker' },
  { pattern: /\bwebpack\b/gi, replacement: 'web pack' },
  { pattern: /\bVite\b/g, replacement: 'veet' },
  { pattern: /\bSvelte\b/gi, replacement: 'svelt' },
  { pattern: /\bNextjs\b/gi, replacement: 'Next J S' },
  { pattern: /\bNext\.js\b/gi, replacement: 'Next J S' },
  { pattern: /\bNode\.js\b/gi, replacement: 'Node J S' },
  { pattern: /\bVue\.js\b/gi, replacement: 'View J S' },
  { pattern: /\bReact\b/g, replacement: 'React' },
  { pattern: /\bTypeScript\b/gi, replacement: 'TypeScript' },
  { pattern: /\btypeof\b/g, replacement: 'type of' },
  { pattern: /\basync\b/g, replacement: 'a-sink' },
  { pattern: /\bawait\b/g, replacement: 'a-wait' },
  { pattern: /\bconst\b/g, replacement: 'const' },
  { pattern: /\bboolean\b/gi, replacement: 'boolean' },
  { pattern: /\bnull\b/g, replacement: 'null' },
  { pattern: /\bundefined\b/g, replacement: 'undefined' },
  { pattern: /\bregex\b/gi, replacement: 'rej-ex' },
  { pattern: /\bregexp\b/gi, replacement: 'rej-exp' },
  { pattern: /\bCLI\b/g, replacement: 'C L I' },

  // Technical paths/symbols spoken naturally
  { pattern: /\b\/etc\//g, replacement: 'etsy slash ' },
  { pattern: /\b\/tmp\//g, replacement: 'temp slash ' },
  { pattern: /\b\/var\//g, replacement: 'var slash ' },
  { pattern: /\b\/root\//g, replacement: 'root slash ' },
  { pattern: /stdin\b/gi, replacement: 'standard in' },
  { pattern: /stdout\b/gi, replacement: 'standard out' },
  { pattern: /stderr\b/gi, replacement: 'standard error' },

  // Common mispronounced tech terms
  { pattern: /\bcharset\b/gi, replacement: 'character set' },
  { pattern: /\bdeque\b/gi, replacement: 'deck' },
  { pattern: /\benum\b/gi, replacement: 'ee-num' },
  { pattern: /\bchar\b/g, replacement: 'care' },
  { pattern: /\blatex\b/gi, replacement: 'lay-tech' },
  { pattern: /\bGIF\b/g, replacement: 'gif' },
  { pattern: /\bSaaS\b/g, replacement: 'sass' },
  { pattern: /\bPaaS\b/g, replacement: 'pass' },
  { pattern: /\bIaaS\b/g, replacement: 'eye-ass' },
];

/**
 * Generate speech using ElevenLabs API with streaming + enhanced pipeline
 * @param {string} text - Text to speak
 * @param {object} [options]
 * @param {string} [options.voice] - Voice preset key or raw voice ID
 * @param {string} [options.model] - Model key: 'flash', 'quality', or 'v3'
 * @param {string} [options.outputDir] - Where to save the audio
 * @param {object} [options.settings] - Voice settings overrides
 * @param {string} [options.previousText] - Previous chunk text for context continuity
 * @param {string} [options.nextText] - Next chunk text for context continuity
 * @param {boolean} [options.stream] - Use streaming API (default: true for flash)
 * @returns {Promise<string>} Path to the generated OGG audio file
 */
export async function elevenLabsTTS(text, options = {}) {
  const {
    voice = DEFAULT_VOICE,
    model = DEFAULT_MODEL,
    outputDir = tmpdir(),
    settings = {},
    previousText = null,
    nextText = null,
  } = options;

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('ElevenLabs API key not configured. Set ELEVENLABS_API_KEY env var or add to user/config.json');
  }

  // Resolve voice ID
  const voiceEntry = VOICES[voice];
  const voiceId = voiceEntry ? voiceEntry.id : voice;

  // Resolve model
  const modelId = MODELS[model] || model;

  // Prepare text with full enhancement pipeline
  const processedText = preprocessForElevenLabs(text, model);
  if (!processedText) {
    throw new Error('No speakable text after preprocessing');
  }

  // Detect content type and select adaptive voice profile
  const contentType = detectContentType(text);
  const baseProfile = VOICE_PROFILES[contentType] || VOICE_PROFILES.default;
  const voiceSettings = { ...baseProfile, ...settings };

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const timestamp = Date.now();
  const mp3Path = join(outputDir, `tts-11labs-${timestamp}.mp3`);
  const oggPath = join(outputDir, `tts-11labs-${timestamp}.ogg`);

  const startTime = Date.now();
  const voiceName = voiceEntry ? voiceEntry.name : voice;
  console.log(`[tts-11labs] Generating (${voiceName}/${model}/${contentType}): "${processedText.slice(0, 80)}..."`);

  try {
    // Use streaming API for flash model (faster first-byte), standard for others
    const useStreaming = model === 'flash';

    const audioBuffer = await callWithRetry(
      () => useStreaming
        ? callElevenLabsStream(voiceId, modelId, processedText, voiceSettings, apiKey, mp3Path, { previousText, nextText })
        : callElevenLabsAPI(voiceId, modelId, processedText, voiceSettings, apiKey, { previousText, nextText }),
      3,  // max retries
      500 // initial delay ms
    );

    // For non-streaming, write the buffer to MP3
    if (!useStreaming) {
      await writeFile(mp3Path, audioBuffer);
    }

    // Professional broadcast audio pipeline
    // Inspired by ElevenLabs' internal post-processing:
    //   1. De-esser: tame harsh sibilants (4-9kHz) — the #1 issue with AI voices
    //   2. High-pass: remove sub-bass rumble below 80Hz
    //   3. Low-mid warmth: gentle boost at 200-300Hz for body
    //   4. Mud cut: reduce 400-600Hz boxiness
    //   5. Presence: boost 2.5-4kHz for clarity and intelligibility
    //   6. Air: subtle high-shelf above 10kHz for openness
    //   7. Multiband compressor via chained bands for even dynamics
    //   8. Limiter: prevent clipping
    //   9. Loudnorm: broadcast-standard -16 LUFS
    const audioFilters = [
      // De-esser: detect sibilance and reduce it
      'highpass=f=80',
      'equalizer=f=6500:t=q:w=2:g=-3',       // de-ess: gentle cut at sibilance freq
      'equalizer=f=250:t=q:w=1.2:g=2.5',      // warmth: boost low-mids for richness
      'equalizer=f=500:t=q:w=2:g=-1.5',        // mud cut: reduce boxiness
      'equalizer=f=3000:t=q:w=1.5:g=2',        // presence: clarity boost
      'equalizer=f=8000:t=q:w=2:g=-2',            // harsh freq reduction
      'equalizer=f=12000:t=q:w=2:g=-2',           // cut high ringing (no more boost — killed whistle)
      'lowpass=f=13000:p=1',                       // gentle rolloff above 13kHz (was 14k/p=2 — too resonant)
      // Dynamic processing — softer compression to avoid pumping artifacts
      'acompressor=threshold=0.03:ratio=3:attack=5:release=100:makeup=1:knee=8',
      // Limiter to prevent clipping
      'alimiter=limit=0.93:level=false',
      // Broadcast loudness normalization
      'loudnorm=I=-16:LRA=9:TP=-1.5',
    ].join(',');

    await execAsync(
      `ffmpeg -y -i "${mp3Path}" -af "${audioFilters}" -c:a libopus -b:a 96k -vbr on -compression_level 10 -application voip "${oggPath}"`,
      { timeout: 30_000 }
    );

    // Cleanup MP3
    try { await unlink(mp3Path); } catch {}

    if (!existsSync(oggPath)) {
      throw new Error('ffmpeg OGG conversion produced no output');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[tts-11labs] Done (${elapsed}s, profile: ${contentType}): ${oggPath}`);

    return oggPath;
  } catch (err) {
    try { await unlink(mp3Path); } catch {}
    try { await unlink(oggPath); } catch {}
    throw new Error(`ElevenLabs TTS failed: ${err.message}`);
  }
}

/**
 * Streaming API — writes audio chunks directly to file as they arrive
 * ~50-75ms faster time-to-first-byte vs standard endpoint
 */
function callElevenLabsStream(voiceId, modelId, text, voiceSettings, apiKey, outputPath, context = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = {
      text,
      model_id: modelId,
      voice_settings: voiceSettings,
    };

    // Context continuity — ElevenLabs uses previous/next text to maintain
    // consistent prosody across chunked messages (their key differentiator)
    if (context.previousText) {
      requestBody.previous_text = context.previousText.slice(-1000);
    }
    if (context.nextText) {
      requestBody.next_text = context.nextText.slice(0, 1000);
    }

    if (modelId === 'eleven_flash_v2_5') {
      requestBody.apply_text_normalization = 'on';
    }

    // Request higher quality output
    requestBody.output_format = 'mp3_44100_128';

    const body = JSON.stringify(requestBody);

    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: `/v1/text-to-speech/${voiceId}/stream`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60_000,
    };

    const fileStream = createWriteStream(outputPath);
    let firstByteTime = null;

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', chunk => errBody += chunk);
        res.on('end', () => {
          fileStream.close();
          reject(new Error(`ElevenLabs Stream API ${res.statusCode}: ${errBody}`));
        });
        return;
      }

      res.on('data', (chunk) => {
        if (!firstByteTime) {
          firstByteTime = Date.now();
          console.log(`[tts-11labs] Stream first byte: ${firstByteTime - Date.now()}ms`);
        }
        fileStream.write(chunk);
      });

      res.on('end', () => {
        fileStream.end(() => {
          resolve(null); // file already written
        });
      });
    });

    req.on('error', (err) => {
      fileStream.close();
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      fileStream.close();
      reject(new Error('ElevenLabs Stream API request timed out'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Standard (non-streaming) API call with context continuity
 */
function callElevenLabsAPI(voiceId, modelId, text, voiceSettings, apiKey, context = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = {
      text,
      model_id: modelId,
      voice_settings: voiceSettings,
    };

    // Context continuity for multi-chunk messages
    if (context.previousText) {
      requestBody.previous_text = context.previousText.slice(-1000);
    }
    if (context.nextText) {
      requestBody.next_text = context.nextText.slice(0, 1000);
    }

    if (modelId === 'eleven_flash_v2_5') {
      requestBody.apply_text_normalization = 'on';
    }

    // Request high quality output format
    requestBody.output_format = 'mp3_44100_128';

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
 * Retry with exponential backoff — ElevenLabs rate limits and transient failures
 */
async function callWithRetry(fn, maxRetries = 3, initialDelay = 500) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Don't retry on auth errors or client errors (except 429 rate limit)
      if (err.message.includes('401') || err.message.includes('403') ||
          (err.message.includes('4') && !err.message.includes('429'))) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 200;
        console.warn(`[tts-11labs] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Detect content type for adaptive voice profile selection
 * Different content deserves different voice characteristics
 */
function detectContentType(text) {
  const trimmed = text.trim();

  // Short casual messages
  if (trimmed.length < 150 && !trimmed.includes('\n')) {
    return 'casual';
  }

  // Questions — ends with ? or starts with question words
  if (/\?$/.test(trimmed) || /^(what|how|why|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/i.test(trimmed)) {
    return 'question';
  }

  // Lists/instructions — bullet points or numbered lists
  const listLines = (trimmed.match(/^[\t ]*[-*•]\s+|^\d+[.)]\s+/gm) || []).length;
  const totalLines = trimmed.split('\n').filter(l => l.trim()).length;
  if (listLines > 2 || (totalLines > 0 && listLines / totalLines > 0.4)) {
    return 'instructional';
  }

  // Explanations — longer text with multiple sentences
  const sentences = trimmed.split(/[.!?]+/).filter(s => s.trim()).length;
  if (sentences >= 3 && trimmed.length > 300) {
    return 'explanation';
  }

  return 'default';
}

/**
 * Full preprocessing pipeline for ElevenLabs
 *
 * Pipeline:
 *   1. Strip markdown/formatting
 *   2. Apply pronunciation dictionary
 *   3. Expand abbreviations & numbers
 *   4. Model-specific prosody enhancement
 *   5. Sentence rhythm variation
 *   6. Natural filler/connector injection for organic flow
 *   7. Final cleanup
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

  // Apply pronunciation dictionary BEFORE abbreviation expansion
  text = applyPronunciationDict(text);

  // Expand abbreviations and normalize text for natural pronunciation
  text = expandAbbreviations(text);
  text = normalizeNumbersForSpeech(text);

  // Add natural connective tissue for organic flow
  text = addNaturalConnectors(text);

  if (model === 'v3') {
    text = enhanceForV3(text);
  } else {
    text = enhanceWithSSML(text);
  }

  // Final cleanup
  text = text
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

/**
 * Apply pronunciation dictionary — fix domain-specific mispronunciations
 * This is how ElevenLabs handles custom pronunciations internally
 */
function applyPronunciationDict(text) {
  for (const entry of PRONUNCIATION_DICT) {
    text = text.replace(entry.pattern, entry.replacement);
  }
  return text;
}

/**
 * Add natural connective phrases between disjointed segments
 * ElevenLabs sounds best when text flows naturally — abrupt topic shifts
 * create audible discontinuities in the voice model's attention
 */
function addNaturalConnectors(text) {
  // Replace bare numbered lists with spoken connectors
  text = text.replace(/^1[.)]\s+/m, 'First, ');
  text = text.replace(/^2[.)]\s+/m, 'Second, ');
  text = text.replace(/^3[.)]\s+/m, 'Third, ');
  text = text.replace(/^4[.)]\s+/m, 'Fourth, ');
  text = text.replace(/^5[.)]\s+/m, 'Fifth, ');
  // Higher numbers just get "Next,"
  text = text.replace(/^[6-9][.)]\s+/gm, 'Next, ');
  text = text.replace(/^\d{2,}[.)]\s+/gm, 'Next, ');

  // Soften abrupt transitions between paragraphs
  // "Done.\n\nNow let's" → "Done. Now let's" (the SSML/V3 handler adds proper pauses)

  return text;
}

// --- Abbreviation Expansion ---
const ABBREVIATIONS = {
  'API':    'A P I',
  'APIs':   'A P Is',
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

function expandAbbreviations(text) {
  for (const [abbr, expansion] of Object.entries(ABBREVIATIONS)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'g');
    text = text.replace(regex, expansion);
  }
  return text;
}

/**
 * Normalize numbers and currency for natural speech
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

  // File sizes
  text = text.replace(/(\d+)\s*KB/gi, '$1 kilobytes');
  text = text.replace(/(\d+)\s*MB/gi, '$1 megabytes');
  text = text.replace(/(\d+)\s*GB/gi, '$1 gigabytes');
  text = text.replace(/(\d+)\s*TB/gi, '$1 terabytes');

  // Time durations: 30s → 30 seconds, 5m → 5 minutes
  text = text.replace(/\b(\d+)\s*ms\b/g, '$1 milliseconds');
  text = text.replace(/\b(\d+)\s*s\b/g, '$1 seconds');

  // Ordinals: 1st, 2nd, 3rd → first, second, third
  text = text.replace(/\b1st\b/gi, 'first');
  text = text.replace(/\b2nd\b/gi, 'second');
  text = text.replace(/\b3rd\b/gi, 'third');
  text = text.replace(/\b(\d+)th\b/g, '$1th'); // leave others as-is, TTS handles them

  // Date-like: 2026-03-20 → March 20th, 2026
  text = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => {
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const month = months[parseInt(m, 10) - 1] || m;
    const day = parseInt(d, 10);
    return `${month} ${day}, ${y}`;
  });

  // Time: 14:30 → 2:30 PM
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
    const hour = parseInt(h, 10);
    if (hour > 24) return `${h}:${m}`; // not a time
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return `${h12}:${m} ${ampm}`;
  });

  return text;
}

/**
 * Enhance text with V3 emotion/audio tags
 * V3 has the richest prosody control — use it fully
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
    // Parenthetical asides → whispered for natural feel
    .replace(/\(([^)]{5,60})\)/g, '[whispers] $1 [pause]')
    // Em dashes → natural aside pause
    .replace(/\s*—\s*/g, ' [short pause] ')
    // Ellipsis → thinking pause
    .replace(/\.{3}/g, '[pause]');

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
 * Precise timing control — the key to natural-sounding AI speech
 */
function enhanceWithSSML(text) {
  text = text
    // List items → spoken with clear pauses between items
    .replace(/^[\t ]*[-*•]\s+/gm, '<break time="0.3s" /> ')
    .replace(/^[\t ]*\d+[.)]\s+/gm, '<break time="0.3s" /> ')
    // Colon followed by content → beat before the explanation
    .replace(/:\s*\n/g, ': <break time="0.5s" /> ')
    // Topic shifts (double newlines) → longer pause
    .replace(/\n\s*\n/g, '. <break time="0.7s" /> ')
    // Em dashes → conversational aside
    .replace(/\s*—\s*/g, ' <break time="0.25s" /> ')
    // Ellipsis → thinking pause
    .replace(/\.{3}/g, '<break time="0.6s" />');

  // Split into sentences and add natural breathing rhythm
  const sentences = text.split(/(?<=[.!?])\s+/);
  // Varied pauses create organic, human-like rhythm (ElevenLabs' key insight)
  const breathBreaks = ['0.15s', '0.25s', '0.35s', '0.20s', '0.30s'];
  let breakIdx = 0;

  const enhanced = sentences.map((s, i) => {
    // For long sentences, add breath-like pauses at natural clause boundaries
    if (s.length > 100) {
      // Try conjunctions first (most natural break point)
      const conjunctionBreak = s.search(/\b(and|but|however|so|then|because|although|while|yet|or|since|though)\b/i);
      if (conjunctionBreak > s.length * 0.25 && conjunctionBreak < s.length * 0.75) {
        const breakPoint = s.indexOf(' ', conjunctionBreak);
        if (breakPoint > 0) {
          s = s.slice(0, breakPoint) + ` <break time="${breathBreaks[breakIdx % 5]}" />` + s.slice(breakPoint);
          breakIdx++;
        }
      } else {
        // Fall back to mid-comma
        const midComma = s.indexOf(',', Math.floor(s.length * 0.25));
        if (midComma > 0 && midComma < s.length * 0.75) {
          s = s.slice(0, midComma + 1) + ` <break time="${breathBreaks[breakIdx % 5]}" />` + s.slice(midComma + 1);
          breakIdx++;
        }
      }
    }

    // Add varied inter-sentence pauses (avoids robotic rhythm)
    if (i < sentences.length - 1 && i > 0) {
      const pause = breathBreaks[breakIdx % 5];
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
  if (process.env.ELEVENLABS_API_KEY) {
    return process.env.ELEVENLABS_API_KEY;
  }

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

/**
 * Get voice profiles for status display
 */
export function getVoiceProfiles() {
  return { ...VOICE_PROFILES };
}

export default elevenLabsTTS;
