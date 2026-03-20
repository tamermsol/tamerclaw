#!/bin/bash
# Watchdog — ensures relay bot.js and watcher.js stay alive
# Uses PID files to avoid conflicting with supreme's bot.js
# Run via systemd: tamerclaw-relay.service
#
# Adapted for TamerClaw: all paths configurable via variables at top.

# ── Configurable Paths ────────────────────────────────────────────────────────
# Set TAMERCLAW_HOME to override (defaults to two levels up from this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAMERCLAW_HOME="${TAMERCLAW_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

RELAY_DIR="${TAMERCLAW_HOME}/core/relay"
LOG_DIR="${TAMERCLAW_HOME}/user/logs/relay"
BOT_LOG="$LOG_DIR/bot.log"
WATCHER_LOG="$LOG_DIR/watcher.log"
HEALTH="$RELAY_DIR/health.json"
BOT_PID_FILE="$RELAY_DIR/bot.pid"
WATCHER_PID_FILE="$RELAY_DIR/watcher.pid"
CHECK_INTERVAL=15  # seconds

# Ensure persistent log directory exists
mkdir -p "$LOG_DIR"

cd "$RELAY_DIR"
echo "[watchdog] Started at $(date -u)"
echo "[watchdog] TAMERCLAW_HOME=$TAMERCLAW_HOME"
echo "[watchdog] RELAY_DIR=$RELAY_DIR"

# Rotate logs if they exceed 10MB
rotate_log() {
  local logfile="$1"
  local max_size=$((10 * 1024 * 1024))  # 10MB
  if [ -f "$logfile" ]; then
    local size=$(stat -c %s "$logfile" 2>/dev/null || echo 0)
    if [ "$size" -gt "$max_size" ]; then
      mv "$logfile" "${logfile}.1"
      echo "[watchdog] Rotated $logfile (was ${size} bytes)" >> "$logfile"
    fi
  fi
}

cleanup() {
  echo "[watchdog] Stopping..."
  [ -f "$BOT_PID_FILE" ] && kill "$(cat "$BOT_PID_FILE")" 2>/dev/null && rm -f "$BOT_PID_FILE"
  [ -f "$WATCHER_PID_FILE" ] && kill "$(cat "$WATCHER_PID_FILE")" 2>/dev/null && rm -f "$WATCHER_PID_FILE"
  exit 0
}
trap cleanup SIGTERM SIGINT

is_running() {
  local pidfile="$1"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

while true; do
  # ── Rotate logs if needed ─────────────────────────────────────────────────
  rotate_log "$BOT_LOG"
  rotate_log "$WATCHER_LOG"

  # ── bot.js: Telegram poller ──────────────────────────────────────────────
  if ! is_running "$BOT_PID_FILE"; then
    echo "[watchdog] $(date -u) — relay bot.js not running, starting..."
    # Kill any orphan relay bot.js processes (but NOT supreme's bot.js)
    for pid in $(pgrep -f "node bot.js" 2>/dev/null); do
      # Only kill if running from relay directory
      if [ -d "/proc/$pid" ] && readlink -f "/proc/$pid/cwd" 2>/dev/null | grep -q "relay"; then
        echo "[watchdog] Killing orphan relay bot.js (PID $pid)"
        kill "$pid" 2>/dev/null
      fi
    done
    # Cooldown: let Telegram release the old polling session
    echo "[watchdog] Waiting 8s for Telegram polling session to expire..."
    sleep 8
    node bot.js >> "$BOT_LOG" 2>&1 &
    echo $! > "$BOT_PID_FILE"
    echo "[watchdog] Started relay bot.js (PID: $(cat "$BOT_PID_FILE"))"
    sleep 3
  fi

  # ── watcher.js: message processor ───────────────────────────────────────
  if ! is_running "$WATCHER_PID_FILE"; then
    echo "[watchdog] $(date -u) — relay watcher.js not running, starting..."
    node watcher.js >> "$WATCHER_LOG" 2>&1 &
    echo $! > "$WATCHER_PID_FILE"
    echo "[watchdog] Started relay watcher.js (PID: $(cat "$WATCHER_PID_FILE"))"
    sleep 5
  fi

  # ── Health staleness check (watcher stuck detection) ────────────────────
  if [ -f "$HEALTH" ]; then
    HEALTH_AGE=$(( $(date +%s) - $(stat -c %Y "$HEALTH" 2>/dev/null || echo 0) ))
    if [ "$HEALTH_AGE" -gt 600 ]; then
      echo "[watchdog] $(date -u) — health file stale (${HEALTH_AGE}s), restarting watcher"
      [ -f "$WATCHER_PID_FILE" ] && kill "$(cat "$WATCHER_PID_FILE")" 2>/dev/null
      sleep 2
      node watcher.js >> "$WATCHER_LOG" 2>&1 &
      echo $! > "$WATCHER_PID_FILE"
      echo "[watchdog] Restarted watcher (PID: $(cat "$WATCHER_PID_FILE"))"
      sleep 5
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
