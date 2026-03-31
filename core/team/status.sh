#!/bin/bash
# Team Status Dashboard — overview of agents and tasks

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASKS_DIR="$SCRIPT_DIR/tasks"
TAMERCLAW_HOME="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENTS_DIR="$TAMERCLAW_HOME/user/agents"

echo "=== Team Status Dashboard ==="
echo ""

# Task counts
PENDING=$(ls "$TASKS_DIR/pending/" 2>/dev/null | wc -l | tr -d ' ')
ACTIVE=$(ls "$TASKS_DIR/active/" 2>/dev/null | wc -l | tr -d ' ')
COMPLETED=$(ls "$TASKS_DIR/completed/" 2>/dev/null | wc -l | tr -d ' ')
FAILED=$(ls "$TASKS_DIR/failed/" 2>/dev/null | wc -l | tr -d ' ')

echo "Tasks: $PENDING pending | $ACTIVE active | $COMPLETED completed | $FAILED failed"
echo ""

# Agent health
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    agent=$(basename "$agent_dir")
    health="$agent_dir/health.json"
    if [ -f "$health" ]; then
      echo "Agent: $agent — ONLINE"
    else
      echo "Agent: $agent — unknown status"
    fi
  done
fi
