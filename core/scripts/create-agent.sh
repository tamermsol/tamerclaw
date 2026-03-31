#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# create-agent.sh — Create a new agent from the standard template
# ═══════════════════════════════════════════════════════════════════════════════
#
# Usage:
#   ./create-agent.sh <agent-id> <display-name> <emoji> <role>
#
# Example:
#   ./create-agent.sh my-agent "My Agent" "🤖" "Full-stack developer"
#
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAMERCLAW_HOME="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENTS_DIR="$TAMERCLAW_HOME/user/agents"
TEMPLATES_DIR="$TAMERCLAW_HOME/core/templates"
ECOSYSTEM_CONFIG="$TAMERCLAW_HOME/user/config.json"

if [ $# -lt 4 ]; then
  echo -e "${RED}Error: Missing arguments.${NC}"
  echo ""
  echo "Usage: $0 <agent-id> <display-name> <emoji> <role>"
  echo ""
  echo "Example:"
  echo "  $0 my-agent \"My Agent\" \"🤖\" \"Full-stack developer\""
  exit 1
fi

AGENT_ID="$1"
DISPLAY_NAME="$2"
EMOJI="$3"
ROLE="$4"

AGENT_ID_UPPER=$(echo "$AGENT_ID" | tr '[:lower:]' '[:upper:]' | tr '-' '_')
AGENT_DIR="$AGENTS_DIR/$AGENT_ID"

if [ -d "$AGENT_DIR" ]; then
  echo -e "${RED}Error: Agent '$AGENT_ID' already exists at $AGENT_DIR${NC}"
  exit 1
fi

echo -e "${BLUE}Creating agent: ${BOLD}$DISPLAY_NAME${NC} ($AGENT_ID)"
echo ""

# Step 1: Create directory structure
echo -e "${YELLOW}[1/6]${NC} Creating directory structure..."
mkdir -p "$AGENT_DIR"/{workspace,memory,sessions,media,plans,inbox,pm2}
echo -e "  ${GREEN}Done${NC}"

# Step 2: Create IDENTITY.md from template
echo -e "${YELLOW}[2/6]${NC} Creating IDENTITY.md..."
if [ -f "$TEMPLATES_DIR/IDENTITY.template.md" ]; then
  sed -e "s/{{DISPLAY_NAME}}/$DISPLAY_NAME/g" \
      -e "s/{{agent_id}}/$AGENT_ID/g" \
      -e "s/{{emoji}}/$EMOJI/g" \
      -e "s/{{role_description}}/$ROLE/g" \
      -e "s/{{AGENT_ID_UPPER}}/$AGENT_ID_UPPER/g" \
      "$TEMPLATES_DIR/IDENTITY.template.md" > "$AGENT_DIR/IDENTITY.md"
else
  cat > "$AGENT_DIR/IDENTITY.md" << EOF
# Agent: $DISPLAY_NAME

- **Name:** $AGENT_ID
- **Role:** $ROLE
- **Emoji:** $EMOJI
- **Primary Model:** claude-opus-4-6

## Mission
Describe the agent's mission here.

## Communication Style
- Talk like a professional, not a bot
- Give real progress, not filler
- Show your work: Explain WHAT changed and WHY
EOF
fi
echo -e "  ${GREEN}Done${NC}"

# Step 3: Create config.json from template
echo -e "${YELLOW}[3/6]${NC} Creating config.json..."
if [ -f "$TEMPLATES_DIR/config.template.json" ]; then
  sed -e "s/{{DISPLAY_NAME}}/$DISPLAY_NAME/g" \
      -e "s/{{agent_id}}/$AGENT_ID/g" \
      -e "s/{{emoji}}/$EMOJI/g" \
      -e "s/{{role_description}}/$ROLE/g" \
      -e "s/{{AGENT_ID_UPPER}}/$AGENT_ID_UPPER/g" \
      "$TEMPLATES_DIR/config.template.json" > "$AGENT_DIR/config.json"
else
  echo '{}' > "$AGENT_DIR/config.json"
fi
echo -e "  ${GREEN}Done${NC}"

# Step 4: Create bot.js from template
echo -e "${YELLOW}[4/6]${NC} Creating bot.js..."
if [ -f "$TEMPLATES_DIR/bot.template.js" ]; then
  sed -e "s/{{DISPLAY_NAME}}/$DISPLAY_NAME/g" \
      -e "s/{{agent_id}}/$AGENT_ID/g" \
      -e "s/{{emoji}}/$EMOJI/g" \
      -e "s/{{role_description}}/$ROLE/g" \
      -e "s/{{AGENT_ID_UPPER}}/$AGENT_ID_UPPER/g" \
      "$TEMPLATES_DIR/bot.template.js" > "$AGENT_DIR/bot.js"
else
  echo "// Bot placeholder for $AGENT_ID" > "$AGENT_DIR/bot.js"
fi
echo -e "  ${GREEN}Done${NC}"

# Step 5: Create package.json from template
echo -e "${YELLOW}[5/6]${NC} Creating package.json..."
if [ -f "$TEMPLATES_DIR/package.template.json" ]; then
  sed -e "s/{{DISPLAY_NAME}}/$DISPLAY_NAME/g" \
      -e "s/{{agent_id}}/$AGENT_ID/g" \
      -e "s/{{role_description}}/$ROLE/g" \
      "$TEMPLATES_DIR/package.template.json" > "$AGENT_DIR/package.json"
else
  cat > "$AGENT_DIR/package.json" << EOF
{
  "name": "$AGENT_ID-agent",
  "version": "1.0.0",
  "type": "module",
  "main": "bot.js",
  "dependencies": { "node-telegram-bot-api": "^0.66.0" }
}
EOF
fi
echo -e "  ${GREEN}Done${NC}"

# Step 6: Create MEMORY.md index
echo -e "${YELLOW}[6/6]${NC} Creating MEMORY.md..."
cat > "$AGENT_DIR/MEMORY.md" << EOF
# $DISPLAY_NAME — Memory Index

## Daily Logs
*No logs yet.*

## Topics
*No topics yet.*
EOF
echo -e "  ${GREEN}Done${NC}"

# Create PM2 ecosystem config
cat > "$AGENT_DIR/pm2/ecosystem.config.cjs" << EOF
module.exports = {
  apps: [{
    name: '$AGENT_ID',
    script: 'bot.js',
    cwd: '$AGENT_DIR',
    env: {
      NODE_ENV: 'production',
    },
    max_restarts: 10,
    restart_delay: 5000,
  }]
};
EOF

echo ""
echo -e "${GREEN}${BOLD}Agent '$DISPLAY_NAME' created successfully!${NC}"
echo ""
echo "Directory: $AGENT_DIR"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Set bot token: export ${AGENT_ID_UPPER}_BOT_TOKEN=<token>"
echo "  2. Edit IDENTITY.md to customize the agent's personality"
echo "  3. Register in config.json if using relay mode"
echo "  4. Start: cd $AGENT_DIR && npm install && pm2 start pm2/ecosystem.config.cjs"
