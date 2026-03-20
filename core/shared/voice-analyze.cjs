#!/usr/bin/env node
/**
 * voice-analyze.js — Audio quality analyzer for TamerClaw voice notes
 *
 * Analyzes OGG/MP3 voice files and produces a quality report covering:
 * - Loudness (LUFS), peak levels, dynamic range
 * - Frequency spectrum balance (bass/mid/treble/presence)
 * - Silence detection (head/tail gaps, mid-pauses)
 * - Sibilance / harshness / whistle detection
 * - Overall quality score with actionable recommendations
 *
 * Usage:
 *   node voice-analyze.js <audio-file> [--json] [--compare <file2>]
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function runJSON(cmd) {
  const raw = run(cmd);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Core Analysis Functions ──────────────────────────────────────────────────

/**
 * Get basic file metadata via ffprobe
 */
function getMetadata(filePath) {
  const info = runJSON(`ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`);
  if (!info) return null;

  const stream = info.streams?.[0] || {};
  const format = info.format || {};

  return {
    codec: stream.codec_name,
    sampleRate: parseInt(stream.sample_rate) || 0,
    channels: stream.channels || 0,
    duration: parseFloat(format.duration) || 0,
    bitrate: parseInt(format.bit_rate) || 0,
    fileSize: parseInt(format.size) || 0,
  };
}

/**
 * Measure loudness using ffmpeg's loudnorm filter (EBU R128)
 */
function measureLoudness(filePath) {
  const raw = run(
    `ffmpeg -i "${filePath}" -af "loudnorm=I=-16:LRA=9:TP=-1.5:print_format=json" -f null - 2>&1`
  );
  if (!raw) return null;

  // Extract the JSON block from ffmpeg stderr
  const jsonMatch = raw.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const data = JSON.parse(jsonMatch[0]);
    return {
      integratedLUFS: parseFloat(data.input_i) || 0,
      truePeak: parseFloat(data.input_tp) || 0,
      loudnessRange: parseFloat(data.input_lra) || 0,
      threshold: parseFloat(data.input_thresh) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Analyze frequency spectrum by measuring energy in bands
 */
function analyzeSpectrum(filePath) {
  const bands = [
    { name: 'sub_bass',   label: 'Sub-bass (20-80Hz)',     low: 20,   high: 80   },
    { name: 'bass',       label: 'Bass (80-250Hz)',         low: 80,   high: 250  },
    { name: 'low_mid',    label: 'Low-mid (250-500Hz)',     low: 250,  high: 500  },
    { name: 'mid',        label: 'Mid (500-2kHz)',          low: 500,  high: 2000 },
    { name: 'presence',   label: 'Presence (2-4kHz)',       low: 2000, high: 4000 },
    { name: 'brilliance', label: 'Brilliance (4-8kHz)',     low: 4000, high: 8000 },
    { name: 'air',        label: 'Air (8-16kHz)',           low: 8000, high: 16000 },
  ];

  const results = {};

  for (const band of bands) {
    // Bandpass filter + measure RMS
    const raw = run(
      `ffmpeg -i "${filePath}" -af "bandpass=f=${Math.round((band.low + band.high) / 2)}:width_type=h:w=${band.high - band.low},astats=metadata=1:reset=1" -f null - 2>&1`
    );

    if (raw) {
      // Extract RMS level from astats output
      const rmsMatch = raw.match(/RMS level dB:\s*([-\d.]+)/);
      const peakMatch = raw.match(/Peak level dB:\s*([-\d.]+)/);
      results[band.name] = {
        label: band.label,
        rmsDb: rmsMatch ? parseFloat(rmsMatch[1]) : -100,
        peakDb: peakMatch ? parseFloat(peakMatch[1]) : -100,
      };
    }
  }

  return results;
}

/**
 * Detect silence segments (pauses, head/tail gaps)
 */
function detectSilence(filePath) {
  const raw = run(
    `ffmpeg -i "${filePath}" -af "silencedetect=noise=-35dB:d=0.3" -f null - 2>&1`
  );
  if (!raw) return { segments: [], totalSilence: 0 };

  const starts = [...raw.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...raw.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];

  const segments = [];
  for (let i = 0; i < ends.length; i++) {
    segments.push({
      start: starts[i] || 0,
      end: parseFloat(ends[i][1]),
      duration: parseFloat(ends[i][2]),
    });
  }

  const totalSilence = segments.reduce((sum, s) => sum + s.duration, 0);

  return { segments, totalSilence };
}

/**
 * Detect sibilance / whistle / harshness in specific frequency bands
 */
function detectProblems(filePath) {
  const problems = {};

  // Whistle detection: energy spike in 5-8kHz relative to overall
  const whistleRaw = run(
    `ffmpeg -i "${filePath}" -af "bandpass=f=6500:width_type=h:w=3000,astats=metadata=1:reset=1" -f null - 2>&1`
  );
  const overallRaw = run(
    `ffmpeg -i "${filePath}" -af "astats=metadata=1:reset=1" -f null - 2>&1`
  );

  const whistleRMS = whistleRaw?.match(/RMS level dB:\s*([-\d.]+)/);
  const overallRMS = overallRaw?.match(/RMS level dB:\s*([-\d.]+)/);

  if (whistleRMS && overallRMS) {
    const whistleLevel = parseFloat(whistleRMS[1]);
    const overallLevel = parseFloat(overallRMS[1]);
    const ratio = whistleLevel - overallLevel; // how much louder the whistle band is

    problems.whistle = {
      bandRmsDb: whistleLevel,
      overallRmsDb: overallLevel,
      relativeDb: ratio,
      severity: ratio > -5 ? 'high' : ratio > -10 ? 'moderate' : ratio > -15 ? 'low' : 'none',
      description: ratio > -5
        ? 'Strong whistle/hiss detected in 5-8kHz range'
        : ratio > -10
        ? 'Moderate sibilance in 5-8kHz range'
        : 'Acceptable high-frequency levels',
    };
  }

  // Sibilance detection: sharp 4-7kHz energy
  const sibilanceRaw = run(
    `ffmpeg -i "${filePath}" -af "bandpass=f=5500:width_type=h:w=3000,astats=metadata=1:reset=1" -f null - 2>&1`
  );
  const sibRMS = sibilanceRaw?.match(/RMS level dB:\s*([-\d.]+)/);

  if (sibRMS && overallRMS) {
    const sibLevel = parseFloat(sibRMS[1]);
    const overallLevel = parseFloat(overallRMS[1]);
    const ratio = sibLevel - overallLevel;

    problems.sibilance = {
      bandRmsDb: sibLevel,
      relativeDb: ratio,
      severity: ratio > -3 ? 'high' : ratio > -8 ? 'moderate' : 'low',
    };
  }

  // Muddiness: excessive 200-400Hz energy
  const mudRaw = run(
    `ffmpeg -i "${filePath}" -af "bandpass=f=300:width_type=h:w=200,astats=metadata=1:reset=1" -f null - 2>&1`
  );
  const mudRMS = mudRaw?.match(/RMS level dB:\s*([-\d.]+)/);

  if (mudRMS && overallRMS) {
    const mudLevel = parseFloat(mudRMS[1]);
    const overallLevel = parseFloat(overallRMS[1]);
    const ratio = mudLevel - overallLevel;

    problems.muddiness = {
      bandRmsDb: mudLevel,
      relativeDb: ratio,
      severity: ratio > 3 ? 'high' : ratio > 0 ? 'moderate' : 'low',
    };
  }

  // Clipping detection
  const clipRaw = run(
    `ffmpeg -i "${filePath}" -af "astats=metadata=1:reset=1" -f null - 2>&1`
  );
  const numSamples = clipRaw?.match(/Number of samples:\s*(\d+)/);
  const flatFactor = clipRaw?.match(/Flat factor:\s*([\d.]+)/);
  const peakCount = clipRaw?.match(/Peak count:\s*([\d.]+)/);

  problems.clipping = {
    flatFactor: flatFactor ? parseFloat(flatFactor[1]) : 0,
    severity: (flatFactor && parseFloat(flatFactor[1]) > 10) ? 'high' : 'none',
  };

  return problems;
}

/**
 * Generate overall quality score (0-100)
 */
function scoreQuality(metadata, loudness, silence, problems) {
  let score = 100;
  const deductions = [];

  // Loudness check: target -16 LUFS ± 2
  if (loudness) {
    const lufs = loudness.integratedLUFS;
    if (lufs < -20) {
      const d = Math.min(20, Math.abs(lufs + 16) * 3);
      score -= d;
      deductions.push(`Too quiet (${lufs.toFixed(1)} LUFS, target -16): -${d.toFixed(0)}`);
    } else if (lufs > -14) {
      const d = Math.min(15, Math.abs(lufs + 16) * 3);
      score -= d;
      deductions.push(`Too loud (${lufs.toFixed(1)} LUFS, target -16): -${d.toFixed(0)}`);
    }

    // True peak check
    if (loudness.truePeak > -0.5) {
      score -= 10;
      deductions.push(`True peak too high (${loudness.truePeak.toFixed(1)} dBTP): -10`);
    }

    // Dynamic range
    if (loudness.loudnessRange < 3) {
      score -= 5;
      deductions.push(`Very flat dynamics (LRA ${loudness.loudnessRange.toFixed(1)} LU): -5`);
    } else if (loudness.loudnessRange > 15) {
      score -= 8;
      deductions.push(`Too much dynamic variation (LRA ${loudness.loudnessRange.toFixed(1)} LU): -8`);
    }
  }

  // Silence at start/end
  if (silence?.segments?.length > 0) {
    const first = silence.segments[0];
    if (first.start < 0.1 && first.duration > 0.5) {
      const d = Math.min(10, first.duration * 5);
      score -= d;
      deductions.push(`Long silence at start (${first.duration.toFixed(1)}s): -${d.toFixed(0)}`);
    }
  }

  // Problem deductions
  if (problems?.whistle?.severity === 'high') {
    score -= 20;
    deductions.push(`High-frequency whistle detected: -20`);
  } else if (problems?.whistle?.severity === 'moderate') {
    score -= 10;
    deductions.push(`Moderate sibilance/hiss: -10`);
  }

  if (problems?.muddiness?.severity === 'high') {
    score -= 10;
    deductions.push(`Muddy low-mids: -10`);
  }

  if (problems?.clipping?.severity === 'high') {
    score -= 15;
    deductions.push(`Clipping detected: -15`);
  }

  // Spectrum balance check: voice should peak in mid/presence, not air/brilliance
  if (arguments[4]) { // spectrum passed as 5th arg
    const spectrum = arguments[4];
    const midEnergy = spectrum?.mid?.rmsDb ?? -100;
    const presenceEnergy = spectrum?.presence?.rmsDb ?? -100;
    const brillianceEnergy = spectrum?.brilliance?.rmsDb ?? -100;
    const airEnergy = spectrum?.air?.rmsDb ?? -100;
    const voiceCore = Math.max(midEnergy, presenceEnergy);

    // Air band louder than voice core = whistle/artifact
    if (airEnergy > voiceCore) {
      const delta = airEnergy - voiceCore;
      const d = Math.min(30, delta * 2);
      score -= d;
      deductions.push(`Inverted spectrum: Air band ${delta.toFixed(1)}dB louder than voice core: -${d.toFixed(0)}`);
    } else if (airEnergy > voiceCore - 6) {
      const delta = airEnergy - voiceCore + 6;
      const d = Math.min(15, delta * 2);
      score -= d;
      deductions.push(`Excessive high-frequency energy (air within ${(voiceCore - airEnergy).toFixed(1)}dB of voice): -${d.toFixed(0)}`);
    }

    // Brilliance louder than presence = harsh
    if (brillianceEnergy > presenceEnergy + 3) {
      const delta = brillianceEnergy - presenceEnergy;
      const d = Math.min(15, delta);
      score -= d;
      deductions.push(`Harsh brilliance (${delta.toFixed(1)}dB above presence): -${d.toFixed(0)}`);
    }
  }

  // Bitrate check
  if (metadata?.bitrate && metadata.bitrate < 48000) {
    score -= 10;
    deductions.push(`Low bitrate (${(metadata.bitrate / 1000).toFixed(0)}kbps): -10`);
  }

  return { score: Math.max(0, Math.round(score)), deductions };
}

/**
 * Generate recommendations based on analysis
 */
function getRecommendations(loudness, problems, spectrum) {
  const recs = [];

  if (problems?.whistle?.severity === 'high' || problems?.whistle?.severity === 'moderate') {
    recs.push({
      priority: 'HIGH',
      issue: 'High-frequency whistle/hiss',
      fix: 'Add a stronger notch filter or low-pass around 6-8kHz. Current de-esser at 6500Hz may need wider bandwidth or deeper cut (try -6dB instead of -3dB).',
      ffmpegHint: 'equalizer=f=6500:t=q:w=3:g=-6,lowpass=f=11000:p=2',
    });
  }

  if (problems?.sibilance?.severity === 'high') {
    recs.push({
      priority: 'HIGH',
      issue: 'Harsh sibilance (s/sh sounds)',
      fix: 'Increase de-esser depth at 5.5kHz or use a dynamic de-esser.',
      ffmpegHint: 'equalizer=f=5500:t=q:w=2.5:g=-5',
    });
  }

  if (problems?.muddiness?.severity === 'high' || problems?.muddiness?.severity === 'moderate') {
    recs.push({
      priority: 'MEDIUM',
      issue: 'Muddy low-mids (200-400Hz)',
      fix: 'Cut more aggressively around 300Hz. Current -1.5dB at 500Hz may not be enough.',
      ffmpegHint: 'equalizer=f=300:t=q:w=1.5:g=-3',
    });
  }

  if (loudness && loudness.integratedLUFS < -20) {
    recs.push({
      priority: 'HIGH',
      issue: 'Audio too quiet',
      fix: 'Increase makeup gain or adjust loudnorm target.',
      ffmpegHint: 'loudnorm=I=-14:LRA=9:TP=-1.5',
    });
  }

  if (loudness && loudness.loudnessRange > 15) {
    recs.push({
      priority: 'MEDIUM',
      issue: 'Too much volume variation',
      fix: 'Increase compressor ratio or lower threshold.',
      ffmpegHint: 'acompressor=threshold=0.02:ratio=4:attack=5:release=80',
    });
  }

  // Spectrum-based recs
  if (spectrum) {
    const midEnergy = spectrum?.mid?.rmsDb ?? -100;
    const presenceEnergy = spectrum?.presence?.rmsDb ?? -100;
    const airEnergy = spectrum?.air?.rmsDb ?? -100;
    const brillianceEnergy = spectrum?.brilliance?.rmsDb ?? -100;
    const voiceCore = Math.max(midEnergy, presenceEnergy);

    if (airEnergy > voiceCore) {
      recs.push({
        priority: 'CRITICAL',
        issue: `Inverted spectrum — Air band (${airEnergy.toFixed(1)}dB) louder than voice (${voiceCore.toFixed(1)}dB)`,
        fix: 'Aggressive low-pass needed. The TTS output has high-frequency artifacts dominating the voice. Apply a steeper low-pass and cut the air band.',
        ffmpegHint: 'lowpass=f=10000:p=2,equalizer=f=10000:t=q:w=3:g=-12,equalizer=f=8000:t=q:w=2:g=-8',
      });
    }

    if (brillianceEnergy > presenceEnergy + 3) {
      recs.push({
        priority: 'HIGH',
        issue: `Brilliance (4-8kHz) overpowering presence (2-4kHz) by ${(brillianceEnergy - presenceEnergy).toFixed(1)}dB`,
        fix: 'Cut 4-8kHz range more aggressively. Voice clarity comes from 2-4kHz, not above.',
        ffmpegHint: 'equalizer=f=6000:t=q:w=3:g=-6',
      });
    }
  }

  if (recs.length === 0) {
    recs.push({
      priority: 'INFO',
      issue: 'No major issues detected',
      fix: 'Audio quality is within acceptable parameters.',
    });
  }

  return recs;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function analyze(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`\n🔊 TamerClaw Voice Analyzer`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📁 File: ${path.basename(filePath)}`);
  console.log();

  // 1. Metadata
  console.log(`⏳ Reading metadata...`);
  const metadata = getMetadata(filePath);
  if (!metadata) {
    console.error('Failed to read file metadata');
    process.exit(1);
  }

  console.log(`  Codec: ${metadata.codec} | Sample Rate: ${metadata.sampleRate}Hz`);
  console.log(`  Duration: ${metadata.duration.toFixed(2)}s | Bitrate: ${(metadata.bitrate / 1000).toFixed(0)}kbps`);
  console.log(`  Channels: ${metadata.channels} | Size: ${(metadata.fileSize / 1024).toFixed(1)}KB`);
  console.log();

  // 2. Loudness
  console.log(`⏳ Measuring loudness (EBU R128)...`);
  const loudness = measureLoudness(filePath);
  if (loudness) {
    const lufsColor = Math.abs(loudness.integratedLUFS + 16) < 2 ? '✅' : '⚠️';
    console.log(`  ${lufsColor} Integrated: ${loudness.integratedLUFS.toFixed(1)} LUFS (target: -16)`);
    console.log(`  ${loudness.truePeak > -1 ? '⚠️' : '✅'} True Peak: ${loudness.truePeak.toFixed(1)} dBTP`);
    console.log(`  Loudness Range: ${loudness.loudnessRange.toFixed(1)} LU`);
  }
  console.log();

  // 3. Spectrum
  console.log(`⏳ Analyzing frequency spectrum...`);
  const spectrum = analyzeSpectrum(filePath);
  if (spectrum && Object.keys(spectrum).length > 0) {
    for (const [key, band] of Object.entries(spectrum)) {
      const bar = '█'.repeat(Math.max(0, Math.round((band.rmsDb + 60) / 2)));
      console.log(`  ${band.label.padEnd(28)} ${band.rmsDb.toFixed(1).padStart(7)} dB  ${bar}`);
    }
  }
  console.log();

  // 4. Silence
  console.log(`⏳ Detecting silence/pauses...`);
  const silence = detectSilence(filePath);
  if (silence.segments.length > 0) {
    console.log(`  Found ${silence.segments.length} silent segment(s), total: ${silence.totalSilence.toFixed(2)}s`);
    for (const seg of silence.segments.slice(0, 5)) {
      console.log(`    ${seg.start.toFixed(2)}s → ${seg.end.toFixed(2)}s (${seg.duration.toFixed(2)}s)`);
    }
    if (silence.segments.length > 5) {
      console.log(`    ... and ${silence.segments.length - 5} more`);
    }
    const silenceRatio = (silence.totalSilence / metadata.duration * 100).toFixed(1);
    console.log(`  Silence ratio: ${silenceRatio}% of total duration`);
  } else {
    console.log(`  No significant silence detected`);
  }
  console.log();

  // 5. Problem detection
  console.log(`⏳ Detecting audio problems...`);
  const problems = detectProblems(filePath);

  if (problems.whistle) {
    const icon = problems.whistle.severity === 'none' ? '✅' : problems.whistle.severity === 'low' ? '✅' : '⚠️';
    console.log(`  ${icon} Whistle/Hiss: ${problems.whistle.severity} (${problems.whistle.relativeDb.toFixed(1)}dB relative)`);
  }
  if (problems.sibilance) {
    const icon = problems.sibilance.severity === 'low' ? '✅' : '⚠️';
    console.log(`  ${icon} Sibilance: ${problems.sibilance.severity} (${problems.sibilance.relativeDb.toFixed(1)}dB relative)`);
  }
  if (problems.muddiness) {
    const icon = problems.muddiness.severity === 'low' ? '✅' : '⚠️';
    console.log(`  ${icon} Muddiness: ${problems.muddiness.severity} (${problems.muddiness.relativeDb.toFixed(1)}dB relative)`);
  }
  if (problems.clipping) {
    console.log(`  ${problems.clipping.severity === 'none' ? '✅' : '⚠️'} Clipping: ${problems.clipping.severity}`);
  }
  console.log();

  // 6. Quality score
  const quality = scoreQuality(metadata, loudness, silence, problems, spectrum);
  const scoreIcon = quality.score >= 80 ? '🟢' : quality.score >= 60 ? '🟡' : '🔴';
  console.log(`${scoreIcon} Overall Quality Score: ${quality.score}/100`);
  if (quality.deductions.length > 0) {
    console.log(`  Deductions:`);
    for (const d of quality.deductions) {
      console.log(`    • ${d}`);
    }
  }
  console.log();

  // 7. Recommendations
  const recs = getRecommendations(loudness, problems, spectrum);
  console.log(`💡 Recommendations:`);
  for (const rec of recs) {
    console.log(`  [${rec.priority}] ${rec.issue}`);
    console.log(`    → ${rec.fix}`);
    if (rec.ffmpegHint) {
      console.log(`    ffmpeg hint: ${rec.ffmpegHint}`);
    }
  }
  console.log();

  // 8. Comparison mode
  if (opts.compare) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 Comparison with: ${path.basename(opts.compare)}`);
    console.log();

    const meta2 = getMetadata(opts.compare);
    const loud2 = measureLoudness(opts.compare);
    const prob2 = detectProblems(opts.compare);
    const qual2 = scoreQuality(meta2, loud2, null, prob2);

    console.log(`  ${'Metric'.padEnd(25)} ${'File 1'.padStart(12)} ${'File 2'.padStart(12)} ${'Delta'.padStart(10)}`);
    console.log(`  ${'─'.repeat(60)}`);

    if (loudness && loud2) {
      const d1 = loudness.integratedLUFS, d2 = loud2.integratedLUFS;
      console.log(`  ${'Loudness (LUFS)'.padEnd(25)} ${d1.toFixed(1).padStart(12)} ${d2.toFixed(1).padStart(12)} ${(d2 - d1).toFixed(1).padStart(10)}`);

      const p1 = loudness.truePeak, p2 = loud2.truePeak;
      console.log(`  ${'True Peak (dBTP)'.padEnd(25)} ${p1.toFixed(1).padStart(12)} ${p2.toFixed(1).padStart(12)} ${(p2 - p1).toFixed(1).padStart(10)}`);
    }

    console.log(`  ${'Quality Score'.padEnd(25)} ${String(quality.score).padStart(12)} ${String(qual2.score).padStart(12)} ${(qual2.score - quality.score > 0 ? '+' : '') + (qual2.score - quality.score)}`);
    console.log();
  }

  // JSON output
  if (opts.json) {
    const report = { metadata, loudness, spectrum, silence, problems, quality, recommendations: recs };
    console.log(`\n📋 JSON Report:`);
    console.log(JSON.stringify(report, null, 2));
  }

  return { metadata, loudness, spectrum, silence, problems, quality, recommendations: recs };
}

// ── CLI Entry ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node voice-analyze.js <audio-file> [options]

Options:
  --json              Output full JSON report
  --compare <file>    Compare with another audio file
  --help              Show this help

Examples:
  node voice-analyze.js /tmp/tts-output.ogg
  node voice-analyze.js /tmp/new.ogg --compare /tmp/old.ogg
  node voice-analyze.js /tmp/tts-output.ogg --json
`);
    process.exit(0);
  }

  const filePath = args[0];
  const opts = {
    json: args.includes('--json'),
    compare: args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null,
  };

  analyze(filePath, opts).catch(err => {
    console.error('Analysis failed:', err.message);
    process.exit(1);
  });
}

module.exports = { analyze };
