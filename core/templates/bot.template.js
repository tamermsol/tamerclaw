/**
 * {{DISPLAY_NAME}} Agent Bot — Standalone Telegram Bot
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import TelegramBot from 'node-telegram-bot-api';
import { transcribeAudio } from '../../shared/transcribe.js';
import { archiveSession, formatSessionsList, getSessionByIndex, getSessionById } from '../../shared/session-history.js';
import paths from '../../shared/paths.js';

const TOKEN = process.env.{{AGENT_ID_UPPER}}_BOT_TOKEN || '';
const AGENT_ID = '{{agent_id}}';
const BOT_DIR = paths.agentDir(AGENT_ID);
const CWD = path.join(BOT_DIR, 'workspace');
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '1800000', 10);

if (!TOKEN) {
  console.error(`Missing {{AGENT_ID_UPPER}}_BOT_TOKEN`);
  process.exit(1);
}

console.log(`[{{agent_id}}] Starting {{DISPLAY_NAME}} agent...`);
// Template placeholder — full bot logic inserted by create-agent.sh or bot-template.js
