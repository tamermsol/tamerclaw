/**
 * Compute Router — Smart Task Dispatcher
 *
 * Routes tasks to the best compute node based on task type and agent.
 * Agents import this instead of raw compute.js for intelligent dispatching.
 *
 * Usage:
 *   import { dispatch, flutterBuild, transcribe, processVideo, processImage } from '../shared/compute-router.js';
 *
 *   // Auto-dispatch by task type
 *   const result = await dispatch('flutter-build', { project: '/tmp/claude-compute/hbot', command: 'build ios' });
 *
 *   // Convenience methods
 *   const transcript = await transcribe('/path/to/audio.m4a', { language: 'en' });
 *   const buildResult = await flutterBuild('/path/to/project', 'ios');
 */

import { compute, isNodeAvailable, uploadFile, downloadFile, getNodeStatus } from './compute.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPS_PATH = path.resolve(__dirname, '..', 'compute', 'capabilities.json');

let _caps = null;

async function loadCapabilities() {
  if (_caps) return _caps;
  const raw = await readFile(CAPS_PATH, 'utf-8');
  _caps = JSON.parse(raw);
  return _caps;
}

/** PATH prefix for SSH commands */
const PATH_PREFIX = 'export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:~/flutter/bin:$PATH';

/** Wrap any command with proper PATH */
function wrapCommand(cmd) {
  return `${PATH_PREFIX} && ${cmd}`;
}

/**
 * Smart dispatch — pick best node and run task
 */
export async function dispatch(taskType, opts = {}) {
  const caps = await loadCapabilities();

  // Find a node that supports this capability
  for (const [nodeId, node] of Object.entries(caps)) {
    if (node.capabilities[taskType]) {
      const available = await isNodeAvailable(nodeId);
      if (!available) {
        throw new Error(`Compute node "${nodeId}" is offline. Task "${taskType}" cannot be executed.`);
      }

      const capability = node.capabilities[taskType];
      const command = opts.command || Object.values(capability.commands)[0];

      // Replace placeholders
      let finalCmd = command;
      for (const [key, val] of Object.entries(opts)) {
        finalCmd = finalCmd.replace(`{${key}}`, val);
      }

      return compute(nodeId, wrapCommand(finalCmd), { timeout: opts.timeout || 300000 });
    }
  }

  throw new Error(`No compute node supports task type "${taskType}"`);
}

/**
 * Flutter build on Mac Mini
 * @param {string} remoteProjectPath - Path to Flutter project on Mac Mini
 * @param {string} platform - 'ios', 'macos', 'analyze', 'test'
 * @param {object} opts - { release: true, noCodesign: true }
 */
export async function flutterBuild(remoteProjectPath, platform = 'ios', opts = {}) {
  const available = await isNodeAvailable('mac-mini');
  if (!available) throw new Error('Mac Mini offline — cannot build Flutter');

  let cmd;
  switch (platform) {
    case 'ios':
      cmd = `cd ${remoteProjectPath} && ~/flutter/bin/flutter pub get && ~/flutter/bin/flutter build ios ${opts.release !== false ? '--release' : '--debug'} --no-codesign`;
      break;
    case 'macos':
      cmd = `cd ${remoteProjectPath} && ~/flutter/bin/flutter pub get && ~/flutter/bin/flutter build macos ${opts.release !== false ? '--release' : '--debug'}`;
      break;
    case 'analyze':
      cmd = `cd ${remoteProjectPath} && ~/flutter/bin/flutter analyze`;
      break;
    case 'test':
      cmd = `cd ${remoteProjectPath} && ~/flutter/bin/flutter test`;
      break;
    default:
      cmd = `cd ${remoteProjectPath} && ~/flutter/bin/flutter build ${platform}`;
  }

  return compute('mac-mini', wrapCommand(cmd), { timeout: opts.timeout || 600000 });
}

/**
 * Transcribe audio with Whisper
 * @param {string} localAudioPath - Local path to audio file
 * @param {object} opts - { language: 'en', model: 'base', format: 'txt' }
 */
export async function transcribe(localAudioPath, opts = {}) {
  const available = await isNodeAvailable('mac-mini');
  if (!available) throw new Error('Mac Mini offline — cannot transcribe');

  const lang = opts.language || 'en';
  const model = opts.model || (lang === 'ar' ? 'medium' : 'base');
  const format = opts.format || 'txt';
  const remotePath = `/tmp/claude-compute/audio_${Date.now()}${path.extname(localAudioPath)}`;
  const remoteOutput = `/tmp/claude-compute/`;

  // Upload audio
  await uploadFile('mac-mini', localAudioPath, remotePath);

  // Convert to WAV if needed
  const ext = path.extname(localAudioPath).toLowerCase();
  let inputForWhisper = remotePath;
  if (['.m4a', '.ogg', '.oga', '.mp3', '.webm', '.mp4'].includes(ext)) {
    const wavPath = remotePath.replace(ext, '.wav');
    await compute('mac-mini', wrapCommand(`ffmpeg -y -i ${remotePath} -ar 16000 -ac 1 -c:a pcm_s16le ${wavPath}`), { timeout: 60000 });
    inputForWhisper = wavPath;
  }

  // Transcribe
  const result = await compute('mac-mini', wrapCommand(
    `source ~/compute-env/bin/activate && whisper "${inputForWhisper}" --model ${model} --language ${lang} --output_format ${format} --output_dir ${remoteOutput}`
  ), { timeout: 300000 });

  // Get output filename
  const baseName = path.basename(inputForWhisper, path.extname(inputForWhisper));
  const outputRemote = `${remoteOutput}${baseName}.${format}`;
  const outputLocal = localAudioPath.replace(path.extname(localAudioPath), `.${format}`);

  // Download result
  await downloadFile('mac-mini', outputRemote, outputLocal);

  // Cleanup remote
  await compute('mac-mini', `rm -f ${remotePath} ${remotePath.replace(ext, '.wav')} ${outputRemote}`, { timeout: 10000 }).catch(() => {});

  return { transcriptPath: outputLocal, ...result };
}

/**
 * Process video with FFmpeg
 * @param {string} localVideoPath - Local path to video
 * @param {string} operation - 'compress', 'extract_audio', 'thumbnail', 'gif'
 * @param {object} opts - { outputPath, size, bitrate }
 */
export async function processVideo(localVideoPath, operation = 'compress', opts = {}) {
  const available = await isNodeAvailable('mac-mini');
  if (!available) throw new Error('Mac Mini offline — cannot process video');

  const remotePath = `/tmp/claude-compute/video_${Date.now()}${path.extname(localVideoPath)}`;
  await uploadFile('mac-mini', localVideoPath, remotePath);

  let outputExt, cmd;
  switch (operation) {
    case 'compress':
      outputExt = '.mp4';
      cmd = `ffmpeg -y -i ${remotePath} -c:v hevc_videotoolbox -b:v ${opts.bitrate || '2M'} -c:a aac -b:a 128k ${remotePath}${outputExt}`;
      break;
    case 'extract_audio':
      outputExt = '.wav';
      cmd = `ffmpeg -y -i ${remotePath} -vn -acodec pcm_s16le -ar 16000 -ac 1 ${remotePath}${outputExt}`;
      break;
    case 'thumbnail':
      outputExt = '.jpg';
      cmd = `ffmpeg -y -i ${remotePath} -ss 00:00:01 -vframes 1 ${remotePath}${outputExt}`;
      break;
    case 'gif':
      outputExt = '.gif';
      cmd = `ffmpeg -y -i ${remotePath} -vf 'fps=10,scale=${opts.size || '480'}:-1:flags=lanczos' -c:v gif ${remotePath}${outputExt}`;
      break;
    default:
      throw new Error(`Unknown video operation: ${operation}`);
  }

  const result = await compute('mac-mini', wrapCommand(cmd), { timeout: 300000 });

  const outputLocal = opts.outputPath || localVideoPath.replace(path.extname(localVideoPath), outputExt);
  await downloadFile('mac-mini', `${remotePath}${outputExt}`, outputLocal);

  // Cleanup
  await compute('mac-mini', `rm -f ${remotePath} ${remotePath}${outputExt}`, { timeout: 10000 }).catch(() => {});

  return { outputPath: outputLocal, ...result };
}

/**
 * Process image with ImageMagick
 * @param {string} localImagePath - Local path to image
 * @param {string} operation - 'resize', 'convert', 'app_icon'
 * @param {object} opts - { outputPath, size }
 */
export async function processImage(localImagePath, operation = 'resize', opts = {}) {
  const available = await isNodeAvailable('mac-mini');
  if (!available) throw new Error('Mac Mini offline — cannot process image');

  const remotePath = `/tmp/claude-compute/img_${Date.now()}${path.extname(localImagePath)}`;
  await uploadFile('mac-mini', localImagePath, remotePath);

  let cmd, outputRemote;
  const outExt = opts.format || path.extname(localImagePath) || '.png';
  outputRemote = remotePath.replace(path.extname(remotePath), `_out${outExt}`);

  switch (operation) {
    case 'resize':
      cmd = `magick ${remotePath} -resize ${opts.size || '1024x1024'} ${outputRemote}`;
      break;
    case 'convert':
      cmd = `magick ${remotePath} ${outputRemote}`;
      break;
    case 'app_icon':
      outputRemote = remotePath.replace(path.extname(remotePath), '_icon.png');
      cmd = `magick ${remotePath} -resize 1024x1024 ${outputRemote}`;
      break;
    default:
      throw new Error(`Unknown image operation: ${operation}`);
  }

  const result = await compute('mac-mini', wrapCommand(cmd), { timeout: 60000 });

  const outputLocal = opts.outputPath || localImagePath.replace(path.extname(localImagePath), `_processed${outExt}`);
  await downloadFile('mac-mini', outputRemote, outputLocal);

  // Cleanup
  await compute('mac-mini', `rm -f ${remotePath} ${outputRemote}`, { timeout: 10000 }).catch(() => {});

  return { outputPath: outputLocal, ...result };
}

/**
 * Upload a Flutter project to Mac Mini for building
 * @param {string} localProjectPath - Local project directory
 * @param {string} projectName - Name for remote directory
 */
export async function uploadProject(localProjectPath, projectName) {
  const available = await isNodeAvailable('mac-mini');
  if (!available) throw new Error('Mac Mini offline');

  const remotePath = `/tmp/claude-compute/${projectName}`;

  const tarPath = `/tmp/${projectName}_${Date.now()}.tar.gz`;

  const { execSync } = await import('child_process');
  execSync(`tar -czf ${tarPath} -C ${localProjectPath} . --exclude=build --exclude=.dart_tool --exclude=.pub-cache --exclude=node_modules --exclude=.git`);

  await compute('mac-mini', `mkdir -p ${remotePath}`, { timeout: 10000 });
  await uploadFile('mac-mini', tarPath, `${remotePath}.tar.gz`);
  await compute('mac-mini', `cd ${remotePath} && tar -xzf ${remotePath}.tar.gz`, { timeout: 60000 });

  // Cleanup local tar
  execSync(`rm -f ${tarPath}`);

  return remotePath;
}

/**
 * Download build artifacts from Mac Mini
 * @param {string} remoteProjectPath - Remote project path
 * @param {string} localDestination - Where to put artifacts locally
 * @param {string} platform - 'ios' or 'macos'
 */
export async function downloadBuildArtifacts(remoteProjectPath, localDestination, platform = 'ios') {
  const artifactPath = platform === 'ios'
    ? `${remoteProjectPath}/build/ios/iphoneos/Runner.app`
    : `${remoteProjectPath}/build/macos/Build/Products/Release/`;

  const tarRemote = `/tmp/claude-compute/artifacts_${Date.now()}.tar.gz`;
  await compute('mac-mini', `tar -czf ${tarRemote} -C ${artifactPath} .`, { timeout: 60000 });

  const tarLocal = `${localDestination}/artifacts.tar.gz`;
  await downloadFile('mac-mini', tarRemote, tarLocal);

  const { execSync } = await import('child_process');
  execSync(`mkdir -p ${localDestination}/build && tar -xzf ${tarLocal} -C ${localDestination}/build`);
  execSync(`rm -f ${tarLocal}`);

  await compute('mac-mini', `rm -f ${tarRemote}`, { timeout: 10000 }).catch(() => {});

  return `${localDestination}/build`;
}

/**
 * Run npm/node build on Mac Mini (for Next.js, React, etc.)
 */
export async function nodeBuild(remoteProjectPath, command = 'npm run build') {
  const available = await isNodeAvailable('mac-mini');
  if (!available) throw new Error('Mac Mini offline');

  return compute('mac-mini', wrapCommand(`cd ${remoteProjectPath} && npm install && ${command}`), { timeout: 300000 });
}

/**
 * Get Mac Mini health + capabilities summary
 */
export async function getComputeStatus() {
  const available = await isNodeAvailable('mac-mini');
  if (!available) return { status: 'offline', node: 'mac-mini' };

  const status = await getNodeStatus('mac-mini');
  const caps = await loadCapabilities();

  return {
    status: 'online',
    node: 'mac-mini',
    hardware: caps['mac-mini']?.hardware,
    capabilities: Object.keys(caps['mac-mini']?.capabilities || {}),
    ...status
  };
}

export default dispatch;
