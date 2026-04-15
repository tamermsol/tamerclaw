#!/bin/bash
# Port 2222 Tunnel Guardian — runs every 15 seconds via systemd timer
# Detects stale sshd processes holding port 2222 and kills them instantly
# so the Mac Mini's autossh can reconnect without delay.

PORT=2222
TAMERCLAW_HOME="${TAMERCLAW_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
LOG="${TAMERCLAW_HOME}/core/compute/port-cleanup.log"
MAX_LOG=200

log() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $1" >> "$LOG"
    # Trim log
    if [ -f "$LOG" ]; then
        lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
        if [ "$lines" -gt "$MAX_LOG" ]; then
            tail -n "$MAX_LOG" "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
        fi
    fi
}

# Check if port 2222 is in use
PORT_PIDS=$(ss -tlnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | sort -u)

if [ -z "$PORT_PIDS" ]; then
    # Port is free — nothing to do
    exit 0
fi

# Port is in use — quick check if tunnel actually works
# Use a very short timeout (2s) so we don't block
TUNNEL_OK=$(timeout 3 ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o BatchMode=yes -p ${PORT} msoldev@localhost "echo ok" 2>/dev/null)

if [ "$TUNNEL_OK" = "ok" ]; then
    # Tunnel is alive — don't touch
    exit 0
fi

# Tunnel is dead but port is held — kill the stale sshd processes
for pid in $PORT_PIDS; do
    # Verify it's actually an sshd process
    CMDLINE=$(cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ')
    if echo "$CMDLINE" | grep -q "sshd"; then
        kill "$pid" 2>/dev/null
        log "Killed stale sshd PID $pid (port ${PORT} freed for Mac reconnect)"
    fi
done

# Double-check: if port still held after kill, force kill
sleep 1
STILL_HELD=$(ss -tlnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | sort -u)
if [ -n "$STILL_HELD" ]; then
    for pid in $STILL_HELD; do
        kill -9 "$pid" 2>/dev/null
        log "FORCE killed PID $pid (port ${PORT} still held after SIGTERM)"
    done
fi
