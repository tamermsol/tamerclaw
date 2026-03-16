/**
 * Set a Telegram bot token for an agent.
 *
 * Usage:
 *   node set-token.js <agentId> <botToken>
 *   node set-token.js scrum 1234567890:AABBccDDeeFF...
 */

import { readConfigCached, writeConfigAtomic } from '../shared/async-fs.js';
import paths from '../shared/paths.js';

const CONFIG_PATH = paths.config;

async function main() {
  const [agentId, token] = process.argv.slice(2);

  if (!agentId || !token) {
    console.log('Usage: node set-token.js <agentId> <botToken>');
    process.exit(1);
  }

  const config = await readConfigCached(CONFIG_PATH);

  if (!config.agents[agentId]) {
    console.log(`Agent "${agentId}" not found. Available:`, Object.keys(config.agents).join(', '));
    process.exit(1);
  }

  config.agents[agentId].botToken = token;
  await writeConfigAtomic(CONFIG_PATH, config);
  console.log(`✅ Token set for agent "${agentId}"`);
  console.log(`Run: node test-connection.js ${agentId}`);
}

main();
