/**
 * Test script to verify a single agent's Telegram bot connection.
 *
 * Usage:
 *   node test-connection.js <agentId>
 *   node test-connection.js scrum
 *   node test-connection.js --all
 */

import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';
import paths from '../shared/paths.js';

const CONFIG_PATH = paths.config;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function testAgent(agentId, agentConfig, config) {
  const token = agentConfig.botToken || config.telegram?.sharedBotToken;
  if (!token) {
    console.log(`  ❌ ${agentId}: No bot token configured`);
    return false;
  }

  const isShared = !agentConfig.botToken && token === config.telegram?.sharedBotToken;

  try {
    const bot = new TelegramBot(token);
    const me = await bot.getMe();
    const tag = isShared ? ' (shared)' : '';
    console.log(`  ✅ ${agentId}: @${me.username} (${me.first_name}) — ID: ${me.id}${tag}`);
    return true;
  } catch (err) {
    console.log(`  ❌ ${agentId}: ${err.message}`);
    return false;
  }
}

async function main() {
  const config = loadConfig();
  const target = process.argv[2];

  if (!target) {
    console.log('Usage: node test-connection.js <agentId|--all>');
    console.log('Available agents:', Object.keys(config.agents).join(', '));
    process.exit(1);
  }

  console.log('Testing Telegram bot connections...\n');

  if (target === '--all') {
    let ok = 0, fail = 0;
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      const success = await testAgent(agentId, agentConfig, config);
      if (success) ok++;
      else fail++;
    }
    console.log(`\nResults: ${ok} connected, ${fail} failed/unconfigured`);
  } else {
    const agentConfig = config.agents[target];
    if (!agentConfig) {
      console.log(`Agent "${target}" not found. Available:`, Object.keys(config.agents).join(', '));
      process.exit(1);
    }
    await testAgent(target, agentConfig, config);
  }
}

main();
