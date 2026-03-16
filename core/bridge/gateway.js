/**
 * HTTP Gateway API — Tamerclaw
 * Token-based auth, agent control, message sending.
 * Port 19789, loopback only.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { addJob, removeJob, listJobs, updateJob } from '../cron/scheduler.js';
import { readConfigCached } from '../shared/async-fs.js';
import paths from '../shared/paths.js';

let bridgeRef = null; // Set by bridge on startup

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

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function authenticate(req, config) {
  const gw = config.gateway;
  if (!gw?.auth?.token) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  const token = auth.replace('Bearer ', '');
  return token === gw.auth.token;
}

function isDenied(command, config) {
  const denied = config.gateway?.denyCommands || [];
  return denied.includes(command);
}

async function handleRequest(req, res) {
  const config = await loadConfig();

  if (!authenticate(req, config)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── Agents ──
    if (pathname === '/api/agents' && method === 'GET') {
      const agents = Object.entries(config.agents).map(([id, a]) => ({
        id,
        telegramAccount: a.telegramAccount,
        hasToken: !!a.botToken,
        model: a.model || config.defaults.model,
        workspace: a.workspace
      }));
      return json(res, 200, { agents });
    }

    // ── Send message to agent ──
    if (pathname.match(/^\/api\/agents\/[\w-]+\/message$/) && method === 'POST') {
      const agentId = pathname.split('/')[3];
      if (!config.agents[agentId]) return json(res, 404, { error: 'Agent not found' });
      const body = await parseBody(req);
      if (!body.message) return json(res, 400, { error: 'message required' });

      if (bridgeRef?.sendAgentMessage) {
        const response = await bridgeRef.sendAgentMessage(agentId, body.message, body.chatId);
        return json(res, 200, { response });
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
      return json(res, 200, { jobs: listJobs(agentId) });
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
      return json(res, 200, {
        system: config.system,
        bots: bridgeRef?.getBotStatuses?.() || {},
        cron: { jobs: listJobs().length },
        delivery: { pending: bridgeRef?.getDeliveryQueue?.()?.length || 0 }
      });
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
