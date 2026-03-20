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
  deliveryQueue: path.join(TAMERCLAW_HOME, 'user', 'delivery-queue'),
  proxyState: path.join(TAMERCLAW_HOME, 'core', 'relay', 'proxy-state.json'),
  rateUsage: path.join(TAMERCLAW_HOME, 'core', 'shared', 'rate-usage.json'),
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
