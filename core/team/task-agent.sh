#!/bin/bash
# Agent Task Management — pickup, complete, or fail tasks
# Usage:
#   task-agent.sh <agent> list
#   task-agent.sh <agent> pickup <file>
#   task-agent.sh <agent> complete <file> <result>
#   task-agent.sh <agent> fail <file> <reason>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASKS_DIR="$SCRIPT_DIR/tasks"

AGENT="${1:?Agent required}"
ACTION="${2:-list}"

case "$ACTION" in
  list)
    echo "Pending tasks for $AGENT:"
    for f in "$TASKS_DIR/pending/"*.json 2>/dev/null; do
      [ -f "$f" ] || continue
      task_agent=$(python3 -c "import json; print(json.load(open('$f'))['agent'])" 2>/dev/null)
      if [ "$task_agent" = "$AGENT" ]; then
        echo "  $(basename "$f")"
      fi
    done
    ;;

  pickup)
    FILE="${3:?File required}"
    SRC="$TASKS_DIR/pending/$FILE"
    DST="$TASKS_DIR/active/$FILE"
    mkdir -p "$TASKS_DIR/active"
    if [ -f "$SRC" ]; then
      python3 -c "
import json
with open('$SRC') as f: t = json.load(f)
t['status'] = 'active'
t['started_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('$SRC', 'w') as f: json.dump(t, f, indent=2)
"
      mv "$SRC" "$DST"
      echo "Task picked up: $FILE"
    else
      echo "Task not found: $FILE"
      exit 1
    fi
    ;;

  complete)
    FILE="${3:?File required}"
    RESULT="${4:-No result provided}"
    SRC="$TASKS_DIR/active/$FILE"
    DST="$TASKS_DIR/completed/$FILE"
    mkdir -p "$TASKS_DIR/completed"
    if [ -f "$SRC" ]; then
      python3 -c "
import json
with open('$SRC') as f: t = json.load(f)
t['status'] = 'completed'
t['result'] = '''$RESULT'''
t['completed_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('$SRC', 'w') as f: json.dump(t, f, indent=2)
"
      mv "$SRC" "$DST"
      echo "Task completed: $FILE"
    else
      echo "Active task not found: $FILE"
      exit 1
    fi
    ;;

  fail)
    FILE="${3:?File required}"
    REASON="${4:-Unknown failure}"
    SRC="$TASKS_DIR/active/$FILE"
    DST="$TASKS_DIR/failed/$FILE"
    mkdir -p "$TASKS_DIR/failed"
    if [ -f "$SRC" ]; then
      python3 -c "
import json
with open('$SRC') as f: t = json.load(f)
t['status'] = 'failed'
t['error'] = '''$REASON'''
t['failed_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('$SRC', 'w') as f: json.dump(t, f, indent=2)
"
      mv "$SRC" "$DST"
      echo "Task failed: $FILE"
    else
      echo "Active task not found: $FILE"
      exit 1
    fi
    ;;

  *)
    echo "Usage: $0 <agent> [list|pickup|complete|fail] [file] [result/reason]"
    exit 1
    ;;
esac
