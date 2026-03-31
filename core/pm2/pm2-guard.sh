#!/bin/bash
# PM2 Guard — Wrapper script that enforces per-agent PM2 ownership
# Usage: pm2-guard.sh <agent-name> <pm2-command> [args...]
#
# Examples:
#   pm2-guard.sh msol start ecosystem.config.js
#   pm2-guard.sh msol restart msol-website
#   pm2-guard.sh msol stop msol-website
#   pm2-guard.sh msol logs msol-website

set -euo pipefail

# Registry path — resolve relative to TAMERCLAW_HOME or use default
TAMERCLAW_HOME="${TAMERCLAW_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
REGISTRY="${TAMERCLAW_HOME}/user/pm2/registry.json"
AGENT_NAME="${1:-}"
PM2_CMD="${2:-}"
shift 2 2>/dev/null || true
PM2_ARGS="$@"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "$AGENT_NAME" ] || [ -z "$PM2_CMD" ]; then
    echo -e "${RED}Usage: pm2-guard.sh <agent-name> <pm2-command> [args...]${NC}"
    exit 1
fi

# Ensure registry exists
if [ ! -f "$REGISTRY" ]; then
    mkdir -p "$(dirname "$REGISTRY")"
    echo '{"processes": {}, "reserved_ports": {}}' > "$REGISTRY"
fi

# Always-safe commands (read-only)
SAFE_COMMANDS="list status jlist prettylist monit logs"

if echo "$SAFE_COMMANDS" | grep -qw "$PM2_CMD"; then
    pm2 "$PM2_CMD" $PM2_ARGS
    exit 0
fi

# Blocked global commands
BLOCKED_COMMANDS="kill flush reset unstartup"
if echo "$BLOCKED_COMMANDS" | grep -qw "$PM2_CMD"; then
    echo -e "${RED}BLOCKED: 'pm2 $PM2_CMD' is a global destructive command and is never allowed.${NC}"
    exit 1
fi

# For start/stop/restart/delete — check ownership
MUTATING_COMMANDS="start stop restart delete reload"

if echo "$MUTATING_COMMANDS" | grep -qw "$PM2_CMD"; then
    # Extract the process name from args
    PROCESS_NAME=""

    if [ "$PM2_CMD" = "start" ]; then
        # For start, check --name flag or ecosystem config
        if echo "$PM2_ARGS" | grep -q "\-\-name"; then
            PROCESS_NAME=$(echo "$PM2_ARGS" | grep -oP '(?<=--name\s)\S+')
        fi
    else
        # For stop/restart/delete, first arg is the process name
        PROCESS_NAME=$(echo "$PM2_ARGS" | awk '{print $1}')
    fi

    # Block "all" target
    if [ "$PROCESS_NAME" = "all" ]; then
        echo -e "${RED}BLOCKED: 'pm2 $PM2_CMD all' is not allowed. Target specific processes.${NC}"
        exit 1
    fi

    # For non-start commands, verify ownership
    if [ "$PM2_CMD" != "start" ] && [ -n "$PROCESS_NAME" ]; then
        OWNER=$(jq -r ".processes.\"$PROCESS_NAME\".owner // empty" "$REGISTRY" 2>/dev/null)

        if [ -n "$OWNER" ] && [ "$OWNER" != "$AGENT_NAME" ]; then
            echo -e "${RED}BLOCKED: Process '$PROCESS_NAME' is owned by agent '$OWNER', not '$AGENT_NAME'.${NC}"
            echo -e "${YELLOW}Only the owning agent can $PM2_CMD this process.${NC}"
            exit 1
        fi
    fi

    # For start, register the new process
    if [ "$PM2_CMD" = "start" ] && [ -n "$PROCESS_NAME" ]; then
        # Check if already owned by someone else
        EXISTING_OWNER=$(jq -r ".processes.\"$PROCESS_NAME\".owner // empty" "$REGISTRY" 2>/dev/null)

        if [ -n "$EXISTING_OWNER" ] && [ "$EXISTING_OWNER" != "$AGENT_NAME" ]; then
            echo -e "${RED}BLOCKED: Process name '$PROCESS_NAME' is already registered to agent '$EXISTING_OWNER'.${NC}"
            exit 1
        fi

        # Check port conflicts
        PORT=""
        if echo "$PM2_ARGS" | grep -qP '(?:--|-)port'; then
            PORT=$(echo "$PM2_ARGS" | grep -oP '(?<=--port\s)\d+|(?<=-p\s)\d+')
        fi

        if [ -n "$PORT" ]; then
            PORT_OWNER=$(jq -r ".reserved_ports.\"$PORT\" // empty" "$REGISTRY" 2>/dev/null)
            if [ -n "$PORT_OWNER" ] && [ "$PORT_OWNER" != "$PROCESS_NAME" ]; then
                echo -e "${RED}BLOCKED: Port $PORT is reserved by process '$PORT_OWNER'.${NC}"
                echo -e "${YELLOW}Choose a different port.${NC}"
                exit 1
            fi
        fi
    fi

    echo -e "${GREEN}[pm2-guard] Agent '$AGENT_NAME' executing: pm2 $PM2_CMD $PM2_ARGS${NC}"
    pm2 "$PM2_CMD" $PM2_ARGS

    # Auto-register on successful start
    if [ "$PM2_CMD" = "start" ] && [ -n "$PROCESS_NAME" ] && [ $? -eq 0 ]; then
        # Add to registry if not already there
        EXISTING=$(jq -r ".processes.\"$PROCESS_NAME\" // empty" "$REGISTRY" 2>/dev/null)
        if [ -z "$EXISTING" ]; then
            TMP=$(mktemp)
            jq ".processes.\"$PROCESS_NAME\" = {\"owner\": \"$AGENT_NAME\", \"port\": null, \"description\": \"Started by $AGENT_NAME\"}" "$REGISTRY" > "$TMP" && mv "$TMP" "$REGISTRY"
            echo -e "${GREEN}[pm2-guard] Registered '$PROCESS_NAME' under agent '$AGENT_NAME'${NC}"
        fi
    fi

    exit 0
fi

# Unknown command — pass through with warning
echo -e "${YELLOW}[pm2-guard] Warning: Unrecognized PM2 command '$PM2_CMD'. Passing through.${NC}"
pm2 "$PM2_CMD" $PM2_ARGS
