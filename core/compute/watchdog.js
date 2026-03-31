#!/usr/bin/env node
/**
 * Mac Mini Compute Watchdog
 *
 * Runs every 2 minutes via cron. Checks if the Mac Mini tunnel is alive.
 * If status changes (online->offline or offline->online), announces on relay Telegram.
 *
 * State file: <TAMERCLAW_HOME>/user/compute/watchdog-state.json
 * Cron: every 2 minutes — node <TAMERCLAW_HOME>/core/compute/watchdog.js
 */

import { execFile } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import paths from '../shared/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(paths.user, 'compute');
const STATE_FILE = path.join(STATE_DIR, 'watchdog-state.json');
const CONFIG_FILE = paths.computeConfig;

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { lastStatus: null, lastChange: null, consecutiveFails: 0 };
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw);
}

/** Load relay bot token from config for notifications */
async function loadNotifyConfig() {
  try {
    const configRaw = await readFile(paths.config, 'utf-8');
    const config = JSON.parse(configRaw);
    return {
      token: config.relay?.token || config.telegram?.relayToken,
      chatId: config.owner?.telegramId || config.telegram?.ownerId
    };
  } catch {
    return { token: null, chatId: null };
  }
}

/** Run SSH command on mac mini, return { code, stdout, stderr } */
function sshExec(config, command, timeoutMs = 15000) {
  const node = config.nodes['mac-mini'];
  if (!node) return Promise.resolve({ code: 1, stdout: '', stderr: 'no node' });

  return new Promise((resolve) => {
    const proc = execFile('ssh', [
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-p', String(node.port),
      `${node.user}@${node.host}`,
      command
    ], { timeout: timeoutMs });

    let stdout = '', stderr = '';
    proc.stdout?.on('data', (d) => stdout += d);
    proc.stderr?.on('data', (d) => stderr += d);
    proc.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
  });
}

/** Check if mac mini tunnel is alive via SSH */
async function checkAlive(config) {
  const result = await sshExec(config, 'echo ok');
  return result.code === 0 && result.stdout === 'ok';
}

/**
 * Zombie cleanup — kills stale processes and removes old temp files.
 * Runs when the Mac Mini is online.
 */
async function cleanupZombies(config) {
  const cleaned = [];

  // Kill stale curl/wget downloads (older than 30 min)
  const staleProcs = await sshExec(config,
    `ps -eo pid,etime,command | grep -E 'curl.*flutter|wget.*flutter' | grep -v grep | awk '{
      split($2, t, /[-:]/)
      if (length(t)==4) secs=t[1]*86400+t[2]*3600+t[3]*60+t[4]
      else if (length(t)==3) secs=t[1]*3600+t[2]*60+t[3]
      else if (length(t)==2) secs=t[1]*60+t[2]
      else secs=t[1]
      if (secs > 1800) print $1
    }' | xargs -I{} sh -c 'kill {} 2>/dev/null && echo "killed-download {}"' 2>/dev/null || true`
  );
  if (staleProcs.stdout) cleaned.push(`downloads: ${staleProcs.stdout}`);

  // Kill stale flutter processes (older than 60 min)
  const staleFlutter = await sshExec(config,
    `ps -eo pid,etime,command | grep -E 'flutter|dart' | grep -v grep | awk '{
      split($2, t, /[-:]/)
      if (length(t)==4) secs=t[1]*86400+t[2]*3600+t[3]*60+t[4]
      else if (length(t)==3) secs=t[1]*3600+t[2]*60+t[3]
      else if (length(t)==2) secs=t[1]*60+t[2]
      else secs=t[1]
      if (secs > 3600) print $1
    }' | xargs -I{} sh -c 'kill {} 2>/dev/null && echo "killed-flutter {}"' 2>/dev/null || true`
  );
  if (staleFlutter.stdout) cleaned.push(`flutter: ${staleFlutter.stdout}`);

  // Kill stale xcodebuild (older than 90 min)
  const staleXcode = await sshExec(config,
    `ps -eo pid,etime,command | grep xcodebuild | grep -v grep | awk '{
      split($2, t, /[-:]/)
      if (length(t)==4) secs=t[1]*86400+t[2]*3600+t[3]*60+t[4]
      else if (length(t)==3) secs=t[1]*3600+t[2]*60+t[3]
      else if (length(t)==2) secs=t[1]*60+t[2]
      else secs=t[1]
      if (secs > 5400) print $1
    }' | xargs -I{} sh -c 'kill {} 2>/dev/null && echo "killed-xcode {}"' 2>/dev/null || true`
  );
  if (staleXcode.stdout) cleaned.push(`xcode: ${staleXcode.stdout}`);

  // Clean temp files older than 2 hours
  const staleFiles = await sshExec(config,
    `find /tmp/claude-compute -type f -mmin +120 -delete -print 2>/dev/null | wc -l || echo 0`
  );
  const fileCount = parseInt(staleFiles.stdout) || 0;
  if (fileCount > 0) cleaned.push(`temp files removed: ${fileCount}`);

  // Clean empty directories in temp
  await sshExec(config,
    `find /tmp/claude-compute -type d -empty -delete 2>/dev/null || true`
  );

  return cleaned;
}

/** Send a Telegram notification (if relay bot configured) */
function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) {
    console.log('[watchdog] No relay bot configured — skipping Telegram notification');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const config = await loadConfig();
  const state = await loadState();
  const notify = await loadNotifyConfig();
  const alive = await checkAlive(config);
  const now = new Date().toISOString();

  const currentStatus = alive ? 'online' : 'offline';
  const previousStatus = state.lastStatus;

  // Track consecutive failures before announcing offline (avoid flapping)
  if (!alive) {
    state.consecutiveFails = (state.consecutiveFails || 0) + 1;
  } else {
    state.consecutiveFails = 0;
  }

  // Only announce after 2 consecutive failures (4 minutes) to avoid false alarms
  const shouldAnnounceOffline = !alive && state.consecutiveFails >= 2 && previousStatus !== 'offline';
  const shouldAnnounceOnline = alive && previousStatus === 'offline';

  // Run zombie cleanup when online (silent — only log, don't spam Telegram)
  if (alive) {
    try {
      const cleaned = await cleanupZombies(config);
      if (cleaned.length > 0) {
        console.log(`[${now}] Zombie cleanup: ${cleaned.join(', ')}`);
        // Only notify on actual zombie PROCESS kills, not routine temp file cleanup
        const processKills = cleaned.filter(c => !c.startsWith('temp files removed'));
        if (processKills.length > 0) {
          await sendTelegramMessage(notify.token, notify.chatId,
            `\u{1F9F9} <b>Mac Mini — Zombie Cleanup</b>\n\n` +
            processKills.map(c => `\u2022 ${c}`).join('\n')
          );
        }
      }
    } catch (err) {
      console.log(`[${now}] Cleanup error: ${err.message}`);
    }
  }

  if (shouldAnnounceOffline) {
    console.log(`[${now}] Mac Mini went OFFLINE — announcing`);
    await sendTelegramMessage(notify.token, notify.chatId,
      `\u26A0\uFE0F <b>Mac Mini Compute Node — OFFLINE</b>\n\n` +
      `The Mac Mini tunnel dropped. Possible causes:\n` +
      `\u2022 WiFi network changed\n` +
      `\u2022 Mac Mini restarted\n` +
      `\u2022 Internet disruption\n\n` +
      `autossh should auto-reconnect. If it doesn't come back in ~5 min, check the Mac Mini.`
    );
    state.lastStatus = 'offline';
    state.lastChange = now;
  } else if (shouldAnnounceOnline) {
    console.log(`[${now}] Mac Mini back ONLINE — announcing`);
    await sendTelegramMessage(notify.token, notify.chatId,
      `\u2705 <b>Mac Mini Compute Node — BACK ONLINE</b>\n\n` +
      `Tunnel reconnected successfully. All agents can use compute extension again.`
    );
    state.lastStatus = 'online';
    state.lastChange = now;
  } else if (previousStatus === null) {
    console.log(`[${now}] Watchdog first run — Mac Mini is ${currentStatus}`);
    state.lastStatus = currentStatus;
    state.lastChange = now;
  } else {
    console.log(`[${now}] Mac Mini: ${currentStatus} (no change)`);
  }

  await saveState(state);
}

main().catch(err => {
  console.error('Watchdog error:', err.message);
  process.exit(1);
});
