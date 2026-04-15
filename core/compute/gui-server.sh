#!/bin/bash
# =============================================================================
# GUI Agent Server — runs on Mac Mini in the Aqua/GUI session
# Polls /tmp/claude-compute/gui-queue/ for .cmd files, executes GUI commands,
# writes .result files. Deployed as a LaunchAgent so it inherits WindowServer.
# =============================================================================

set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

QUEUE_DIR="/tmp/claude-compute/gui-queue"
SCREENSHOTS_DIR="/tmp/claude-compute/screenshots"
LOG_FILE="/tmp/claude-compute/gui-server.log"
POLL_INTERVAL=0.5

mkdir -p "$QUEUE_DIR" "$SCREENSHOTS_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

write_result() {
  local result_file="$1"
  local success="$2"
  local data="$3"
  if [ "$success" = "true" ]; then
    printf '{"success":true,"data":%s}\n' "$(echo "$data" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')" > "$result_file"
  else
    printf '{"success":false,"error":%s}\n' "$(echo "$data" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')" > "$result_file"
  fi
}

handle_screenshot() {
  local args="$1"
  local result_file="$2"
  local out_path
  out_path=$(echo "$args" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("path","/tmp/claude-compute/screenshots/shot-'$$'-'$RANDOM'.png"))')
  mkdir -p "$(dirname "$out_path")"
  if screencapture -x "$out_path" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "$out_path"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_screenshot_region() {
  local args="$1"
  local result_file="$2"
  local out_path x y w h
  out_path=$(echo "$args" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("path","/tmp/claude-compute/screenshots/shot-region.png"))')
  x=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["x"])')
  y=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["y"])')
  w=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["w"])')
  h=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["h"])')
  mkdir -p "$(dirname "$out_path")"
  if screencapture -x -R"${x},${y},${w},${h}" "$out_path" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "$out_path"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_click() {
  local args="$1"
  local result_file="$2"
  local x y
  x=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["x"])')
  y=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["y"])')
  if /opt/homebrew/bin/cliclick c:"${x},${y}" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "clicked ${x},${y}"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_doubleclick() {
  local args="$1"
  local result_file="$2"
  local x y
  x=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["x"])')
  y=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["y"])')
  if /opt/homebrew/bin/cliclick dc:"${x},${y}" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "double-clicked ${x},${y}"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_rightclick() {
  local args="$1"
  local result_file="$2"
  local x y
  x=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["x"])')
  y=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["y"])')
  if /opt/homebrew/bin/cliclick rc:"${x},${y}" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "right-clicked ${x},${y}"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_type() {
  local args="$1"
  local result_file="$2"
  local text
  text=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["text"])')
  if /opt/homebrew/bin/cliclick t:"$text" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "typed text"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_key() {
  local args="$1"
  local result_file="$2"
  local combo
  combo=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["combo"])')
  # Convert human-friendly combos (cmd+c) to cliclick format (cmd:c)
  local cliclick_keys
  cliclick_keys=$(echo "$combo" | python3 -c '
import sys
combo = sys.stdin.read().strip()
# Map modifier names to cliclick modifier names
mods = {"cmd": "cmd", "command": "cmd", "ctrl": "ctrl", "control": "ctrl",
        "alt": "alt", "option": "alt", "shift": "shift", "fn": "fn"}
parts = combo.split("+")
if len(parts) == 1:
    print("kp:" + parts[0])
else:
    # All but last are modifiers, last is the key
    mod_parts = parts[:-1]
    key = parts[-1]
    # cliclick: kd:cmd kp:c ku:cmd
    cmds = []
    for m in mod_parts:
        cmds.append("kd:" + mods.get(m.lower(), m))
    cmds.append("kp:" + key)
    for m in reversed(mod_parts):
        cmds.append("ku:" + mods.get(m.lower(), m))
    print(" ".join(cmds))
')
  if /opt/homebrew/bin/cliclick $cliclick_keys 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "key combo: $combo"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_open_app() {
  local args="$1"
  local result_file="$2"
  local app_name
  app_name=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')
  if open -a "$app_name" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "opened $app_name"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_open_url() {
  local args="$1"
  local result_file="$2"
  local url
  url=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["url"])')
  if open "$url" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "opened $url"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_applescript() {
  local args="$1"
  local result_file="$2"
  local script
  script=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["script"])')
  local output
  if output=$(osascript -e "$script" 2>/tmp/claude-compute/gui-stderr.tmp); then
    write_result "$result_file" "true" "$output"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_shell() {
  local args="$1"
  local result_file="$2"
  local cmd
  cmd=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["command"])')
  local output
  if output=$(bash -c "$cmd" 2>&1); then
    write_result "$result_file" "true" "$output"
  else
    write_result "$result_file" "false" "$output"
  fi
}

handle_move() {
  local args="$1"
  local result_file="$2"
  local x y
  x=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["x"])')
  y=$(echo "$args" | python3 -c 'import sys,json; print(json.load(sys.stdin)["y"])')
  if /opt/homebrew/bin/cliclick m:"${x},${y}" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "moved to ${x},${y}"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

handle_drag() {
  local args="$1"
  local result_file="$2"
  local x1 y1 x2 y2
  x1=$(echo "$args" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["x1"])')
  y1=$(echo "$args" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["y1"])')
  x2=$(echo "$args" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["x2"])')
  y2=$(echo "$args" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["y2"])')
  if /opt/homebrew/bin/cliclick dd:"${x1},${y1}" du:"${x2},${y2}" 2>/tmp/claude-compute/gui-stderr.tmp; then
    write_result "$result_file" "true" "dragged ${x1},${y1} -> ${x2},${y2}"
  else
    write_result "$result_file" "false" "$(cat /tmp/claude-compute/gui-stderr.tmp)"
  fi
}

process_cmd() {
  local cmd_file="$1"
  local basename
  basename=$(basename "$cmd_file" .cmd)
  local result_file="${QUEUE_DIR}/${basename}.result"

  log "Processing: $cmd_file"

  local cmd_type args
  cmd_type=$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1]))["type"])' "$cmd_file" 2>/dev/null || echo "unknown")
  args=$(python3 -c 'import sys,json; print(json.dumps(json.load(open(sys.argv[1])).get("args",{})))' "$cmd_file" 2>/dev/null || echo '{}')

  case "$cmd_type" in
    screenshot)       handle_screenshot "$args" "$result_file" ;;
    screenshot-region) handle_screenshot_region "$args" "$result_file" ;;
    click)            handle_click "$args" "$result_file" ;;
    doubleclick)      handle_doubleclick "$args" "$result_file" ;;
    rightclick)       handle_rightclick "$args" "$result_file" ;;
    type)             handle_type "$args" "$result_file" ;;
    key)              handle_key "$args" "$result_file" ;;
    open-app)         handle_open_app "$args" "$result_file" ;;
    open-url)         handle_open_url "$args" "$result_file" ;;
    applescript)      handle_applescript "$args" "$result_file" ;;
    shell)            handle_shell "$args" "$result_file" ;;
    move)             handle_move "$args" "$result_file" ;;
    drag)             handle_drag "$args" "$result_file" ;;
    *)
      write_result "$result_file" "false" "Unknown command type: $cmd_type"
      log "Unknown command type: $cmd_type"
      ;;
  esac

  # Remove processed command file
  rm -f "$cmd_file"
  log "Done: $basename (type=$cmd_type)"
}

# Cleanup old files on startup
find "$QUEUE_DIR" -name "*.cmd" -mmin +10 -delete 2>/dev/null || true
find "$QUEUE_DIR" -name "*.result" -mmin +30 -delete 2>/dev/null || true
find "$SCREENSHOTS_DIR" -name "*.png" -mmin +60 -delete 2>/dev/null || true

log "GUI Agent Server started (PID=$$)"
log "Queue dir: $QUEUE_DIR"
log "Poll interval: ${POLL_INTERVAL}s"

# Main poll loop
while true; do
  for cmd_file in "$QUEUE_DIR"/*.cmd; do
    [ -f "$cmd_file" ] || continue
    process_cmd "$cmd_file" || log "ERROR processing $cmd_file"
  done
  sleep "$POLL_INTERVAL"
done
