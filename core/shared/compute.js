/**
 * Compute Extension — Shared Module
 *
 * Lets any agent dispatch tasks to remote compute nodes (Mac Mini, etc.)
 * via SSH. Import this module and call the functions to offload work.
 *
 * Usage:
 *   import { compute, isNodeAvailable, getNodes } from '../shared/compute.js';
 *
 *   // Run a command on Mac Mini
 *   const result = await compute('mac-mini', 'uname -a');
 *
 *   // Run a script
 *   const out = await compute('mac-mini', 'python3 /tmp/claude-compute/process.py');
 *
 *   // Transfer file, process, retrieve result
 *   await uploadFile('mac-mini', './audio.m4a', '/tmp/claude-compute/audio.m4a');
 *   await compute('mac-mini', 'ffmpeg -i /tmp/claude-compute/audio.m4a /tmp/claude-compute/audio.wav');
 *   await downloadFile('mac-mini', '/tmp/claude-compute/audio.wav', './audio.wav');
 */

import { execFile, spawn } from 'child_process';
import { readFile } from 'fs/promises';
import paths from './paths.js';

const CONFIG_PATH = paths.computeConfig;

let _config = null;

/** Load compute config (cached after first read) */
async function loadConfig() {
  if (_config) return _config;
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  _config = JSON.parse(raw);
  return _config;
}

/** Force reload config */
export async function reloadConfig() {
  _config = null;
  return loadConfig();
}

/** Get all configured nodes */
export async function getNodes() {
  const config = await loadConfig();
  return Object.entries(config.nodes).map(([id, node]) => ({ id, ...node }));
}

/** Get a specific node by ID */
export async function getNode(nodeId) {
  const config = await loadConfig();
  const node = config.nodes[nodeId];
  if (!node) throw new Error(`Compute node "${nodeId}" not found in config`);
  return node;
}

/** Extra PATH entries for nodes (SSH non-login shells miss these) */
const NODE_PATH_PREFIX = {
  'mac-mini': 'export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/Users/msoldev/Library/Python/3.9/bin:$PATH'
};

/** Build SSH args for a node */
function sshArgs(node) {
  return [
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-p', String(node.port),
    `${node.user}@${node.host}`
  ];
}

/** Wrap command with node-specific PATH prefix */
function wrapCmd(nodeId, command) {
  const prefix = NODE_PATH_PREFIX[nodeId];
  return prefix ? `${prefix} && ${command}` : command;
}

/**
 * Check if a compute node is reachable
 * @param {string} nodeId - e.g. 'mac-mini'
 * @returns {Promise<boolean>}
 */
export async function isNodeAvailable(nodeId) {
  try {
    const node = await getNode(nodeId);
    return new Promise((resolve) => {
      const proc = execFile('ssh', [...sshArgs(node), 'echo ok'], { timeout: 15000 });
      let output = '';
      proc.stdout?.on('data', (d) => output += d);
      proc.on('close', (code) => resolve(code === 0 && output.trim() === 'ok'));
      proc.on('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}

/**
 * Execute a command on a remote compute node
 * @param {string} nodeId - e.g. 'mac-mini'
 * @param {string} command - shell command to run
 * @param {object} [opts] - { timeout, cwd }
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function compute(nodeId, command, opts = {}) {
  const config = await loadConfig();
  const node = await getNode(nodeId);
  const timeout = opts.timeout || config.defaults.timeout_ms;

  // Ensure temp dir exists on remote, with correct PATH for the node
  const fullCmd = wrapCmd(nodeId, `mkdir -p ${config.defaults.temp_dir_remote} && ${command}`);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = execFile('ssh', [...sshArgs(node), fullCmd], { timeout, maxBuffer: 50 * 1024 * 1024 });

    proc.stdout?.on('data', (d) => stdout += d);
    proc.stderr?.on('data', (d) => stderr += d);

    proc.on('close', (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
    });

    proc.on('error', (err) => {
      reject(new Error(`Compute SSH error on ${nodeId}: ${err.message}`));
    });
  });
}

/**
 * Upload a file to a compute node
 * @param {string} nodeId
 * @param {string} localPath
 * @param {string} remotePath
 */
export async function uploadFile(nodeId, localPath, remotePath) {
  const node = await getNode(nodeId);
  const config = await loadConfig();

  // Ensure remote directory exists
  await compute(nodeId, `mkdir -p $(dirname ${remotePath})`);

  return new Promise((resolve, reject) => {
    const proc = execFile('scp', [
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-P', String(node.port),
      localPath,
      `${node.user}@${node.host}:${remotePath}`
    ], { timeout: config.defaults.timeout_ms });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SCP upload failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Download a file from a compute node
 * @param {string} nodeId
 * @param {string} remotePath
 * @param {string} localPath
 */
export async function downloadFile(nodeId, remotePath, localPath) {
  const node = await getNode(nodeId);
  const config = await loadConfig();

  return new Promise((resolve, reject) => {
    const proc = execFile('scp', [
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-P', String(node.port),
      `${node.user}@${node.host}:${remotePath}`,
      localPath
    ], { timeout: config.defaults.timeout_ms });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SCP download failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Run a streaming command (for long-running tasks)
 * Returns a child process with stdout/stderr streams
 */
export async function computeStream(nodeId, command) {
  const config = await loadConfig();
  const node = await getNode(nodeId);
  const fullCmd = wrapCmd(nodeId, `mkdir -p ${config.defaults.temp_dir_remote} && ${command}`);

  return spawn('ssh', [...sshArgs(node), fullCmd]);
}

/**
 * Get system info from a node (CPU, memory, disk)
 */
export async function getNodeStatus(nodeId) {
  try {
    const result = await compute(nodeId, `
      echo "HOSTNAME: $(hostname)"
      echo "UPTIME: $(uptime)"
      echo "CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || cat /proc/cpuinfo 2>/dev/null | grep 'model name' | head -1)"
      echo "MEMORY: $(vm_stat 2>/dev/null | head -5 || free -h 2>/dev/null | head -2)"
      echo "DISK: $(df -h / | tail -1)"
      echo "LOAD: $(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg 2>/dev/null)"
    `, { timeout: 15000 });
    return { available: true, ...result };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Health check — quick ping to see if node responds
 */
export async function healthCheck(nodeId = 'mac-mini') {
  const start = Date.now();
  const available = await isNodeAvailable(nodeId);
  const latency = Date.now() - start;
  return { nodeId, available, latency_ms: latency };
}

// Default export for convenience
export default compute;
