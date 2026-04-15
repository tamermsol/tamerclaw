/**
 * compute-tools.js — Mac Mini Compute Capabilities as First-Class Tools
 *
 * Registers Mac Mini compute capabilities (Flutter builds, Whisper transcription,
 * FFmpeg processing, ImageMagick, Node builds) as structured tools in the
 * TamerClaw Tool Registry.
 *
 * Each capability becomes a tool that agents can invoke through the engine,
 * with proper validation, health checks, and error handling.
 *
 * Usage:
 *   import { registerComputeTools, getComputeToolStatus } from '../shared/compute-tools.js';
 *
 *   // Register all compute tools in the tool registry
 *   await registerComputeTools(toolRegistry);
 *
 *   // Execute a compute tool
 *   const result = await executeComputeTool('compute-transcribe', {
 *     audioPath: '/path/to/audio.m4a',
 *     language: 'en',
 *   });
 */

import { buildTool, TOOL_CATEGORIES, PERMISSION_LEVELS } from './tool-registry.js';
import { isNodeAvailable, compute, uploadFile, downloadFile } from './compute.js';
import { feature } from './feature-flags.js';
import { existsSync } from 'fs';
import path from 'path';

// ── Compute Tool Definitions ────────────────────────────────────────────

const COMPUTE_TOOLS = {
  // ── Audio / Voice ────────────────────────────────────────────────────
  'compute-transcribe': {
    name: 'compute-transcribe',
    description: 'Transcribe audio to text using Whisper on Mac Mini M1 (Metal accelerated)',
    category: TOOL_CATEGORIES.MEDIA,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: {
      node: 'mac-mini',
      capability: 'voice-processing',
      supportedFormats: ['m4a', 'oga', 'ogg', 'mp3', 'webm', 'mp4', 'wav'],
      languages: ['en', 'ar', 'fr', 'de', 'es', 'it', 'pt', 'zh', 'ja', 'ko'],
    },
    async execute(input) {
      const { audioPath, language = 'en', model = 'base' } = input;
      if (!audioPath) throw new Error('audioPath is required');
      if (!existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

      const available = await isNodeAvailable('mac-mini');
      if (!available) throw new Error('Mac Mini is offline');

      const ext = path.extname(audioPath).toLowerCase();
      const remotePath = `/tmp/claude-compute/transcribe_${Date.now()}${ext}`;
      const remoteWav = remotePath.replace(ext, '.wav');

      try {
        // Upload audio
        await uploadFile('mac-mini', audioPath, remotePath);

        // Convert to WAV if needed (Whisper prefers WAV)
        if (ext !== '.wav') {
          await compute('mac-mini',
            `ffmpeg -i "${remotePath}" -ar 16000 -ac 1 -c:a pcm_s16le "${remoteWav}" -y 2>/dev/null`,
            { timeout: 60000 }
          );
        }

        const inputFile = ext !== '.wav' ? remoteWav : remotePath;

        // Run Whisper
        const whisperModel = language === 'ar' ? 'medium' : model;
        const result = await compute('mac-mini',
          `source ~/compute-env/bin/activate && whisper "${inputFile}" --model ${whisperModel} --language ${language} --output_format txt --output_dir /tmp/claude-compute/ 2>/dev/null && cat "${inputFile.replace(ext !== '.wav' ? '.wav' : ext, '.txt')}"`,
          { timeout: 300000 }
        );

        // Cleanup
        await compute('mac-mini', `rm -f "${remotePath}" "${remoteWav}" "${inputFile.replace(ext !== '.wav' ? '.wav' : ext, '.txt')}"`, { timeout: 5000 }).catch(() => {});

        return { text: result.stdout?.trim() || '', language, model: whisperModel };
      } catch (err) {
        await compute('mac-mini', `rm -f "${remotePath}" "${remoteWav}"`, { timeout: 5000 }).catch(() => {});
        throw err;
      }
    },
  },

  // ── Video Processing ─────────────────────────────────────────────────
  'compute-video': {
    name: 'compute-video',
    description: 'Process video using FFmpeg with hardware acceleration on Mac Mini M1',
    category: TOOL_CATEGORIES.MEDIA,
    permissions: { readOnly: false, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: {
      node: 'mac-mini',
      capability: 'video-processing',
      operations: ['compress', 'extract_audio', 'thumbnail', 'gif', 'resize', 'trim'],
    },
    async execute(input) {
      const { videoPath, operation = 'compress', options = {} } = input;
      if (!videoPath) throw new Error('videoPath is required');

      const available = await isNodeAvailable('mac-mini');
      if (!available) throw new Error('Mac Mini is offline');

      const ext = path.extname(videoPath);
      const remotePath = `/tmp/claude-compute/video_${Date.now()}${ext}`;
      const outputName = `output_${Date.now()}`;

      await uploadFile('mac-mini', videoPath, remotePath);

      let cmd;
      let outputExt;

      switch (operation) {
        case 'compress':
          outputExt = ext || '.mp4';
          cmd = `ffmpeg -i "${remotePath}" -c:v hevc_videotoolbox -b:v ${options.bitrate || '2M'} -c:a aac "/tmp/claude-compute/${outputName}${outputExt}" -y 2>&1`;
          break;
        case 'extract_audio':
          outputExt = '.mp3';
          cmd = `ffmpeg -i "${remotePath}" -vn -c:a libmp3lame -q:a 2 "/tmp/claude-compute/${outputName}${outputExt}" -y 2>&1`;
          break;
        case 'thumbnail':
          outputExt = '.jpg';
          cmd = `ffmpeg -i "${remotePath}" -ss ${options.timestamp || '00:00:01'} -vframes 1 "/tmp/claude-compute/${outputName}${outputExt}" -y 2>&1`;
          break;
        case 'gif':
          outputExt = '.gif';
          cmd = `ffmpeg -i "${remotePath}" -vf "fps=10,scale=${options.width || 320}:-1:flags=lanczos" -t ${options.duration || 5} "/tmp/claude-compute/${outputName}${outputExt}" -y 2>&1`;
          break;
        case 'resize':
          outputExt = ext || '.mp4';
          cmd = `ffmpeg -i "${remotePath}" -vf "scale=${options.width || -1}:${options.height || -1}" -c:v hevc_videotoolbox "/tmp/claude-compute/${outputName}${outputExt}" -y 2>&1`;
          break;
        case 'trim':
          outputExt = ext || '.mp4';
          cmd = `ffmpeg -i "${remotePath}" -ss ${options.start || '0'} -t ${options.duration || '30'} -c copy "/tmp/claude-compute/${outputName}${outputExt}" -y 2>&1`;
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      try {
        await compute('mac-mini', cmd, { timeout: 600000 });

        const outputPath = `/tmp/claude-compute/${outputName}${outputExt}`;
        const localOutput = `/tmp/compute-output-${outputName}${outputExt}`;
        await downloadFile('mac-mini', outputPath, localOutput);

        // Cleanup
        await compute('mac-mini', `rm -f "${remotePath}" "${outputPath}"`, { timeout: 5000 }).catch(() => {});

        return { outputPath: localOutput, operation, format: outputExt };
      } catch (err) {
        await compute('mac-mini', `rm -f "${remotePath}"`, { timeout: 5000 }).catch(() => {});
        throw err;
      }
    },
  },

  // ── Image Processing ─────────────────────────────────────────────────
  'compute-image': {
    name: 'compute-image',
    description: 'Process images using ImageMagick on Mac Mini M1',
    category: TOOL_CATEGORIES.MEDIA,
    permissions: { readOnly: false, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: {
      node: 'mac-mini',
      capability: 'image-processing',
      operations: ['resize', 'convert', 'composite', 'app_icon', 'optimize', 'watermark'],
    },
    async execute(input) {
      const { imagePath, operation = 'resize', options = {} } = input;
      if (!imagePath) throw new Error('imagePath is required');

      const available = await isNodeAvailable('mac-mini');
      if (!available) throw new Error('Mac Mini is offline');

      const ext = path.extname(imagePath);
      const remotePath = `/tmp/claude-compute/img_${Date.now()}${ext}`;
      const outputName = `imgout_${Date.now()}`;

      await uploadFile('mac-mini', imagePath, remotePath);

      let cmd;
      let outputExt = options.format || ext || '.png';

      switch (operation) {
        case 'resize':
          cmd = `magick "${remotePath}" -resize ${options.width || 800}x${options.height || ''} "/tmp/claude-compute/${outputName}${outputExt}"`;
          break;
        case 'convert':
          outputExt = `.${options.toFormat || 'webp'}`;
          cmd = `magick "${remotePath}" -quality ${options.quality || 85} "/tmp/claude-compute/${outputName}${outputExt}"`;
          break;
        case 'optimize':
          cmd = `magick "${remotePath}" -strip -quality ${options.quality || 80} -resize '${options.maxWidth || 1920}x${options.maxHeight || 1920}>' "/tmp/claude-compute/${outputName}${outputExt}"`;
          break;
        case 'app_icon': {
          const sizes = [1024, 512, 256, 180, 167, 152, 120, 87, 80, 76, 60, 58, 40, 29, 20];
          const outDir = `/tmp/claude-compute/icons_${Date.now()}`;
          cmd = `mkdir -p "${outDir}" && ${sizes.map(s =>
            `magick "${remotePath}" -resize ${s}x${s} "${outDir}/icon_${s}.png"`
          ).join(' && ')}`;
          outputExt = '.zip';
          // Zip them up
          cmd += ` && cd "${outDir}" && zip -r "/tmp/claude-compute/${outputName}.zip" . 2>/dev/null`;
          break;
        }
        case 'watermark':
          cmd = `magick "${remotePath}" -gravity ${options.gravity || 'southeast'} -font Arial -pointsize ${options.fontSize || 24} -fill "rgba(255,255,255,0.5)" -annotate +10+10 "${options.text || 'TamerClaw'}" "/tmp/claude-compute/${outputName}${outputExt}"`;
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      try {
        await compute('mac-mini', cmd, { timeout: 120000 });

        const outputPath = `/tmp/claude-compute/${outputName}${outputExt}`;
        const localOutput = `/tmp/compute-output-${outputName}${outputExt}`;
        await downloadFile('mac-mini', outputPath, localOutput);

        await compute('mac-mini', `rm -f "${remotePath}" "${outputPath}"`, { timeout: 5000 }).catch(() => {});

        return { outputPath: localOutput, operation, format: outputExt };
      } catch (err) {
        await compute('mac-mini', `rm -f "${remotePath}"`, { timeout: 5000 }).catch(() => {});
        throw err;
      }
    },
  },

  // ── Flutter Build ────────────────────────────────────────────────────
  'compute-flutter-build': {
    name: 'compute-flutter-build',
    description: 'Build Flutter iOS/macOS apps on Mac Mini M1 with Xcode',
    category: TOOL_CATEGORIES.COMPUTE,
    permissions: { readOnly: false, destructive: false, concurrencySafe: false },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: {
      node: 'mac-mini',
      capability: 'flutter-build',
      platforms: ['ios', 'macos'],
      flutter: '3.29.2',
      xcode: '26.2',
    },
    async execute(input) {
      const { projectPath, platform = 'ios', mode = 'debug', clean = false } = input;
      if (!projectPath) throw new Error('projectPath is required');

      const available = await isNodeAvailable('mac-mini');
      if (!available) throw new Error('Mac Mini is offline');

      const projectName = path.basename(projectPath);
      const remoteProject = `/tmp/claude-compute/${projectName}`;

      // Upload project (tar for speed)
      await compute('mac-mini', `mkdir -p "${remoteProject}"`, { timeout: 5000 });

      // Upload via tar stream
      const { execSync } = await import('child_process');
      execSync(`tar czf - -C "${path.dirname(projectPath)}" "${projectName}" | ssh -p 2222 msoldev@localhost "tar xzf - -C /tmp/claude-compute/"`, { timeout: 120000 });

      try {
        // Clean if requested
        if (clean) {
          await compute('mac-mini', `cd "${remoteProject}" && flutter clean`, { timeout: 60000 });
        }

        // Get dependencies
        await compute('mac-mini', `cd "${remoteProject}" && flutter pub get`, { timeout: 120000 });

        // Pod install for iOS
        if (platform === 'ios') {
          await compute('mac-mini', `cd "${remoteProject}/ios" && pod install`, { timeout: 120000 });
        }

        // Build
        const buildCmd = mode === 'release'
          ? `cd "${remoteProject}" && flutter build ${platform} --release`
          : `cd "${remoteProject}" && flutter build ${platform}`;

        const result = await compute('mac-mini', buildCmd, { timeout: 600000 });

        return {
          success: result.exitCode === 0,
          output: result.stdout,
          errors: result.stderr,
          platform,
          mode,
          projectName,
        };
      } catch (err) {
        throw err;
      } finally {
        // Cleanup
        await compute('mac-mini', `rm -rf "${remoteProject}"`, { timeout: 10000 }).catch(() => {});
      }
    },
  },

  // ── Node.js Build ────────────────────────────────────────────────────
  'compute-node-build': {
    name: 'compute-node-build',
    description: 'Run Node.js/npm builds on Mac Mini M1 (Next.js, React, etc.)',
    category: TOOL_CATEGORIES.COMPUTE,
    permissions: { readOnly: false, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ASK_FIRST,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: {
      node: 'mac-mini',
      capability: 'node-services',
      nodeVersion: '25.8.2',
    },
    async execute(input) {
      const { projectPath, command = 'npm run build', install = true } = input;
      if (!projectPath) throw new Error('projectPath is required');

      const available = await isNodeAvailable('mac-mini');
      if (!available) throw new Error('Mac Mini is offline');

      const projectName = path.basename(projectPath);
      const remoteProject = `/tmp/claude-compute/${projectName}`;

      // Upload project
      const { execSync } = await import('child_process');
      execSync(`tar czf - -C "${path.dirname(projectPath)}" "${projectName}" --exclude node_modules --exclude .next --exclude dist | ssh -p 2222 msoldev@localhost "tar xzf - -C /tmp/claude-compute/"`, { timeout: 120000 });

      try {
        if (install) {
          await compute('mac-mini', `cd "${remoteProject}" && npm install`, { timeout: 300000 });
        }

        const result = await compute('mac-mini', `cd "${remoteProject}" && ${command}`, { timeout: 600000 });

        return {
          success: result.exitCode === 0,
          output: result.stdout,
          errors: result.stderr,
          command,
        };
      } finally {
        await compute('mac-mini', `rm -rf "${remoteProject}"`, { timeout: 10000 }).catch(() => {});
      }
    },
  },

  // ── Local AI Inference ───────────────────────────────────────────────
  'compute-ollama': {
    name: 'compute-ollama',
    description: 'Run local AI inference via Ollama on Mac Mini M1 (private, no API calls)',
    category: TOOL_CATEGORIES.COMPUTE,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: {
      node: 'mac-mini',
      capability: 'ml-inference',
    },
    async execute(input) {
      const { prompt, model = 'qwen2.5:7b', system } = input;
      if (!prompt) throw new Error('prompt is required');

      const available = await isNodeAvailable('mac-mini');
      if (!available) throw new Error('Mac Mini is offline');

      const fullPrompt = system ? `System: ${system}\n\nUser: ${prompt}` : prompt;
      const escaped = fullPrompt.replace(/'/g, "'\\''");

      const result = await compute('mac-mini',
        `ollama run ${model} '${escaped}'`,
        { timeout: 120000 }
      );

      return { text: result.stdout?.trim() || '', model };
    },
  },

  // ── System Info ──────────────────────────────────────────────────────
  'compute-status': {
    name: 'compute-status',
    description: 'Get Mac Mini compute node status: CPU, memory, disk, running processes',
    category: TOOL_CATEGORIES.SYSTEM,
    permissions: { readOnly: true, destructive: false, concurrencySafe: true },
    defaultPermission: PERMISSION_LEVELS.ALWAYS_ALLOW,
    requiredFeatures: ['REMOTE_COMPUTE'],
    metadata: { node: 'mac-mini' },
    async execute() {
      const available = await isNodeAvailable('mac-mini');
      if (!available) return { online: false };

      const [sysinfo, disk, processes] = await Promise.all([
        compute('mac-mini', 'sysctl -n hw.memsize && sysctl -n hw.ncpu && uptime', { timeout: 10000 }),
        compute('mac-mini', 'df -h /Users/msoldev | tail -1', { timeout: 10000 }),
        compute('mac-mini', 'ps aux --sort=-pcpu | head -8', { timeout: 10000 }),
      ]);

      return {
        online: true,
        system: sysinfo.stdout?.trim(),
        disk: disk.stdout?.trim(),
        topProcesses: processes.stdout?.trim(),
      };
    },
  },
};

// ── Registration ────────────────────────────────────────────────────────

/**
 * Register all compute tools in the tool registry.
 * @param {ToolRegistry} registry
 * @returns {number} Number of tools registered
 */
export function registerComputeTools(registry) {
  if (!feature('REMOTE_COMPUTE')) {
    console.log('[compute-tools] REMOTE_COMPUTE feature disabled, skipping registration');
    return 0;
  }

  let count = 0;
  for (const [name, def] of Object.entries(COMPUTE_TOOLS)) {
    const tool = buildTool({
      ...def,
      allowedTools: [name],
    });
    // Attach execute function
    tool._execute = def.execute;
    registry.register(tool);
    count++;
  }

  console.log(`[compute-tools] Registered ${count} compute tools`);
  return count;
}

/**
 * Execute a compute tool by name.
 * @param {string} toolName
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function executeComputeTool(toolName, input) {
  const def = COMPUTE_TOOLS[toolName];
  if (!def) throw new Error(`Unknown compute tool: ${toolName}`);
  return def.execute(input);
}

/**
 * Get status of all compute tools.
 */
export async function getComputeToolStatus() {
  const macAvailable = await isNodeAvailable('mac-mini').catch(() => false);

  return {
    macMini: {
      online: macAvailable,
    },
    tools: Object.entries(COMPUTE_TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      category: def.category,
      available: macAvailable && feature('REMOTE_COMPUTE'),
      metadata: def.metadata,
    })),
  };
}

/**
 * List all compute tool names.
 */
export function listComputeTools() {
  return Object.keys(COMPUTE_TOOLS);
}

export default {
  registerComputeTools,
  executeComputeTool,
  getComputeToolStatus,
  listComputeTools,
  COMPUTE_TOOLS,
};
