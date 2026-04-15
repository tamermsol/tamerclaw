# TamerClaw Agency — Git Standards & Version Control Guide

**This document is MANDATORY reading for all agents. Every agent must follow these standards.**

## 1. Repository Structure

The entire TamerClaw Agency lives in a single monorepo: `tamerclaw-agency`

```
tamerclaw-agency/
├── agents/           # All agent directories
├── shared/           # Shared libraries & utilities
├── bridge/           # Telegram bridge
├── config.json       # Main configuration
├── docs/             # Documentation (this file lives here)
├── plans/            # Cross-agent plans
├── tasks/            # Task registry
├── templates/        # Agent templates
└── scripts/          # Maintenance scripts
```

## 2. Branching Strategy

```
main              <- Production. Always stable. Protected.
  └── develop     <- Integration branch. All features merge here first.
       ├── feat/<agent>/<description>    <- New features
       ├── fix/<agent>/<description>     <- Bug fixes
       ├── refactor/<agent>/<description> <- Code improvements
       ├── config/<description>          <- Configuration changes
       └── docs/<description>            <- Documentation updates
```

### Branch Naming Rules

- **Always prefix with type**: `feat/`, `fix/`, `refactor/`, `config/`, `docs/`
- **Include agent name** when changes are agent-specific: `feat/hbot/mqtt-broker-switch`
- **Use kebab-case**: `fix/trading/signal-nonetype-bug` NOT `fix/trading/Signal_NoneType_Bug`
- **Keep it short but descriptive**: max 50 chars for the description part

### Branch Lifecycle

1. Create branch from `develop`: `git checkout -b feat/hbot/new-dashboard develop`
2. Work on the branch, commit frequently
3. When done, merge to `develop` (or create PR for review)
4. After testing in `develop`, merge to `main` for production
5. Delete the feature branch after merge

### Protected Branches

- `main` — No direct commits. Only merges from `develop` after verification.
- `develop` — Direct commits allowed for small fixes. Feature branches for larger work.

## 3. Commit Message Standards

### Format

```
<type>(<scope>): <short description>

<body - what changed and WHY>

<footer - breaking changes, references>
```

### Types

| Type | When to Use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructuring (no behavior change) |
| `config` | Configuration changes |
| `docs` | Documentation only |
| `perf` | Performance improvement |
| `test` | Adding or fixing tests |
| `chore` | Maintenance, cleanup, dependencies |
| `hotfix` | Emergency production fix |

### Scope

The scope identifies WHAT was changed:
- Agent name: `feat(trading): add mean-reversion optimizer`
- Shared module: `fix(shared/claude-engine): handle null response`
- Infrastructure: `config(systemd): increase restart limits`
- Multiple: `refactor(agents): standardize bot.js template`

### Examples

**Good commits:**
```
feat(hbot): add MQTT broker failover with EMQX cloud support

Added automatic broker detection and failover between local broker
and EMQX Cloud brokers. Panel firmware publishes to EMQX; app now connects
to both and auto-switches based on availability.

Closes #12
```

```
fix(trading/signal): fix NoneType crash in signal.py line 492

signal_data was None when no signals generated in cycle. Added null check
before accessing .strength attribute. This was causing every 30-min cycle
to crash silently.
```

```
config(cto): update team members list and fix agent service map

Removed nonexistent agents (flutter, migration, hbot-lead).
Added actual agents. Fixed mark->branding-agent to mark->mark-agent.
Enabled auto-start.
```

**Bad commits:**
```
"updated stuff"
"fix"
"WIP"
"changes"
"asdf"
```

### Rules

1. **Subject line**: max 72 chars, imperative mood ("add" not "added")
2. **Body**: Explain WHAT changed and WHY (not HOW — the diff shows how)
3. **One logical change per commit** — don't bundle unrelated changes
4. **Never commit broken code to `develop` or `main`**
5. **Reference task IDs** when applicable: `Task: TASK-001`

## 4. Daily Workflow for Agents

### Before Starting Work

```bash
# Always start from latest develop
git checkout develop
git pull origin develop

# Create a feature branch for your work
git checkout -b feat/<your-agent>/<what-youre-doing>
```

### While Working

```bash
# Stage specific files (NEVER use git add -A blindly)
git add agents/hbot/bot.js agents/hbot/IDENTITY.md

# Commit with proper message
git commit -m "feat(hbot): add voice message handler

Added voice-mode.js integration to bot.js. Voice messages are now
transcribed via Whisper on Mac Mini and processed as text input."

# Push your branch regularly (backup + visibility)
git push origin feat/hbot/voice-handler
```

### After Completing Work

```bash
# Switch to develop and merge
git checkout develop
git pull origin develop
git merge feat/hbot/voice-handler

# Push develop
git push origin develop

# Clean up feature branch
git branch -d feat/hbot/voice-handler
git push origin --delete feat/hbot/voice-handler
```

## 5. What to Track (and What NOT to Track)

### ALWAYS Track

- Agent source code (`bot.js`, `IDENTITY.md`, `config.json`)
- Shared libraries (`shared/*.js`)
- Configuration files (`config.json`, systemd service files)
- Documentation (`docs/`, `*.md`)
- Plans (`plans/`)
- Templates (`templates/`)
- Scripts (`scripts/`)
- Task registry structure (`tasks/registry.json`)
- Bridge code (`bridge/`)
- Agent workspace SOURCE CODE (`.js`, `.ts`, `.py`, `.dart`, `.html`, `.css`)

### NEVER Track

- `node_modules/` — Reinstall from package.json
- `.env` files — Secrets don't go in git. Ever.
- `credentials/`, `secrets/` — Same reason
- Media files (`.jpg`, `.png`, `.mp4`, `.oga`) — Too large, not code
- Build artifacts (`dist/`, `build/`, `.next/`)
- Log files (`*.log`)
- Runtime state (`heartbeat.json`, circuit breaker state)
- `__pycache__/`, `.pyc` — Python build cache
- Delivery queue files — Transient
- Bot tokens — **ABSOLUTELY NEVER**

## 6. Emergency Procedures

### Accidentally Committed Secrets

```bash
# IMMEDIATELY: Remove from history
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch path/to/secret-file" \
  HEAD

# Force push (ONLY time force push is acceptable)
git push origin --force --all

# Rotate the compromised credential immediately
```

### Need to Undo Last Commit (haven't pushed)

```bash
git reset --soft HEAD~1   # Keeps changes staged
# Fix whatever was wrong, recommit
```

### Need to Undo Last Commit (already pushed)

```bash
git revert HEAD            # Creates a NEW commit that undoes the last one
git push origin develop
```

### Merge Conflict

```bash
# See what's conflicted
git status

# Open conflicted files, look for <<<<<<< markers
# Edit to resolve, then:
git add <resolved-file>
git commit -m "fix: resolve merge conflict in <file>"
```

## 7. Code Review Expectations

When changes affect:
- **Shared libraries** -> CTO reviews before merge to main
- **Config changes** -> Supreme or CTO reviews
- **Agent identity/behavior** -> C-level review
- **Infrastructure** (systemd, watchdog, autopilot) -> Supreme reviews
- **Agent-specific code** -> Agent's team leader reviews

## 8. Release Tagging

Major milestones get tagged:

```bash
git tag -a v1.0.0 -m "TamerClaw Agency v1.0.0 - Initial stable release

- 30 agents operational
- Autopilot system active
- 3-layer self-healing (systemd + watchdog + cron)
- Task registry with delegation tracking
- Voice conversation mode across all agents"

git push origin v1.0.0
```

### Version Format: `vMAJOR.MINOR.PATCH`

- **MAJOR**: Architecture changes, breaking changes
- **MINOR**: New agents, new features, significant improvements
- **PATCH**: Bug fixes, config tweaks, documentation

## 9. Agent-Specific Repos

Some projects have their own repos (for deployment or client delivery). These are SEPARATE from the agency monorepo. Agent workspaces may clone these repos inside `agents/<name>/workspace/`. The workspace `.git` folders are gitignored from the monorepo.

## 10. Quick Reference Card

```
git checkout develop && git pull          # Start fresh
git checkout -b feat/agent/thing          # New branch
git add <specific files>                  # Stage (be specific!)
git commit -m "type(scope): message"      # Commit properly
git push origin feat/agent/thing          # Backup to remote
git checkout develop && git merge branch  # Merge when done
git push origin develop                   # Push integration
git branch -d feat/agent/thing            # Cleanup
```

**Remember: Git is your safety net. Use it well and you'll never lose work again.**
