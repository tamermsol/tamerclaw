#!/bin/bash
# Task Dispatch — creates task file + sends Telegram notification
# Usage: dispatch.sh <agent> <priority> <title> <description>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEAM_DIR="$SCRIPT_DIR"
TAMERCLAW_HOME="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG="$TAMERCLAW_HOME/user/config.json"
AGENTS_DIR="$TAMERCLAW_HOME/user/agents"

AGENT="$1"
PRIORITY="${2:-P2}"
TITLE="${3:-Untitled Task}"
DESCRIPTION="${4:-No description provided}"

TASK_ID="$(date +%s)-${AGENT}-$(head -c 4 /dev/urandom | xxd -p)"
TASKS_DIR="$TEAM_DIR/tasks/pending"
mkdir -p "$TASKS_DIR"

cat > "$TASKS_DIR/$TASK_ID.json" << EOF
{
  "id": "$TASK_ID",
  "agent": "$AGENT",
  "from": "team-leader",
  "priority": "$PRIORITY",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "title": "$TITLE",
  "description": "$DESCRIPTION",
  "status": "pending"
}
EOF

echo "Task created: $TASK_ID -> $AGENT ($PRIORITY)"
