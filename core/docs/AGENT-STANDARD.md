# Agent Standard — TamerClaw Ecosystem

This document defines the standard structure, required files, optional files, and upgrade path for agents in the TamerClaw ecosystem.

## Quick Start

```bash
# Create a new agent from the template
./scripts/create-agent.sh my-agent "My Agent" "Robot" "Full-stack developer"

# Customize
vim agents/my-agent/IDENTITY.md

# Install deps & start
cd agents/my-agent && npm install
pm2 start pm2/ecosystem.config.cjs && pm2 save
```

## Directory Structure

Every agent lives under `<TAMERCLAW_HOME>/user/agents/<agent-id>/` and follows this layout:

```
agents/<agent-id>/
├── IDENTITY.md              # REQUIRED — Agent persona, mission, communication style
├── MEMORY.md                # REQUIRED — Persistent memory across sessions
├── bot.js                   # REQUIRED (standalone) — Telegram bot entry point
├── config.json              # RECOMMENDED — Agent-specific configuration
├── package.json             # REQUIRED (standalone) — Node.js package manifest
├── health.json              # AUTO-GENERATED — Health status (written by bot.js)
├── sessions.json            # AUTO-GENERATED — Active session tracking
├── processing.json          # AUTO-GENERATED — Processing lock state
├── USER.md                  # OPTIONAL — User-specific context and preferences
├── workspace/               # REQUIRED — Working directory for Claude CLI
├── memory/                  # REQUIRED — Structured memory storage
├── sessions/                # REQUIRED — Archived session data
├── media/                   # REQUIRED — Downloaded voice/image files
└── pm2/
    └── ecosystem.config.cjs # REQUIRED (standalone) — PM2 process config
```

## Required Files

### IDENTITY.md

The agent's persona definition. This is loaded as part of the system prompt on every Claude invocation. Must include:

| Section | Purpose |
|---------|---------|
| Header | Agent name, ID, role, emoji, primary model |
| Mission | What the agent does and why it exists |
| Personality | How the agent thinks and approaches problems |
| Communication Style | How the agent talks (domain-specific, not generic) |
| User | Owner's info and timezone |
| Technical Stack | Technologies the agent works with |
| Platform | Workspace paths and ecosystem references |
| Audio Capability | Whisper transcription support |
| Active Work | Current tasks, completed items, upcoming work |

Use the template at `<TAMERCLAW_HOME>/core/templates/IDENTITY.template.md`.

#### New Sections (Enhanced Standard)

| Section | Purpose |
|---------|---------|
| Project Structure | File tree of the key directories/files the agent works with |
| Architecture & Patterns | Architecture decisions, patterns used (e.g., MVC, repository pattern) |
| Environment | Ports, databases, env vars, test vs prod differences |
| Dev Rules | Agent-specific constraints (e.g., "never modify X", "always run tests after Y") |
| Quality Plugins | Which shared plugins from `shared/plugins/` the agent loads |

### MEMORY.md

Persistent memory that survives across sessions. The agent reads this at session start and updates it at session end. Contains:

- Session log (chronological record of significant events)
- Key decisions (architectural choices, user preferences)
- Known issues (bugs, blockers, workarounds)

### bot.js

The standalone Telegram bot. Handles:

- Telegram message polling
- Voice message transcription (via shared/transcribe.js)
- Dynamic model routing (haiku/sonnet/opus based on message complexity)
- Session persistence (resume conversations)
- System prompt assembly (IDENTITY + SOUL + GLOBAL_POLICY + USER + MEMORY)
- Health reporting
- Processing locks (prevents concurrent requests per chat)

Use the template at `<TAMERCLAW_HOME>/core/templates/bot.template.js`.

### package.json

Standard Node.js manifest. Minimum dependency: `node-telegram-bot-api`.

Use the template at `<TAMERCLAW_HOME>/core/templates/package.template.json`.

## Optional Files

| File | Purpose |
|------|---------|
| `USER.md` | Extra user context (preferences, project details) |
| `config.json` | Agent-specific config (model routing, tools, session limits) |
| `resources/` | Static resources the agent needs (brand guides, sitemaps, etc.) |
| `scripts/` | Agent-specific automation scripts |
| `bot.lock` | Lock file to prevent duplicate bot instances |

## Ecosystem Registration

Every agent must be registered in `<TAMERCLAW_HOME>/user/config.json` under the `agents` object. The `create-agent.sh` script does this automatically. Required fields:

```json
{
  "telegramAccount": "agent-id",
  "botToken": "",
  "model": "claude-opus-4-6",
  "standalone": true,
  "standalonePath": "<TAMERCLAW_HOME>/user/agents/agent-id/bot.js",
  "workspace": "<TAMERCLAW_HOME>/user/agents/agent-id",
  "identity": "<TAMERCLAW_HOME>/user/agents/agent-id/IDENTITY.md",
  "healthFile": "<TAMERCLAW_HOME>/user/agents/agent-id/health.json",
  "allowedTools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"]
}
```

Standalone agents must also be listed in the `standaloneAgents` array.

## Shared Resources

All agents inherit behavior from these shared files:

| File | Path | Purpose |
|------|------|---------|
| SOUL.md | `core/shared/SOUL.md` | Core personality traits and boundaries |
| GLOBAL_POLICY.md | `core/shared/GLOBAL_POLICY.md` | Communication standards, feedback rules |
| transcribe.js | `core/shared/transcribe.js` | Whisper audio transcription |
| session-history.js | `core/shared/session-history.js` | Session archiving and retrieval |
| memory-db.js | `core/shared/memory-db.js` | Structured memory database |

## Model Routing

Agents use dynamic model routing to balance cost and capability:

| Tier | Model | When |
|------|-------|------|
| Simple | claude-haiku-4-5 | Short greetings, status checks, simple lookups |
| Standard | claude-sonnet-4-6 | Implementation, code changes, medium-complexity tasks |
| Complex | claude-opus-4-6 | Architecture, planning, research, long messages |

The routing logic lives in `bot.js`. Customize the `complexPatterns` array in `config.json` to tune which keywords trigger opus-level reasoning.

## PM2 Management

Each agent runs as a PM2 process. Rules:

1. Process names must be prefixed with the agent ID (e.g., `my-agent`)
2. Use the PM2 ecosystem config at `pm2/ecosystem.config.cjs`
3. Register processes in `<TAMERCLAW_HOME>/user/pm2/registry.json`
4. Check for port conflicts before claiming a port
5. Use `pm2-guard.sh` for ownership-enforced operations

## Plans Directory

Each agent has a `plans/` directory for structured implementation plans. Plans should be created before complex tasks (3+ files, architectural decisions, multi-step implementations).

Plan files use YAML frontmatter with title, status, created/updated dates, priority, and tags. See `<TAMERCLAW_HOME>/core/shared/plan-manager.js` for the plan creation API.

## Upgrade Path

### Upgrading an existing agent to the standard

1. **Compare structure**: Check which required files/directories are missing
2. **Add IDENTITY.md**: Copy the template and fill in agent-specific values
3. **Add MEMORY.md**: Create with initial session log entry
4. **Standardize bot.js**: Compare with the template and adopt shared patterns (system prompt assembly, session management, health reporting)
5. **Add PM2 config**: Create `pm2/ecosystem.config.cjs` if missing
6. **Create missing directories**: `workspace/`, `memory/`, `sessions/`, `media/`
7. **Verify ecosystem registration**: Ensure the agent is in `config.json`

### Adding dynamic model routing to an agent

1. Add `"model": "dynamic"` and a `modelRouting` block to the agent's entry in `config.json`
2. Update `bot.js` to use the `resolveModel()` function from the template
3. Customize `complexPatterns` for the agent's domain

### Adding a project directory

Some agents work on an external codebase (e.g., a website). Add:

```json
{
  "projectDir": "/path/to/my-project"
}
```

Then update the `CWD` in `bot.js` to point there, or keep `workspace/` as CWD and reference `projectDir` in the system prompt.

## Template Files

All templates live in `<TAMERCLAW_HOME>/core/templates/`:

| Template | Generates |
|----------|-----------|
| `IDENTITY.template.md` | `IDENTITY.md` |
| `config.template.json` | `config.json` |
| `bot.template.js` | `bot.js` |
| `package.template.json` | `package.json` |

Placeholders use `{{variable}}` syntax. The `create-agent.sh` script replaces them via `sed`.

## Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| Agent ID | lowercase, hyphenated | `hbot-website` |
| Display name | Title case | `HBot Website` |
| PM2 process | Agent ID prefix | `hbot-website` |
| Env var for token | UPPER_SNAKE + `_BOT_TOKEN` | `HBOT_WEBSITE_BOT_TOKEN` |
| Telegram account | Same as agent ID | `hbot-website` |
