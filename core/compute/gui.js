/**
 * GUI Agent — Remote Mac Mini GUI Control
 *
 * Sends GUI commands to the Mac Mini's Aqua session via a file-based queue.
 * The gui-server.sh LaunchAgent on the Mac processes commands in the GUI context,
 * enabling screencapture, osascript, cliclick, etc. that fail from plain SSH.
 *
 * Usage:
 *   import { screenshot, click, type, key, openApp, openUrl, runAppleScript, guiShell } from '../compute/gui.js';
 *
 *   const img = await screenshot();                    // full screenshot, returns local path
 *   const img2 = await screenshot({ x:0, y:0, w:800, h:600 }); // region
 *   await click(500, 300);
 *   await doubleClick(500, 300);
 *   await rightClick(500, 300);
 *   await type('Hello');
 *   await key('cmd+c');
 *   await moveMouse(100, 200);
 *   await drag(100, 200, 400, 500);
 *   await openApp('Safari');
 *   await openUrl('https://google.com');
 *   const result = await runAppleScript('tell app "Finder" to get name of front window');
 *   const output = await guiShell('defaults read com.apple.dock');
 */

import { compute, uploadFile, downloadFile } from '../shared/compute.js';
import { mkdirSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NODE_ID = 'mac-mini';
const QUEUE_DIR = '/tmp/claude-compute/gui-queue';
const SCREENSHOTS_REMOTE = '/tmp/claude-compute/screenshots';
const SCREENSHOTS_LOCAL = path.resolve(__dirname, 'tmp', 'screenshots');
const POLL_INTERVAL_MS = 300;
const DEFAULT_TIMEOUT_MS = 30000;
const SCREENSHOT_TIMEOUT_MS = 15000;

// Ensure local screenshots dir exists
if (!existsSync(SCREENSHOTS_LOCAL)) {
  mkdirSync(SCREENSHOTS_LOCAL, { recursive: true });
}

/** Generate a unique command ID */
function cmdId() {
  return Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
}

/**
 * Send a command to the GUI agent queue and wait for result.
 * @param {string} type - Command type (screenshot, click, type, key, etc.)
 * @param {object} args - Command arguments
 * @param {number} [timeout] - Timeout in ms
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
async function sendCommand(type, args = {}, timeout = DEFAULT_TIMEOUT_MS) {
  const id = cmdId();
  const cmdFile = `${QUEUE_DIR}/${id}.cmd`;
  const resultFile = `${QUEUE_DIR}/${id}.result`;

  // Write command file to remote queue via SSH
  const cmdJson = JSON.stringify({ type, args });
  // Use printf to avoid echo interpretation issues with special chars
  const escaped = cmdJson.replace(/'/g, "'\\''");
  await compute(NODE_ID, `mkdir -p ${QUEUE_DIR} && printf '%s' '${escaped}' > ${cmdFile}`, { timeout: 10000 });

  // Poll for result
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const check = await compute(NODE_ID, `cat ${resultFile} 2>/dev/null && rm -f ${resultFile} || echo '__PENDING__'`, { timeout: 10000 });
    const out = check.stdout.trim();
    if (out && out !== '__PENDING__') {
      try {
        return JSON.parse(out);
      } catch {
        return { success: false, error: `Invalid result JSON: ${out}` };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout — clean up
  await compute(NODE_ID, `rm -f ${cmdFile} ${resultFile}`, { timeout: 5000 }).catch(() => {});
  return { success: false, error: `GUI command timed out after ${timeout}ms (type=${type})` };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== Public API ====================

/**
 * Take a screenshot of the Mac Mini display.
 * @param {object} [region] - Optional {x, y, w, h} for region capture
 * @returns {Promise<string>} Local path to downloaded PNG
 */
export async function screenshot(region) {
  const ts = Date.now();
  const filename = `screenshot-${ts}.png`;
  const remotePath = `${SCREENSHOTS_REMOTE}/${filename}`;
  const localPath = path.join(SCREENSHOTS_LOCAL, filename);

  let result;
  if (region && typeof region.x === 'number') {
    result = await sendCommand('screenshot-region', {
      path: remotePath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h
    }, SCREENSHOT_TIMEOUT_MS);
  } else {
    result = await sendCommand('screenshot', { path: remotePath }, SCREENSHOT_TIMEOUT_MS);
  }

  if (!result.success) {
    throw new Error(`Screenshot failed: ${result.error}`);
  }

  // Download to local
  await downloadFile(NODE_ID, remotePath, localPath);

  // Clean up remote
  await compute(NODE_ID, `rm -f ${remotePath}`, { timeout: 5000 }).catch(() => {});

  return localPath;
}

/**
 * Click at coordinates.
 * @param {number} x
 * @param {number} y
 */
export async function click(x, y) {
  const result = await sendCommand('click', { x, y });
  if (!result.success) throw new Error(`Click failed: ${result.error}`);
  return result.data;
}

/**
 * Double-click at coordinates.
 * @param {number} x
 * @param {number} y
 */
export async function doubleClick(x, y) {
  const result = await sendCommand('doubleclick', { x, y });
  if (!result.success) throw new Error(`Double-click failed: ${result.error}`);
  return result.data;
}

/**
 * Right-click at coordinates.
 * @param {number} x
 * @param {number} y
 */
export async function rightClick(x, y) {
  const result = await sendCommand('rightclick', { x, y });
  if (!result.success) throw new Error(`Right-click failed: ${result.error}`);
  return result.data;
}

/**
 * Type text at current cursor position.
 * @param {string} text
 */
export async function type(text) {
  const result = await sendCommand('type', { text });
  if (!result.success) throw new Error(`Type failed: ${result.error}`);
  return result.data;
}

/**
 * Send a key combo (e.g., 'cmd+c', 'cmd+shift+s', 'return', 'escape').
 * @param {string} combo
 */
export async function key(combo) {
  const result = await sendCommand('key', { combo });
  if (!result.success) throw new Error(`Key combo failed: ${result.error}`);
  return result.data;
}

/**
 * Move mouse to coordinates (without clicking).
 * @param {number} x
 * @param {number} y
 */
export async function moveMouse(x, y) {
  const result = await sendCommand('move', { x, y });
  if (!result.success) throw new Error(`Move failed: ${result.error}`);
  return result.data;
}

/**
 * Drag from (x1,y1) to (x2,y2).
 */
export async function drag(x1, y1, x2, y2) {
  const result = await sendCommand('drag', { x1, y1, x2, y2 });
  if (!result.success) throw new Error(`Drag failed: ${result.error}`);
  return result.data;
}

/**
 * Open a macOS application by name.
 * @param {string} name - App name (e.g., 'Safari', 'Finder', 'Terminal')
 */
export async function openApp(name) {
  const result = await sendCommand('open-app', { name });
  if (!result.success) throw new Error(`Open app failed: ${result.error}`);
  return result.data;
}

/**
 * Open a URL in the default browser.
 * @param {string} url
 */
export async function openUrl(url) {
  const result = await sendCommand('open-url', { url });
  if (!result.success) throw new Error(`Open URL failed: ${result.error}`);
  return result.data;
}

/**
 * Run an AppleScript in the GUI session.
 * @param {string} script - AppleScript code
 * @returns {Promise<string>} Script output
 */
export async function runAppleScript(script) {
  const result = await sendCommand('applescript', { script }, 60000);
  if (!result.success) throw new Error(`AppleScript failed: ${result.error}`);
  return result.data;
}

/**
 * Run a shell command in the GUI session context.
 * @param {string} command
 * @param {number} [timeout=30000]
 * @returns {Promise<string>} Command output
 */
export async function guiShell(command, timeout = 30000) {
  const result = await sendCommand('shell', { command }, timeout);
  if (!result.success) throw new Error(`GUI shell failed: ${result.error}`);
  return result.data;
}

/**
 * Check if the GUI agent server is running on the Mac.
 * @returns {Promise<boolean>}
 */
export async function isGuiAgentRunning() {
  try {
    const check = await compute(NODE_ID, 'pgrep -f gui-server.sh', { timeout: 10000 });
    return check.code === 0 && check.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get GUI agent server log tail.
 * @param {number} [lines=50]
 * @returns {Promise<string>}
 */
export async function getGuiLog(lines = 50) {
  const result = await compute(NODE_ID, `tail -${lines} /tmp/claude-compute/gui-server.log 2>/dev/null || echo '(no log)'`, { timeout: 10000 });
  return result.stdout;
}

export default {
  screenshot,
  click,
  doubleClick,
  rightClick,
  type,
  key,
  moveMouse,
  drag,
  openApp,
  openUrl,
  runAppleScript,
  guiShell,
  isGuiAgentRunning,
  getGuiLog
};
