# TamerClaw

Multi-agent Claude Code system with Telegram bridge. Run AI agents on your own infrastructure, each with its own Telegram bot, managed by a Supreme Agent coordinator.

## What is this?

TamerClaw turns your Claude Code setup into a multi-agent system. Each agent gets its own Telegram bot, memory, and workspace. A Supreme Agent acts as master controller — managing all other agents from Telegram.

```
You on Telegram
    ↓
Supreme Agent (coordinator)
    ↓
┌─────────┬──────────┬────────────┐
│ Agent 1 │ Agent 2  │ Agent N    │
│ (scrum) │ (flutter)│ (research) │
└─────────┴──────────┴────────────┘
    ↕           ↕          ↕
Claude Code CLI (runs locally on your machine)
```

## Prerequisites

- **Node.js 18+**
- **Claude Code CLI** — installed and authenticated (`claude` command available)
- **Telegram bot tokens** — one per agent, created via [@BotFather](https://t.me/BotFather)

## Quick Start

```bash
git clone https://github.com/tamermsol/tamerclaw.git
cd tamerclaw
./tamerclaw init
```

The setup wizard will:

1. Ask your name and Telegram user ID
2. Scan your machine for existing Claude Code agents
3. Let you pick which agents to link
4. Prompt for a Telegram bot token per agent
5. Set up the Supreme Agent (your master controller)
6. Generate config, install dependencies, create systemd services

Then start everything:

```bash
./tamerclaw start
```

## Commands

### Setup

```bash
./tamerclaw init          # Interactive setup wizard
./tamerclaw update        # Pull latest updates, restart services
```

### Services

```bash
./tamerclaw start         # Start all services
./tamerclaw stop          # Stop all services
./tamerclaw restart       # Restart all services
./tamerclaw status        # Show system status
./tamerclaw logs          # Tail all logs
./tamerclaw logs bridge   # Tail bridge logs only
./tamerclaw logs supreme  # Tail Supreme Agent logs only
```

### Agent Management

```bash
./tamerclaw agents                    # List all agents
./tamerclaw add-agent myagent /path   # Add agent from existing directory
./tamerclaw set-token myagent TOKEN   # Set Telegram bot token
./tamerclaw test --all                # Test all Telegram connections
./tamerclaw test myagent              # Test specific agent
./tamerclaw test-claude               # Verify Claude CLI works
./tamerclaw send myagent "Hello"      # Send message via gateway API
```

### Cron

```bash
./tamerclaw cron-list     # List scheduled jobs
```

## Architecture

```
tamerclaw/
├── tamerclaw              # CLI entry point
├── version.json
├── core/                  # Updatable code (yours to maintain)
│   ├── bridge/            # Telegram ↔ Claude Code bridge + HTTP gateway
│   ├── supreme/           # Supreme Agent (standalone meta-controller)
│   ├── cron/              # Job scheduler
│   └── shared/            # Path resolver, async-fs, tracing, policies
└── user/                  # Generated per-user (never overwritten on update)
    ├── config.json        # System configuration
    ├── agents/            # Agent data (identity, memory, sessions)
    ├── credentials/       # Telegram allowlists
    ├── cron/              # Job definitions and run logs
    ├── logs/              # Audit logs
    └── delivery-queue/    # Async message queue
```

### Bridge

Routes Telegram messages to Claude Code CLI. Features:

- One bot per agent (dedicated tokens)
- Message debouncing (batches rapid messages)
- Media handling (photos, documents, voice, video)
- Session persistence (survives restarts)
- HTTP gateway API on port 19789
- Agent-to-agent communication
- Delivery queue with retry logic

### Supreme Agent

Standalone meta-controller with its own Telegram bot:

- Live streaming responses (edits messages in real-time as Claude thinks)
- Tool activity tracking (shows what Claude is doing)
- Full system access — can manage all agents, edit configs, run commands
- Singleton guard (prevents duplicate polling conflicts)
- Self-protection (won't edit its own code or restart itself)

### Memory System

Each agent maintains:

- `IDENTITY.md` — who the agent is
- `USER.md` — info about the human
- `TOOLS.md` — available tools and setup
- `MEMORY.md` — long-term memory (included in every prompt)
- `memory/YYYY-MM-DD.md` — daily conversation logs

The system prompt assembles: Identity + Soul + Global Policy + User + Tools + Long-term Memory (3K chars) + Today's Memory (2K chars) + Yesterday's Memory (1K chars).

## Updates

When improvements are pushed to this repo:

```bash
./tamerclaw update
```

This pulls the latest `core/` code, preserves all your `user/` data (config, memories, tokens, sessions), reinstalls dependencies if needed, and restarts running services.

## Creating a Telegram Bot Token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a display name (e.g., "My Scrum Agent")
4. Choose a username (e.g., "my_scrum_agent_bot")
5. Copy the token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
6. Use it: `./tamerclaw set-token myagent <token>`

Each agent needs its own bot. The Supreme Agent also needs its own dedicated bot.

## Configuration

After init, your config lives at `user/config.json`. Key settings:

| Setting | Default | Description |
|---|---|---|
| `defaults.model` | `claude-sonnet-4-6` | Default Claude model for agents |
| `telegram.debounceMs` | `2000` | Batch rapid messages (ms) |
| `gateway.port` | `19789` | HTTP API port |
| `gateway.auth.token` | (generated) | Bearer token for API access |
| `cron.tickIntervalMs` | `30000` | How often to check cron jobs |

Per-agent model override: set `agents.<id>.model` to `claude-opus-4-6`, `claude-sonnet-4-6`, or `claude-haiku-4-5`.

## Security

- **Allowlist**: By default, only your Telegram ID can message agents. Edit `user/credentials/telegram-default-allowFrom.json` to change.
- **Gateway**: Bound to localhost only. Requires Bearer token auth.
- **No secrets in repo**: All tokens, keys, and user data live in `user/` which is gitignored.

## License

Private. Not for redistribution.
