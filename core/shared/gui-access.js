/**
 * GUI Access — Shared Module (v3 - Direct SSH)
 *
 * Gives agents the ability to interact with macOS GUI on the Mac Mini
 * via direct SSH commands — no HTTP server needed.
 *
 * Architecture:
 *   Agent -> SSH -> Python CoreGraphics (screenshot) + osascript + cliclick
 *
 * Requirements on Mac Mini:
 *   - Terminal has Screen Recording permission (for screenshots)
 *   - Terminal has Accessibility permission (for mouse/keyboard)
 *   - cliclick installed via brew
 *   - Python3 with PyObjC (ships with macOS)
 *
 * Usage:
 *   import gui from '../shared/gui-access.js';
 *
 *   await gui.screenshot();           // Take screenshot, returns local path
 *   await gui.click(500, 300);        // Click at coordinates
 *   await gui.type('Hello world');    // Type text
 *   await gui.openApp('Safari');      // Open app
 *   await gui.applescript('...');     // Run AppleScript
 *   await gui.readScreen();           // OCR screen text
 */

import { compute, downloadFile, isNodeAvailable } from './compute.js';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_ID = 'mac-mini';
const REMOTE_TMP = '/tmp/claude-compute/gui';
const LOCAL_TMP = path.resolve(__dirname, '..', 'compute', 'tmp', 'gui');
const BREW_PATH = '/opt/homebrew/bin';

if (!existsSync(LOCAL_TMP)) mkdirSync(LOCAL_TMP, { recursive: true });

// --- Helpers ---

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureOnline() {
  const online = await isNodeAvailable(NODE_ID);
  if (!online) throw new Error('Mac Mini is offline — GUI access unavailable');
  return true;
}

async function ssh(cmd, timeout = 30000) {
  await ensureOnline();
  const result = await compute(NODE_ID, `export PATH=${BREW_PATH}:/usr/local/bin:$PATH && mkdir -p ${REMOTE_TMP} && ${cmd}`, { timeout });
  return result;
}

// --- Screenshot ---

const SCREENSHOT_SCRIPT = `
import Quartz.CoreGraphics as CG
from AppKit import NSBitmapImageRep, NSPNGFileType
import sys

region = None
if len(sys.argv) > 1 and sys.argv[1] != 'full':
    parts = sys.argv[1].split(',')
    region = CG.CGRectMake(float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]))

if region:
    image = CG.CGWindowListCreateImage(
        region,
        CG.kCGWindowListOptionOnScreenOnly,
        CG.kCGNullWindowID,
        CG.kCGWindowImageDefault
    )
else:
    image = CG.CGWindowListCreateImage(
        CG.CGRectInfinite,
        CG.kCGWindowListOptionOnScreenOnly,
        CG.kCGNullWindowID,
        CG.kCGWindowImageDefault
    )

if image:
    rep = NSBitmapImageRep.alloc().initWithCGImage_(image)
    data = rep.representationUsingType_properties_(NSPNGFileType, None)
    outpath = sys.argv[-1]
    data.writeToFile_atomically_(outpath, True)
    import os
    print(f"OK {os.path.getsize(outpath)}")
else:
    print("FAIL")
    sys.exit(1)
`.trim();

/**
 * Take a screenshot and download it locally
 * @param {object} opts
 * @param {'full'|'region'} opts.mode - Screenshot mode
 * @param {{x,y,w,h}} opts.region - Region for mode='region'
 * @param {string} opts.filename - Custom filename
 * @returns {Promise<string>} Local file path to screenshot
 */
async function screenshot(opts = {}) {
  const filename = opts.filename || `screenshot-${timestamp()}.png`;
  const remotePath = `${REMOTE_TMP}/${filename}`;
  const localPath = path.join(LOCAL_TMP, filename);

  let regionArg = 'full';
  if (opts.mode === 'region' && opts.region) {
    const r = opts.region;
    regionArg = `${r.x},${r.y},${r.w},${r.h}`;
  }

  // Try native screencapture first (faster, more reliable)
  if (regionArg === 'full') {
    const result = await ssh(
      `screencapture -x "${remotePath}" && ls -la "${remotePath}" && echo OK`,
      15000
    );
    if (result.stdout.includes('OK')) {
      await downloadFile(NODE_ID, remotePath, localPath);
      await compute(NODE_ID, `rm -f "${remotePath}"`, { timeout: 5000 }).catch(() => {});
      return localPath;
    }
  }

  // Fallback to Python CoreGraphics (supports regions)
  const escaped = SCREENSHOT_SCRIPT.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const result = await ssh(
    `python3 -c "${escaped}" ${regionArg} "${remotePath}"`,
    15000
  );

  if (!result.stdout.includes('OK')) {
    throw new Error(`Screenshot failed: ${result.stdout} ${result.stderr}`);
  }

  await downloadFile(NODE_ID, remotePath, localPath);
  await compute(NODE_ID, `rm -f "${remotePath}"`, { timeout: 5000 }).catch(() => {});

  return localPath;
}

// --- Mouse Control ---

async function click(x, y, opts = {}) {
  const button = opts.button || 'left';
  const clicks = opts.clicks || 1;
  const cmd = button === 'right' ? 'rc' : (clicks === 2 ? 'dc' : 'c');
  return ssh(`cliclick ${cmd}:${Math.round(x)},${Math.round(y)}`);
}

async function moveMouse(x, y) {
  return ssh(`cliclick m:${Math.round(x)},${Math.round(y)}`);
}

async function drag(fromX, fromY, toX, toY) {
  return ssh(`cliclick dd:${Math.round(fromX)},${Math.round(fromY)} du:${Math.round(toX)},${Math.round(toY)}`);
}

async function scroll(x, y, amount) {
  const steps = Math.abs(amount);
  const direction = amount > 0 ? 1 : -1;
  await ssh(`cliclick m:${Math.round(x)},${Math.round(y)}`);
  return applescript(`
    tell application "System Events"
      repeat ${steps} times
        key code ${direction > 0 ? 126 : 125}
      end repeat
    end tell
  `);
}

/**
 * Execute multiple cliclick commands in a single SSH call (much faster)
 * @param {string[]} commands - Array of cliclick commands like ['c:200,300', 'w:500', 't:hello']
 * @returns {Promise<object>}
 */
async function batch(commands) {
  return ssh(`cliclick ${commands.join(' ')}`);
}

/**
 * Wait helper — returns a promise that resolves after ms milliseconds
 * @param {number} ms
 */
function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getMousePosition() {
  const result = await ssh('cliclick p:.');
  const match = result.stdout.trim().match(/(\d+),(\d+)/);
  if (match) return { x: parseInt(match[1]), y: parseInt(match[2]) };
  throw new Error('Could not get mouse position');
}

// --- Keyboard ---

async function type(text) {
  const escaped = text.replace(/'/g, "'\\''");
  return ssh(`cliclick t:'${escaped}'`);
}

async function keyCombo(combo) {
  const mapped = combo
    .replace(/cmd/g, 'cmd')
    .replace(/ctrl/g, 'ctrl')
    .replace(/alt|option/g, 'alt')
    .replace(/shift/g, 'shift');
  return ssh(`cliclick kp:${mapped}`);
}

async function pressKey(key) {
  return ssh(`cliclick kp:${key}`);
}

// --- Applications ---

async function openApp(appName) {
  return ssh(`open -a "${appName}"`);
}

async function openFile(filePath) {
  return ssh(`open "${filePath}"`);
}

async function openURL(url) {
  return ssh(`open "${url}"`);
}

async function quitApp(appName) {
  return applescript(`tell application "${appName}" to quit`);
}

async function listRunningApps() {
  const result = await applescript(
    'tell application "System Events" to get name of every process whose visible is true'
  );
  return result.split(', ').map(a => a.trim()).filter(Boolean);
}

async function isAppRunning(appName) {
  const apps = await listRunningApps();
  return apps.some(a => a.toLowerCase() === appName.toLowerCase());
}

// --- Windows ---

async function listWindows() {
  const result = await applescript(`
    tell application "System Events"
      set windowList to {}
      repeat with proc in (every process whose visible is true)
        try
          repeat with w in (every window of proc)
            set end of windowList to (name of proc) & " — " & (name of w)
          end repeat
        end try
      end repeat
      return windowList as text
    end tell
  `);
  return result.split(', ').filter(Boolean);
}

async function focusWindow(appName) {
  return applescript(`
    tell application "${appName}" to activate
  `);
}

async function resizeWindow(appName, width, height) {
  return applescript(`
    tell application "System Events" to tell process "${appName}"
      set size of window 1 to {${width}, ${height}}
    end tell
  `);
}

async function moveWindow(appName, x, y) {
  return applescript(`
    tell application "System Events" to tell process "${appName}"
      set position of window 1 to {${x}, ${y}}
    end tell
  `);
}

async function minimizeWindow(appName) {
  return applescript(`tell application "${appName}" to set miniaturized of window 1 to true`);
}

async function maximizeWindow(appName) {
  return applescript(`
    tell application "System Events"
      tell process "${appName}"
        set position of window 1 to {0, 25}
        set size of window 1 to {2560, 1415}
      end tell
    end tell
  `);
}

// --- Screen Reading / OCR ---

async function readScreen(opts = {}) {
  const filename = `ocr-${timestamp()}.png`;
  const remotePath = `${REMOTE_TMP}/${filename}`;

  let regionArg = 'full';
  if (opts.region) {
    const r = opts.region;
    regionArg = `${r.x},${r.y},${r.w},${r.h}`;
  }

  const escaped = SCREENSHOT_SCRIPT.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  await ssh(`python3 -c "${escaped}" ${regionArg} "${remotePath}"`, 15000);

  const result = await ssh(`tesseract "${remotePath}" - 2>/dev/null`, 30000);
  await ssh(`rm -f "${remotePath}"`, 5000).catch(() => {});
  return result.stdout || '';
}

// --- AppleScript / Shortcuts ---

async function applescript(script) {
  const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = await ssh(`osascript -e "${escaped}"`, 30000);
  return result.stdout.trim();
}

async function runShortcut(name, input = '') {
  const inputArg = input ? `--input-type text --input "${input}"` : '';
  const result = await ssh(`shortcuts run "${name}" ${inputArg}`, 60000);
  return result.stdout || '';
}

// --- Notifications ---

async function notify(title, message) {
  return applescript(
    `display notification "${message}" with title "${title}"`
  );
}

async function dialog(message, title = 'Agent') {
  const result = await applescript(`
    try
      display dialog "${message}" with title "${title}" buttons {"Cancel", "OK"} default button "OK"
      return button returned of result
    on error
      return "Cancel"
    end try
  `);
  return result || 'Cancel';
}

// --- Clipboard ---

async function getClipboard() {
  const result = await ssh('pbpaste');
  return result.stdout || '';
}

async function setClipboard(text) {
  const escaped = text.replace(/'/g, "'\\''");
  return ssh(`echo '${escaped}' | pbcopy`);
}

// --- Display Info ---

async function getDisplayInfo() {
  const result = await ssh('system_profiler SPDisplaysDataType 2>/dev/null | head -30');
  return result.stdout || '';
}

// --- Compound Actions ---

async function captureAndDescribe() {
  const imgPath = await screenshot();
  return { imagePath: imgPath, message: 'Screenshot captured — use AI vision to analyze' };
}

async function browseAndCapture(url, waitMs = 3000) {
  await openURL(url);
  await new Promise(r => setTimeout(r, waitMs));
  return screenshot();
}

async function typeInApp(appName, text) {
  await focusWindow(appName);
  await new Promise(r => setTimeout(r, 500));
  await type(text);
}

async function spotlight(query) {
  await keyCombo('cmd+space');
  await new Promise(r => setTimeout(r, 500));
  await type(query);
  await new Promise(r => setTimeout(r, 1000));
}

// --- Setup Check ---

async function checkSetup() {
  const checks = {};

  try {
    await ssh('echo OK');
    checks.ssh = { available: true };
  } catch (e) {
    checks.ssh = { available: false, error: e.message };
    return checks;
  }

  try {
    const r = await ssh(`python3 -c "
import Quartz.CoreGraphics as CG
img = CG.CGWindowListCreateImage(CG.CGRectInfinite, CG.kCGWindowListOptionOnScreenOnly, CG.kCGNullWindowID, CG.kCGWindowImageDefault)
print('OK' if img else 'FAIL')
"`);
    checks.screenshot = { available: r.stdout.includes('OK') };
  } catch (e) {
    checks.screenshot = { available: false, error: e.message };
  }

  try {
    const apps = await applescript('tell application "System Events" to get name of first process whose frontmost is true');
    checks.applescript = { available: true, frontApp: apps };
  } catch (e) {
    checks.applescript = { available: false, error: e.message };
  }

  try {
    const r = await ssh('cliclick p:.');
    checks.cliclick = { available: true, mousePos: r.stdout.trim() };
  } catch (e) {
    checks.cliclick = { available: false, error: e.message };
  }

  try {
    await ssh('which tesseract');
    checks.ocr = { available: true };
  } catch (e) {
    checks.ocr = { available: false, error: 'tesseract not installed — brew install tesseract' };
  }

  return checks;
}

// --- Export ---

const gui = {
  screenshot, click, moveMouse, drag, scroll, type, keyCombo, pressKey, batch, wait,
  openApp, openFile, openURL, quitApp, listRunningApps, isAppRunning,
  listWindows, focusWindow, resizeWindow, moveWindow, minimizeWindow, maximizeWindow,
  readScreen, applescript, runShortcut,
  notify, dialog, getClipboard, setClipboard,
  getDisplayInfo, getMousePosition,
  captureAndDescribe, browseAndCapture, typeInApp, spotlight,
  checkSetup, ensureOnline, ssh,
  NODE_ID, REMOTE_TMP, LOCAL_TMP
};

export default gui;
export {
  screenshot, click, moveMouse, drag, scroll, type, keyCombo, pressKey, batch, wait,
  openApp, openFile, openURL, quitApp, listRunningApps, isAppRunning,
  listWindows, focusWindow, resizeWindow, moveWindow, minimizeWindow, maximizeWindow,
  readScreen, applescript, runShortcut,
  notify, dialog, getClipboard, setClipboard,
  getDisplayInfo, getMousePosition,
  captureAndDescribe, browseAndCapture, typeInApp, spotlight,
  checkSetup, ensureOnline, ssh
};
