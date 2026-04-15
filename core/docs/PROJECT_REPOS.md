# TamerClaw Project Repositories

All projects must be tracked in dedicated GitHub repos under `tamermsol/`. This is the single source of truth for project-to-repo mapping.

## Active Project Repos

| Project | Repo | Type | Primary Agent(s) |
|---------|------|------|-------------------|
| HBot Flutter App | `tamermsol/h-bot` | Flutter | hbot |
| HBot Panel Firmware | `tamermsol/hbot-panel-firmware` | ESP-IDF (C/C++) | smarty |
| HBot Website | `tamermsol/hbot-website` | Next.js | hbot-website |
| MSOL Website | `tamermsol/msol-website` | Next.js | msol |
| MOS Platform v3 | `tamermsol/mos-v3` | Next.js | mos-v3-website |
| MOS Platform v4 | `tamermsol/mos-v4` | Next.js | mos-v3-website |
| MOS Platform v6 | `tamermsol/mos-v6` | Next.js | mos-v3-website |
| MOS Website | `tamermsol/mos-website` | Next.js | mos-v3-website |
| v777 Trading System | `tamermsol/v777-trading` | Python | trading |
| Trading API | `tamermsol/trading-api` | Python/FastAPI | trading |
| DavidChat App | `tamermsol/davidchat` | Flutter | david |
| Speech Analysis | `tamermsol/speech-analysis` | Python/ML | david |
| AO Dashboard | `tamermsol/ao-dashboard` | React + Laravel | mark |
| Researcher App | `tamermsol/researcher-app` | Python/Docker | researcher |
| TamerClaw Package | `tamermsol/tamerclaw` | Node.js + Flutter | tamerclaw |
| TamerClaw Agency | `tamermsol/tamerclaw-agency` | Monorepo | all agents |

## Rules for C-Level Agents

1. **New projects get their own repo** — when the user discusses new substantial work, create a repo BEFORE delegating
2. **Command:** `gh repo create tamermsol/<name> --private -y`
3. **Agents work ON the repo** — clone, branch, commit, push. No loose code in workspace/
4. **Update this file** when adding new repos
5. **Never commit secrets** — .env, tokens, API keys, credentials
6. **Stage specific files** — never `git add -A` or `git add .`
