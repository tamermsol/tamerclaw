/**
 * TamerClaw Path Resolver
 * All paths are relative to TAMERCLAW_HOME (the install directory).
 * TAMERCLAW_HOME defaults to the repo root (two levels up from core/shared/).
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TAMERCLAW_HOME = repo root (core/shared/../../)
export const TAMERCLAW_HOME = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

export const paths = {
  home: TAMERCLAW_HOME,
  config: path.join(TAMERCLAW_HOME, 'user', 'config.json'),
  core: path.join(TAMERCLAW_HOME, 'core'),
  user: path.join(TAMERCLAW_HOME, 'user'),
  agents: path.join(TAMERCLAW_HOME, 'user', 'agents'),
  credentials: path.join(TAMERCLAW_HOME, 'user', 'credentials'),
  shared: path.join(TAMERCLAW_HOME, 'core', 'shared'),
  bridge: path.join(TAMERCLAW_HOME, 'core', 'bridge'),
  supreme: path.join(TAMERCLAW_HOME, 'core', 'supreme'),
  relay: path.join(TAMERCLAW_HOME, 'core', 'relay'),
  cron: path.join(TAMERCLAW_HOME, 'core', 'cron'),
  cronJobs: path.join(TAMERCLAW_HOME, 'user', 'cron', 'jobs.json'),
  cronRuns: path.join(TAMERCLAW_HOME, 'user', 'cron', 'runs'),
  logs: path.join(TAMERCLAW_HOME, 'user', 'logs'),
  auditLog: path.join(TAMERCLAW_HOME, 'user', 'logs', 'config-audit.jsonl'),
  tmp: path.join(TAMERCLAW_HOME, 'user', 'tmp'),
  deliveryQueue: path.join(TAMERCLAW_HOME, 'user', 'delivery-queue'),

  // Meetings — core code + runtime data under user/
  meetings: path.join(TAMERCLAW_HOME, 'core', 'meetings'),
  meetingsRuntime: path.join(TAMERCLAW_HOME, 'user', 'meetings'),
  meetingsActive: path.join(TAMERCLAW_HOME, 'user', 'meetings', 'active'),
  meetingsInbox: path.join(TAMERCLAW_HOME, 'user', 'meetings', 'inbox'),
  meetingsRequests: path.join(TAMERCLAW_HOME, 'user', 'meetings', 'requests'),

  // Compute extension
  computeConfig: path.join(TAMERCLAW_HOME, 'user', 'compute', 'config.json'),
  computeWatchdog: path.join(TAMERCLAW_HOME, 'core', 'compute', 'watchdog.js'),

  // PM2 guard system
  pm2Guard: path.join(TAMERCLAW_HOME, 'core', 'pm2', 'pm2-guard.sh'),
  pm2Registry: path.join(TAMERCLAW_HOME, 'user', 'pm2', 'registry.json'),

  // Plugins
  plugins: path.join(TAMERCLAW_HOME, 'core', 'shared', 'plugins'),

  // Runtime state — lives in user/ for workspace isolation & update safety
  proxyState: path.join(TAMERCLAW_HOME, 'user', 'proxy-state.json'),
  rateUsage: path.join(TAMERCLAW_HOME, 'user', 'rate-usage.json'),

  // Relay runtime directories — user-scoped so core/ stays clean
  relayRuntime: path.join(TAMERCLAW_HOME, 'user', 'relay'),
  relayOutbox: path.join(TAMERCLAW_HOME, 'user', 'relay', 'outbox'),
  relayStreamOutbox: path.join(TAMERCLAW_HOME, 'user', 'relay', 'stream-outbox'),

  // Supreme runtime — under user/agents/supreme/
  supremeRuntime: path.join(TAMERCLAW_HOME, 'user', 'agents', 'supreme'),

  sessions: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'sessions'),
  memory: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'memory'),
  agentDir: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId),
  agentIdentity: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'IDENTITY.md'),
  agentUser: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'USER.md'),
  agentTools: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'TOOLS.md'),
  agentMemoryMd: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'MEMORY.md'),
  agentMedia: (agentId) => path.join(TAMERCLAW_HOME, 'user', 'agents', agentId, 'media'),
};

export default paths;
