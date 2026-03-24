/**
 * HTTP Gateway API — Tamerclaw
 * Token-based auth, agent control, message sending.
 * Port 19789, loopback only.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { addJob, removeJob, listJobs, listAllJobs, updateJob } from '../cron/scheduler.js';
import { readConfigCached } from '../shared/async-fs.js';
import paths from '../shared/paths.js';
import { transcribeAudio } from '../shared/transcribe.js';

let bridgeRef = null; // Set by bridge on startup

// ── In-memory agent activity tracking ──
// Tracks real-time activity status per agent: "idle" | "thinking" | "working" | "responding"
const agentActivity = new Map(); // agentId -> { status, since }

function setAgentActivity(agentId, status) {
  agentActivity.set(agentId, { status, since: new Date().toISOString() });
}

function getAgentActivity(agentId) {
  return agentActivity.get(agentId) || { status: 'idle', since: new Date().toISOString() };
}

// ── Disk-based session reader (for standalone gateway mode) ──

// Search multiple possible session directories (tamerclaw user dir + live system)
const LIVE_AGENTS_DIR = '/root/claude-agents/agents';
const LIVE_USER_AGENTS_DIR = '/root/claude-agents/user/agents';

function _readSessionDir(sessionDir) {
  const result = [];
  try {
    if (!fs.existsSync(sessionDir)) return result;
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const chatId = path.basename(file, '.json');
        const data = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf-8'));
        const history = data.history || [];
        const lastMsg = history.length > 0 ? history[history.length - 1] : null;
        const firstMsg = history.length > 0 ? history[0] : null;
        result.push({
          chatId: String(chatId),
          messageCount: history.length,
          lastActivity: data.lastActivity || null,
          startedAt: firstMsg?.timestamp || data.lastActivity || null,
          summary: lastMsg ? (lastMsg.content || lastMsg.text || '').substring(0, 120) : '',
          preview: firstMsg ? (firstMsg.content || firstMsg.text || '').substring(0, 80) : '',
        });
      } catch {}
    }
  } catch {}
  return result;
}

function readAgentSessionsFromDisk(agentId) {
  // Check tamerclaw user dir first
  const result = _readSessionDir(paths.sessions(agentId));
  // Also check live system sessions (bridge writes here)
  const liveDir = path.join(LIVE_AGENTS_DIR, agentId, 'sessions');
  const liveResults = _readSessionDir(liveDir);
  // Also check live user/agents path (API-originated sessions saved here)
  const liveUserDir = path.join(LIVE_USER_AGENTS_DIR, agentId, 'sessions');
  const liveUserResults = _readSessionDir(liveUserDir);
  // Merge, dedup by chatId
  const seen = new Set(result.map(r => r.chatId));
  for (const r of liveResults) {
    if (!seen.has(r.chatId)) {
      result.push(r);
      seen.add(r.chatId);
    }
  }
  for (const r of liveUserResults) {
    if (!seen.has(r.chatId)) {
      result.push(r);
      seen.add(r.chatId);
    }
  }
  // Sort by lastActivity descending
  result.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return tb - ta;
  });
  return result;
}

function getAgentSessions(agentId) {
  if (bridgeRef?.getAgentSessions) {
    return bridgeRef.getAgentSessions(agentId);
  }
  return readAgentSessionsFromDisk(agentId);
}

export function setBridge(bridge) {
  bridgeRef = bridge;
}

const CONFIG_PATH = paths.config;
async function loadConfig() {
  return readConfigCached(CONFIG_PATH);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * Parse multipart/form-data requests (for file uploads like voice notes).
 * Returns { fields: { key: value }, files: [{ fieldName, filename, mimeType, data (Buffer) }] }
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) return resolve({ fields: {}, files: [] });

        const boundary = boundaryMatch[1].trim();
        const delimiter = Buffer.from(`--${boundary}`);
        const fields = {};
        const files = [];

        // Split buffer by boundary
        let start = 0;
        const parts = [];
        while (true) {
          const idx = buf.indexOf(delimiter, start);
          if (idx === -1) break;
          if (start > 0) parts.push(buf.slice(start, idx));
          start = idx + delimiter.length;
          // Skip \r\n after boundary
          if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
          // Check for closing --
          if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
        }

        for (const part of parts) {
          // Find the header/body separator (\r\n\r\n)
          const sepIdx = part.indexOf('\r\n\r\n');
          if (sepIdx === -1) continue;

          const headerStr = part.slice(0, sepIdx).toString('utf-8');
          // Body ends before trailing \r\n
          let body = part.slice(sepIdx + 4);
          if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
            body = body.slice(0, -2);
          }

          const nameMatch = headerStr.match(/name="([^"]+)"/);
          if (!nameMatch) continue;
          const fieldName = nameMatch[1];

          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          if (filenameMatch) {
            const mimeMatch = headerStr.match(/Content-Type:\s*(.+)/i);
            files.push({
              fieldName,
              filename: filenameMatch[1],
              mimeType: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream',
              data: body,
            });
          } else {
            fields[fieldName] = body.toString('utf-8');
          }
        }

        resolve({ fields, files });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function isMultipart(req) {
  return (req.headers['content-type'] || '').includes('multipart/form-data');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Media extraction helpers ──
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];

/**
 * Extract image file paths from agent response text.
 * Agents often reference generated images by absolute path.
 * Returns { cleanText, media: [{ url, filename, mimeType }] }
 */
function extractMediaFromResponse(responseText, agentId) {
  const media = [];
  let cleanText = responseText;

  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
  const mimeTypes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  };

  function addMedia(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const filename = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        if (!imageExts.includes(ext)) return false;
        media.push({
          url: `/api/media?path=${encodeURIComponent(filePath)}`,
          filename,
          mimeType: mimeTypes[ext] || 'image/png',
          size: fs.statSync(filePath).size,
        });
        return true;
      }
    } catch {}
    return false;
  }

  // 1. Handle MEDIA: tags (e.g., MEDIA:/root/path/to/image.png or MEDIA:./relative/path.png)
  const mediaTagRegex = /MEDIA:(\.\/[^\s\n]+|\/[^\s\n]+)/g;
  let mediaTagMatch;
  while ((mediaTagMatch = mediaTagRegex.exec(responseText)) !== null) {
    let filePath = mediaTagMatch[1];
    // Resolve relative paths against agent workspace
    if (filePath.startsWith('./') && agentId) {
      const agentWs = path.join('/root/claude-agents/agents', agentId, 'workspace');
      const candidate = path.join(agentWs, filePath.slice(2));
      if (fs.existsSync(candidate)) filePath = candidate;
    }
    addMedia(filePath);
    // Remove the MEDIA: tag from text
    cleanText = cleanText.replace(mediaTagMatch[0], '');
  }

  // 2. Match bare absolute file paths to images
  const pathRegex = /(\/(?:root|home|tmp)\/[^\s"'<>|*?\n]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))/gi;
  const bareMatches = cleanText.match(pathRegex) || [];
  for (const filePath of bareMatches) {
    // Only add if not already captured via MEDIA: tag
    if (!media.some(m => m.url.includes(encodeURIComponent(filePath)))) {
      addMedia(filePath);
    }
  }

  // Clean up extra blank lines left by removed tags
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, media };
}

// ── Auth helpers ──

const AUTH_FILE = path.join(paths.user, 'auth.json');
const SESSIONS_FILE = path.join(paths.user, 'sessions.json');
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token -> { username, role, createdAt }

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      let cleaned = 0;
      for (const [token, session] of Object.entries(data)) {
        if (now - session.createdAt < SESSION_TTL) {
          sessions.set(token, session);
        } else {
          cleaned++;
        }
      }
      if (cleaned > 0) saveSessions();
      console.log(`[gateway] Restored ${sessions.size} sessions (cleaned ${cleaned} expired)`);
    }
  } catch (e) {
    console.error(`[gateway] Failed to load sessions: ${e.message}`);
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const obj = Object.fromEntries(sessions);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`[gateway] Failed to save sessions: ${e.message}`);
  }
}

// Load persisted sessions on startup
loadSessions();

function loadAuthUsers() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch {}
  return { users: [] };
}

function saveAuthUsers(data) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureDefaultAdmin(config) {
  const auth = loadAuthUsers();
  if (auth.users.length === 0) {
    // Create default admin from gateway token or generate one
    const defaultPass = config.gateway?.auth?.token || crypto.randomBytes(8).toString('hex');
    const { hash, salt } = hashPassword(defaultPass);
    auth.users.push({
      username: 'admin',
      passwordHash: hash,
      salt,
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    saveAuthUsers(auth);
    console.log(`[gateway] Created default admin user (password: ${defaultPass})`);
  }
  return auth;
}

function authenticate(req, config) {
  const gw = config.gateway;
  const auth = req.headers.authorization;
  if (!auth) {
    // No auth header — check if auth is optional (no token & no users)
    if (!gw?.auth?.token) return true;
    return false;
  }
  const token = auth.replace('Bearer ', '');
  // Check session tokens first
  if (sessions.has(token)) {
    const sess = sessions.get(token);
    if (Date.now() - sess.createdAt > SESSION_TTL) {
      sessions.delete(token);
      saveSessions();
      return false;
    }
    return true;
  }
  // Fall back to legacy static token
  if (gw?.auth?.token && token === gw.auth.token) return true;
  return false;
}

function isDenied(command, config) {
  const denied = config.gateway?.denyCommands || [];
  return denied.includes(command);
}

async function handleRequest(req, res) {
  const config = await loadConfig();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── Auth (public — no token required) ──
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.username || !body.password) {
        return json(res, 400, { error: 'username and password required' });
      }

      const authData = loadAuthUsers();
      const user = authData.users.find(u => u.username === body.username);
      if (!user) {
        return json(res, 401, { error: 'Invalid username or password' });
      }

      try {
        if (!verifyPassword(body.password, user.passwordHash, user.salt)) {
          return json(res, 401, { error: 'Invalid username or password' });
        }
      } catch {
        return json(res, 401, { error: 'Invalid username or password' });
      }

      const sessionToken = generateSessionToken();
      sessions.set(sessionToken, {
        username: user.username,
        role: user.role || 'admin',
        createdAt: Date.now(),
      });
      saveSessions();

      return json(res, 200, {
        token: sessionToken,
        username: user.username,
        role: user.role || 'admin',
      });
    }

    // ── Register user (admin only) ──
    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!authenticate(req, config)) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      const body = await parseBody(req);
      if (!body.username || !body.password) {
        return json(res, 400, { error: 'username and password required' });
      }

      const authData = loadAuthUsers();
      if (authData.users.find(u => u.username === body.username)) {
        return json(res, 409, { error: 'Username already exists' });
      }

      const { hash, salt } = hashPassword(body.password);
      authData.users.push({
        username: body.username,
        passwordHash: hash,
        salt,
        role: body.role || 'user',
        createdAt: new Date().toISOString(),
      });
      saveAuthUsers(authData);

      return json(res, 201, { ok: true, username: body.username });
    }

    // ── Auth check ──
    if (!authenticate(req, config)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    // ── Serve media files ──
    if (pathname === '/api/media' && method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return json(res, 400, { error: 'path parameter required' });

      // Security: only serve files from known agent directories
      const allowedPrefixes = ['/root/claude-agents/agents/', '/root/.openclaw/', '/tmp/'];
      const isAllowed = allowedPrefixes.some(prefix => filePath.startsWith(prefix));
      if (!isAllowed) return json(res, 403, { error: 'Access denied' });

      if (!fs.existsSync(filePath)) return json(res, 404, { error: 'File not found' });

      try {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=3600',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      } catch (err) {
        return json(res, 500, { error: 'Failed to read file' });
      }
    }

    // ── Agents ──
    if (pathname === '/api/agents' && method === 'GET') {
      const botStatuses = bridgeRef?.getBotStatuses?.() || {};
      const agents = Object.entries(config.agents).map(([id, a]) => {
        // Get full session data including disk-persisted sessions
        let sessionCount = botStatuses[id]?.sessions || 0;
        let lastActivity = null;
        const agentSessions = getAgentSessions(id);
        if (agentSessions.length > 0) {
          sessionCount = Math.max(sessionCount, agentSessions.length);
          // Most recent activity from sorted sessions (already sorted desc)
          lastActivity = agentSessions[0].lastActivity || null;
        }
        return {
          id,
          telegramAccount: a.telegramAccount,
          hasToken: !!a.botToken,
          model: a.model || config.defaults.model,
          workspace: a.workspace,
          isActive: !!botStatuses[id]?.active,
          sessions: sessionCount,
          lastActivity,
          activityStatus: getAgentActivity(id).status,
        };
      });
      return json(res, 200, { agents });
    }

    // ── Agent sessions list ──
    if (pathname.match(/^\/api\/agents\/[\w-]+\/sessions$/) && method === 'GET') {
      const agentId = pathname.split('/')[3];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });

      const sessionsList = getAgentSessions(agentId);
      return json(res, 200, { sessions: sessionsList });
    }

    // ── Session history (for continuation) ──
    if (pathname.match(/^\/api\/agents\/[\w-]+\/sessions\/[\w-]+$/) && method === 'GET') {
      const parts = pathname.split('/');
      const agentId = parts[3];
      const chatId = parts[5];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });

      if (bridgeRef?.getSessionHistory) {
        const history = bridgeRef.getSessionHistory(agentId, chatId);
        if (history) return json(res, 200, history);
      }
      // Fallback: load from disk directly (check both tamerclaw user dir and live system)
      const candidates = [
        path.join(paths.sessions(agentId), `${chatId}.json`),
        path.join(LIVE_AGENTS_DIR, agentId, 'sessions', `${chatId}.json`),
      ];
      for (const sessionFile of candidates) {
        if (fs.existsSync(sessionFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
            const history = (data.history || []).map(msg => ({
              role: msg.role || (msg.isUser ? 'user' : 'assistant'),
              content: msg.content || msg.text || '',
              timestamp: msg.timestamp || null,
            }));
            return json(res, 200, {
              chatId: String(chatId),
              agentId,
              messageCount: history.length,
              lastActivity: data.lastActivity || null,
              messages: history,
            });
          } catch {}
        }
      }
      return json(res, 404, { error: 'Session not found' });
    }

    // ── Send message to agent ──
    if (pathname.match(/^\/api\/agents\/[\w-]+\/message$/) && method === 'POST') {
      const agentId = pathname.split('/')[3];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });

      let body, mediaPath = null;

      if (isMultipart(req)) {
        // Handle file uploads (voice notes, images, etc.)
        const { fields, files } = await parseMultipart(req);
        body = { message: fields.message || '', chatId: fields.chatId };

        if (files.length > 0) {
          // Save uploaded file to agent's media directory
          const mediaDir = path.join('/root/claude-agents/agents', agentId, 'media');
          if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
          const file = files[0];
          const ext = path.extname(file.filename) || '.m4a';
          const savedName = `${Date.now()}${ext}`;
          mediaPath = path.join(mediaDir, savedName);
          fs.writeFileSync(mediaPath, file.data);

          // Auto-transcribe voice notes so all agents can understand them
          const voiceExts = ['.m4a', '.ogg', '.oga', '.opus', '.mp3', '.wav', '.webm'];
          if (voiceExts.includes(ext.toLowerCase())) {
            try {
              console.log(`[gateway] Transcribing voice note: ${mediaPath}`);
              const transcription = await transcribeAudio(mediaPath);
              // Prepend transcription to user message
              const userText = body.message && body.message !== '[Voice message]'
                ? body.message
                : '';
              body.message = `[Voice message transcription]: "${transcription}"${userText ? `\n\nAdditional text: ${userText}` : ''}`;
              console.log(`[gateway] Transcription complete: "${transcription.slice(0, 100)}"`);
            } catch (err) {
              console.error(`[gateway] Voice transcription failed: ${err.message}`);
              // Fallback: still send with media path so agent can try to read it
              if (!body.message) {
                body.message = '[Voice message - transcription failed]';
              }
            }
          } else if (!body.message) {
            body.message = '[Media file attached]';
          }
        }
      } else {
        body = await parseBody(req);
      }

      if (!body.message) return json(res, 400, { error: 'message required' });

      // ── Intercept slash commands before they reach Claude ──
      const msg = (body.message || '').trim();

      if (msg === '/sessions') {
        const agentSessionsList = getAgentSessions(agentId);
        if (agentSessionsList.length === 0) {
          return json(res, 200, { response: 'No sessions found for this agent.' });
        }
        const lines = [`📋 ${agentSessionsList.length} session(s) for ${agentId}:\n`];
        for (const s of agentSessionsList) {
          const age = s.lastActivity
            ? new Date(s.lastActivity).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
            : 'unknown';
          lines.push(`• Chat ${s.chatId.slice(-6)} — ${s.messageCount} msgs — last active: ${age}`);
          if (s.summary) lines.push(`  "${s.summary.substring(0, 80)}"`);
        }
        return json(res, 200, { response: lines.join('\n') });
      }

      if (msg === '/status') {
        const botStatuses = bridgeRef?.getBotStatuses?.() || {};
        const agentStatus = botStatuses[agentId];
        const statusText = agentStatus
          ? `✅ ${agentId} is ${agentStatus.active ? 'active' : 'inactive'} — ${agentStatus.sessions || 0} session(s)`
          : `ℹ️ ${agentId} — no status available`;
        return json(res, 200, { response: statusText });
      }

      if (msg === '/summary') {
        const summSessions = getAgentSessions(agentId);
        const totalMsgs = summSessions.reduce((sum, s) => sum + s.messageCount, 0);
        const lines = [
          `📊 Agent: ${agentId}`,
          `Sessions: ${summSessions.length}`,
          `Total messages: ${totalMsgs}`,
        ];
        if (summSessions.length > 0 && summSessions[0].lastActivity) {
          lines.push(`Last active: ${new Date(summSessions[0].lastActivity).toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })}`);
        }
        if (summSessions.length > 0 && summSessions[0].summary) {
          lines.push(`Latest: "${summSessions[0].summary.substring(0, 100)}"`);
        }
        return json(res, 200, { response: lines.join('\n') });
      }

      if (msg === '/restart') {
        return json(res, 200, { response: '⚠️ Restart must be triggered from the server. Use the Telegram bot or CLI.' });
      }

      if (bridgeRef?.sendAgentMessage) {
        // Check for async/fire-and-forget mode (used by mobile app)
        const asyncMode = url.searchParams.get('async') === 'true' || body.async === true || body.fireAndForget === 'true' || body.fireAndForget === true;

        if (asyncMode) {
          // Fire-and-forget: queue the message and return immediately
          setAgentActivity(agentId, 'thinking');
          const chatId = body.chatId || crypto.randomUUID();

          // Process in background — don't await
          bridgeRef.sendAgentMessage(agentId, body.message, chatId, mediaPath)
            .then(() => {
              setAgentActivity(agentId, 'idle');
            })
            .catch((err) => {
              console.error(`[gateway] Async message error (agent=${agentId}, chat=${chatId}):`, err.message);
              setAgentActivity(agentId, 'idle');
            });

          return json(res, 202, { queued: true, chatId });
        }

        // Synchronous mode (default — used by Telegram bridge)
        // Track activity: agent is now thinking
        setAgentActivity(agentId, 'thinking');
        try {
          const response = await bridgeRef.sendAgentMessage(agentId, body.message, body.chatId, mediaPath);
          // Agent finished — back to idle
          setAgentActivity(agentId, 'idle');
          // Extract any image file paths from the response and include as media
          const { cleanText, media } = extractMediaFromResponse(response || '', agentId);
          const result = { response: cleanText };
          if (media.length > 0) result.media = media;
          return json(res, 200, result);
        } catch (err) {
          setAgentActivity(agentId, 'idle');
          throw err;
        }
      }
      return json(res, 503, { error: 'Bridge not ready' });
    }

    // ── Agent-to-agent message ──
    if (pathname.match(/^\/api\/agents\/[\w-]+\/send-to\/[\w-]+$/) && method === 'POST') {
      const parts = pathname.split('/');
      const fromAgent = parts[3];
      const toAgent = parts[5];
      if (!config.agents[fromAgent] || !config.agents[toAgent]) {
        return json(res, 404, { error: 'Agent not found' });
      }
      const body = await parseBody(req);
      if (!body.message) return json(res, 400, { error: 'message required' });

      if (bridgeRef?.sendAgentToAgent) {
        const response = await bridgeRef.sendAgentToAgent(fromAgent, toAgent, body.message);
        return json(res, 200, { response });
      }
      return json(res, 503, { error: 'Bridge not ready' });
    }

    // ── Cron jobs ──
    if (pathname === '/api/cron/jobs' && method === 'GET') {
      const agentId = url.searchParams.get('agentId');
      const includeSystem = url.searchParams.get('system') !== 'false';
      const jobs = includeSystem ? listAllJobs(agentId) : listJobs(agentId);
      return json(res, 200, { jobs });
    }

    if (pathname === '/api/cron/jobs' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.agentId || !body.name || !body.schedule) {
        return json(res, 400, { error: 'agentId, name, and schedule required' });
      }
      const job = addJob(body);
      return json(res, 201, { job });
    }

    if (pathname.match(/^\/api\/cron\/jobs\/[\w-]+$/) && method === 'PUT') {
      const jobId = pathname.split('/').pop();
      const body = await parseBody(req);
      const job = updateJob(jobId, body);
      if (!job) return json(res, 404, { error: 'Job not found' });
      return json(res, 200, { job });
    }

    if (pathname.match(/^\/api\/cron\/jobs\/[\w-]+$/) && method === 'DELETE') {
      const jobId = pathname.split('/').pop();
      removeJob(jobId);
      return json(res, 200, { ok: true });
    }

    // ── Delivery queue ──
    if (pathname === '/api/delivery-queue' && method === 'GET') {
      return json(res, 200, { queue: bridgeRef?.getDeliveryQueue?.() || [] });
    }

    if (pathname === '/api/delivery-queue' && method === 'POST') {
      const body = await parseBody(req);
      if (bridgeRef?.enqueueDelivery) {
        bridgeRef.enqueueDelivery(body);
        return json(res, 201, { ok: true });
      }
      return json(res, 503, { error: 'Bridge not ready' });
    }

    // ── Config ──
    if (pathname === '/api/config' && method === 'GET') {
      // Return config without sensitive tokens
      const safe = { ...config };
      if (safe.agents) {
        safe.agents = Object.fromEntries(
          Object.entries(safe.agents).map(([id, a]) => [id, { ...a, botToken: a.botToken ? '[set]' : '' }])
        );
      }
      if (safe.gateway?.auth) safe.gateway.auth = { mode: safe.gateway.auth.mode };
      if (safe.telegram?.sharedBotToken) safe.telegram = { ...safe.telegram, sharedBotToken: '[set]' };
      return json(res, 200, safe);
    }

    // ── Health ──
    if (pathname === '/api/health' && method === 'GET') {
      return json(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        agents: Object.keys(config.agents).length,
        activeBots: bridgeRef?.getActiveBotCount?.() || 0,
        timestamp: new Date().toISOString()
      });
    }

    // ── Status ──
    if (pathname === '/api/status' && method === 'GET') {
      const botStatuses = bridgeRef?.getBotStatuses?.() || {};
      const totalAgents = Object.keys(config.agents).length;
      const activeAgents = Object.keys(botStatuses).length;
      let totalSessions = 0;
      // Count sessions from all agents (including disk-persisted ones)
      for (const agentId of Object.keys(config.agents)) {
        const agentSessions = getAgentSessions(agentId);
        totalSessions += agentSessions.length;
      }
      return json(res, 200, {
        system: config.system,
        bots: {
          statuses: botStatuses,
          active: activeAgents,
          total: totalAgents,
          sessions: totalSessions,
        },
        cron: { jobs: listAllJobs().length, jobCount: listAllJobs().length },
        delivery: { pending: bridgeRef?.getDeliveryQueue?.()?.length || 0 }
      });
    }

    // ── Stop agent ──
    // POST /api/agents/:id/stop
    if (pathname.match(/^\/api\/agents\/[\w-]+\/stop$/) && method === 'POST') {
      const agentId = pathname.split('/')[3];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });
      const body = await parseBody(req);
      const chatId = body.chatId || null;
      if (bridgeRef?.stopAgent) {
        const result = bridgeRef.stopAgent(agentId, chatId);
        setAgentActivity(agentId, 'idle');
        return json(res, 200, result);
      }
      return json(res, 503, { error: 'Bridge not ready' });
    }

    // ── Agent activity status ──
    // GET /api/agents/:id/activity
    if (pathname.match(/^\/api\/agents\/[\w-]+\/activity$/) && method === 'GET') {
      const agentId = pathname.split('/')[3];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });
      const activity = getAgentActivity(agentId);
      return json(res, 200, activity);
    }

    // ── Poll for new messages (2-way communication) ──
    // GET /api/agents/:id/poll?chatId=xxx&since=ISO_TIMESTAMP
    // Returns messages newer than `since` for the given chat session.
    // If no chatId, returns latest activity across all sessions.
    if (pathname.match(/^\/api\/agents\/[\w-]+\/poll$/) && method === 'GET') {
      const agentId = pathname.split('/')[3];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });

      const chatId = url.searchParams.get('chatId');
      const since = url.searchParams.get('since');
      const sinceTime = since ? new Date(since).getTime() : 0;

      if (chatId) {
        // Poll specific session for new messages
        let history = null;
        if (bridgeRef?.getSessionHistory) {
          const sessionData = bridgeRef.getSessionHistory(agentId, chatId);
          if (sessionData) history = sessionData.messages || [];
        }
        // Fallback to disk
        if (!history) {
          const candidates = [
            path.join(paths.sessions(agentId), `${chatId}.json`),
            path.join(LIVE_AGENTS_DIR, agentId, 'sessions', `${chatId}.json`),
          ];
          for (const sessionFile of candidates) {
            if (fs.existsSync(sessionFile)) {
              try {
                const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                history = (data.history || []).map(msg => ({
                  role: msg.role || (msg.isUser ? 'user' : 'assistant'),
                  content: msg.content || msg.text || '',
                  timestamp: msg.timestamp || null,
                }));
                break;
              } catch {}
            }
          }
        }

        if (!history) return json(res, 200, { messages: [], hasNew: false });

        // Filter messages newer than `since`
        const newMessages = sinceTime > 0
          ? history.filter(m => m.timestamp && new Date(m.timestamp).getTime() > sinceTime)
          : [];

        // Extract media from assistant messages
        const enrichedMessages = newMessages.map(m => {
          if (m.role === 'assistant' || m.role === 'agent') {
            const { cleanText, media } = extractMediaFromResponse(m.content || '', agentId);
            if (media.length > 0) return { ...m, content: cleanText, media };
          }
          return m;
        });

        return json(res, 200, {
          messages: enrichedMessages,
          hasNew: enrichedMessages.length > 0,
          totalMessages: history.length,
          chatId,
        });
      } else {
        // No chatId — return latest session activity summary
        const agentSessionsList = getAgentSessions(agentId);
        const recentSessions = agentSessionsList.filter(s => {
          if (!s.lastActivity) return false;
          return new Date(s.lastActivity).getTime() > sinceTime;
        });
        return json(res, 200, {
          sessions: recentSessions,
          hasNew: recentSessions.length > 0,
        });
      }
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[gateway] Error:', err.message);
    return json(res, 500, { error: err.message });
  }
}

export function startGateway(config) {
  const gw = config.gateway;
  if (!gw?.enabled) {
    console.log('[gateway] Disabled in config');
    return null;
  }

  // Ensure default admin user exists
  ensureDefaultAdmin(config);

  const port = gw.port || 19789;
  const host = gw.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

  const server = http.createServer(handleRequest);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[gateway] ⚠️ Port ${port} in use — gateway disabled (another instance running?)`);
    } else {
      console.error(`[gateway] Error:`, err.message);
    }
  });
  server.listen(port, host, () => {
    console.log(`[gateway] ✅ HTTP API listening on ${host}:${port}`);
  });

  return server;
}
