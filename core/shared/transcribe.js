/**
 * Voice transcription module using local OpenAI Whisper
 * Used by all Telegram bot agents to transcribe voice notes
 *
 * Requires: openai-whisper (pip), ffmpeg
 * Models: large-v3-turbo (cached), falls back to tiny
 */

import { execFile } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

const WHISPER_BIN = '/usr/local/bin/whisper';
const PREFERRED_MODEL = 'large-v3-turbo';
const FALLBACK_MODEL = 'tiny';
const TIMEOUT_MS = 120_000; // 2 minutes max

/**
 * Transcribe an audio file (OGG, MP3, WAV, etc.) to text using local Whisper
 * @param {string} filePath - Path to the audio file
 * @param {string} [language] - Optional language hint (e.g. 'en', 'ar')
 * @returns {Promise<string>} Transcribed text
 */
export function transcribeAudio(filePath, language) {
  return new Promise((resolve, reject) => {
    if (!existsSync(filePath)) {
      return reject(new Error(`Audio file not found: ${filePath}`));
    }

    runWhisper(filePath, PREFERRED_MODEL, language)
      .then(resolve)
      .catch(err => {
        console.log(`[transcribe] Primary model failed, trying fallback: ${err.message}`);
        runWhisper(filePath, FALLBACK_MODEL, language)
          .then(resolve)
          .catch(reject);
      });
  });
}

function runWhisper(filePath, model, language) {
  return new Promise((resolve, reject) => {
    const outputDir = tmpdir();
    const args = [
      filePath,
      '--model', model,
      '--output_dir', outputDir,
      '--output_format', 'txt',
      '--fp16', 'False',
    ];

    if (language) {
      args.push('--language', language);
    }

    const startTime = Date.now();
    console.log(`[transcribe] Starting (${model}): ${filePath}`);

    execFile(WHISPER_BIN, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (error) {
        return reject(new Error(`Whisper (${model}) failed after ${elapsed}s: ${error.message}`));
      }

      // Whisper writes <basename>.txt in output dir
      const base = basename(filePath).replace(/\.[^.]+$/, '');
      const txtPath = join(outputDir, `${base}.txt`);

      let text = '';
      try {
        if (existsSync(txtPath)) {
          text = readFileSync(txtPath, 'utf-8').trim();
          try { unlinkSync(txtPath); } catch {} // cleanup temp
        }
      } catch {}

      // Fallback: parse stdout
      if (!text && stdout) {
        const lines = stdout.split('\n')
          .filter(l => !l.startsWith('[') && !l.startsWith('Detecting') && l.trim())
          .map(l => l.trim());
        text = lines.join(' ').trim();
      }

      if (!text) {
        text = '[Voice message received but transcription was empty]';
      }

      console.log(`[transcribe] Done (${model}, ${elapsed}s): "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
      resolve(text);
    });
  });
}

export default transcribeAudio;
