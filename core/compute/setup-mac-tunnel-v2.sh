#!/bin/bash
# ============================================================
# Mac Mini Reverse SSH Tunnel — v2 (Bulletproof Edition)
# Run THIS SCRIPT on the Mac Mini to connect it to the server.
#
# WHAT'S NEW in v2:
#   1. caffeinate wrapper — prevents macOS sleep via power assertions
#   2. Aggressive watchdog (every 30s) — not just process check, but
#      verifies tunnel is actually functional, force-restarts if dead
#   3. Network change listener — detects WiFi/Ethernet changes and
#      immediately triggers tunnel restart
#   4. Wrapper script that combines autossh + caffeinate + logging
#   5. Auto-clears stale known_hosts entries that block reconnection
#
# REQUIRES: sudo (for LaunchDaemon + pmset)
# Run: sudo bash setup-mac-tunnel-v2.sh [start|stop|status]
#
# Prerequisites:
#   - SSH key exchanged (root@server can SSH to <mac_user>@mac)
#   - autossh installed: brew install autossh
#
# Configuration via environment variables:
#   TAMERCLAW_SERVER_IP   — server IP address (required)
#   TAMERCLAW_SERVER_USER — server SSH user (default: root)
#   TAMERCLAW_MAC_USER    — Mac Mini local user (default: current user)
# ============================================================

SERVER_IP="${TAMERCLAW_SERVER_IP:?Set TAMERCLAW_SERVER_IP to your server IP}"
SERVER_USER="${TAMERCLAW_SERVER_USER:-root}"
SERVER_PORT=22
TUNNEL_PORT=2222
LOCAL_SSH_PORT=22
MAC_USER="${TAMERCLAW_MAC_USER:-$(whoami)}"
MAC_HOME="${HOME:-/Users/${MAC_USER}}"

# Paths
DAEMON_LABEL="com.tamerclaw.tunnel"
DAEMON_PLIST="/Library/LaunchDaemons/${DAEMON_LABEL}.plist"
WATCHDOG_LABEL="com.tamerclaw.tunnel-watchdog"
WATCHDOG_PLIST="/Library/LaunchDaemons/${WATCHDOG_LABEL}.plist"
NETWATCH_LABEL="com.tamerclaw.tunnel-netwatch"
NETWATCH_PLIST="/Library/LaunchDaemons/${NETWATCH_LABEL}.plist"
CAFFEINATE_LABEL="com.tamerclaw.caffeinate"
CAFFEINATE_PLIST="/Library/LaunchDaemons/${CAFFEINATE_LABEL}.plist"

TUNNEL_WRAPPER="/usr/local/bin/tamerclaw-tunnel.sh"
WATCHDOG_SCRIPT="/usr/local/bin/tamerclaw-tunnel-watchdog.sh"
NETWATCH_SCRIPT="/usr/local/bin/tamerclaw-tunnel-netwatch.sh"

LOG_DIR="/var/log/tamerclaw-tunnel"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ---- Pre-flight checks ----

check_root() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}This script must be run with sudo:${NC}"
        echo "  sudo bash $0 $@"
        exit 1
    fi
}

# ---- Helper Functions ----

kill_all_tunnels() {
    echo -e "${YELLOW}Cleaning up ALL existing tunnel processes...${NC}"

    # Unload all daemons
    for label in "$DAEMON_LABEL" "$WATCHDOG_LABEL" "$NETWATCH_LABEL" "$CAFFEINATE_LABEL"; do
        launchctl bootout system "/Library/LaunchDaemons/${label}.plist" 2>/dev/null
        launchctl unload "/Library/LaunchDaemons/${label}.plist" 2>/dev/null
    done

    # Kill all autossh
    killall autossh 2>/dev/null
    sleep 1

    # Kill orphaned SSH tunnel processes
    pkill -f "ssh.*-R.*${TUNNEL_PORT}:localhost" 2>/dev/null
    sleep 1

    # Kill any lingering caffeinate from old setup
    pkill -f "caffeinate.*tamerclaw" 2>/dev/null

    # Force-kill if still alive
    local count=$(pgrep -c autossh 2>/dev/null || echo 0)
    if [ "$count" -gt "0" ]; then
        echo -e "${RED}Force killing remaining processes...${NC}"
        pkill -9 autossh 2>/dev/null
        pkill -9 -f "ssh.*-R.*${TUNNEL_PORT}:localhost" 2>/dev/null
        sleep 1
    fi

    echo -e "${GREEN}All tunnel processes cleaned up.${NC}"
}

check_status() {
    echo -e "${BLUE}=== TamerClaw Tunnel v2 Status ===${NC}"
    echo ""

    # autossh
    local count=$(pgrep -c autossh 2>/dev/null || echo 0)
    if [ "$count" -eq "1" ]; then
        echo -e "  autossh: ${GREEN}Running (1 process)${NC}"
        ps aux | grep autossh | grep -v grep | awk '{print "    PID:", $2, "User:", $1, "Started:", $9}'
    elif [ "$count" -gt "1" ]; then
        echo -e "  autossh: ${RED}WARNING -- $count processes (should be 1)${NC}"
        ps aux | grep autossh | grep -v grep
    else
        echo -e "  autossh: ${RED}Not running${NC}"
    fi

    # caffeinate
    echo ""
    if pgrep -f "caffeinate" &>/dev/null; then
        echo -e "  caffeinate: ${GREEN}Running (sleep prevention active)${NC}"
    else
        echo -e "  caffeinate: ${RED}Not running -- Mac may sleep!${NC}"
    fi

    # SSH tunnels
    echo ""
    local ssh_tunnels=$(pgrep -f "ssh.*-R.*${TUNNEL_PORT}" 2>/dev/null | wc -l | tr -d ' ')
    echo -e "  SSH tunnels: ${ssh_tunnels} process(es)"

    # LaunchDaemons
    echo ""
    for plist in "$DAEMON_PLIST" "$WATCHDOG_PLIST" "$NETWATCH_PLIST" "$CAFFEINATE_PLIST"; do
        local name=$(basename "$plist" .plist)
        if [ -f "$plist" ]; then
            echo -e "  ${name}: ${GREEN}Installed${NC}"
        else
            echo -e "  ${name}: ${RED}Not installed${NC}"
        fi
    done

    # Server connectivity
    echo ""
    echo "  Testing SSH to server..."
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ${SERVER_USER}@${SERVER_IP} -p ${SERVER_PORT} "echo ok" &>/dev/null; then
        echo -e "  Server SSH: ${GREEN}Reachable${NC}"

        local port_check=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ${SERVER_USER}@${SERVER_IP} -p ${SERVER_PORT} "ss -tln | grep ':${TUNNEL_PORT}'" 2>/dev/null)
        if [ -n "$port_check" ]; then
            echo -e "  Tunnel port ${TUNNEL_PORT}: ${GREEN}Bound on server${NC}"

            # End-to-end test
            local e2e=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ${SERVER_USER}@${SERVER_IP} -p ${SERVER_PORT} \
                "ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes -p ${TUNNEL_PORT} ${MAC_USER}@localhost 'echo e2e-ok' 2>/dev/null" 2>/dev/null)
            if [ "$e2e" = "e2e-ok" ]; then
                echo -e "  End-to-end: ${GREEN}WORKING${NC}"
            else
                echo -e "  End-to-end: ${RED}BROKEN (port bound but can't connect through)${NC}"
            fi
        else
            echo -e "  Tunnel port ${TUNNEL_PORT}: ${RED}NOT bound on server${NC}"
        fi
    else
        echo -e "  Server SSH: ${RED}Unreachable${NC}"
    fi

    # Sleep settings
    echo ""
    local sleep_val=$(pmset -g | grep "^ sleep" | awk '{print $2}')
    if [ "$sleep_val" = "0" ]; then
        echo -e "  Sleep (pmset): ${GREEN}Disabled${NC}"
    else
        echo -e "  Sleep (pmset): ${RED}Enabled (${sleep_val} min)${NC}"
    fi

    # Power assertions
    local assertions=$(pmset -g assertions 2>/dev/null | grep -c "PreventUserIdleSystemSleep" || echo 0)
    if [ "$assertions" -gt "0" ]; then
        echo -e "  Sleep assertion: ${GREEN}Active ($assertions)${NC}"
    else
        echo -e "  Sleep assertion: ${RED}None -- caffeinate may not be running${NC}"
    fi

    # Recent watchdog log
    echo ""
    if [ -f "${LOG_DIR}/watchdog.log" ]; then
        echo "  Last 5 watchdog entries:"
        tail -5 "${LOG_DIR}/watchdog.log" | sed 's/^/    /'
    fi

    echo ""
}

# ---- Commands ----

cmd_stop() {
    check_root
    echo -e "${GREEN}=== Stopping TamerClaw Tunnel v2 ===${NC}"
    kill_all_tunnels

    # Remove scripts and plists
    rm -f "${DAEMON_PLIST}" "${WATCHDOG_PLIST}" "${NETWATCH_PLIST}" "${CAFFEINATE_PLIST}"
    echo -e "${GREEN}Tunnel v2 stopped and all daemons removed.${NC}"
}

cmd_start() {
    check_root
    echo -e "${GREEN}=== TamerClaw Tunnel v2 -- Bulletproof Setup ===${NC}"
    echo ""

    # 1. Find autossh
    local AUTOSSH_PATH=$(which autossh 2>/dev/null)
    if [ -z "$AUTOSSH_PATH" ]; then
        AUTOSSH_PATH="/opt/homebrew/bin/autossh"
    fi
    if [ ! -f "$AUTOSSH_PATH" ]; then
        echo -e "${RED}autossh not found. Install: brew install autossh${NC}"
        exit 1
    fi
    echo -e "  autossh: ${GREEN}${AUTOSSH_PATH}${NC}"

    # 2. Find SSH key
    local SSH_KEY="${MAC_HOME}/.ssh/id_ed25519"
    if [ ! -f "$SSH_KEY" ]; then
        SSH_KEY="${MAC_HOME}/.ssh/id_rsa"
    fi
    if [ ! -f "$SSH_KEY" ]; then
        echo -e "${RED}No SSH key found${NC}"
        exit 1
    fi
    echo -e "  SSH key: ${GREEN}${SSH_KEY}${NC}"

    # 3. Test connectivity
    echo "  Testing SSH to server..."
    if sudo -u "${MAC_USER}" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes -i "${SSH_KEY}" ${SERVER_USER}@${SERVER_IP} -p ${SERVER_PORT} "echo ok" &>/dev/null; then
        echo -e "  Server: ${GREEN}Reachable${NC}"
    else
        echo -e "${RED}Cannot SSH to server. Check keys/network.${NC}"
        exit 1
    fi

    # 4. Enable Remote Login
    if ! systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
        systemsetup -setremotelogin on
    fi
    echo -e "  Remote Login: ${GREEN}Enabled${NC}"

    # 5. Prevent sleep (belt AND suspenders)
    echo "  Configuring power management..."
    pmset -a sleep 0
    pmset -a disablesleep 1
    pmset -a displaysleep 0
    pmset -a autopoweroff 0
    pmset -a standby 0
    pmset -a hibernatemode 0
    pmset -a ttyskeepawake 1
    pmset -a tcpkeepalive 1
    pmset -a powernap 0
    echo -e "  Sleep: ${GREEN}Fully disabled (pmset)${NC}"

    # 6. Clean slate
    kill_all_tunnels

    # 7. Setup
    mkdir -p "${LOG_DIR}"
    chown "${MAC_USER}:staff" "${LOG_DIR}"
    echo -e "  Logs: ${GREEN}${LOG_DIR}/${NC}"

    # =============================================
    # 8. TUNNEL WRAPPER SCRIPT
    # =============================================
    echo -e "${BLUE}Creating tunnel wrapper (autossh + caffeinate)...${NC}"
    cat > "${TUNNEL_WRAPPER}" << WRAPEOF
#!/bin/bash
# TamerClaw Tunnel Wrapper — runs autossh inside caffeinate
export AUTOSSH_GATETIME=0
export AUTOSSH_FIRST_POLL=15
export AUTOSSH_POLL=15
export AUTOSSH_LOGFILE="${LOG_DIR}/autossh.log"
export AUTOSSH_DEBUG=1

# Clear any stale known_hosts entries
sudo -u "${MAC_USER}" ssh-keygen -R "${SERVER_IP}" 2>/dev/null
sudo -u "${MAC_USER}" ssh-keygen -R "[${SERVER_IP}]:${SERVER_PORT}" 2>/dev/null

echo "[$(date)] Starting autossh tunnel with caffeinate..." >> "${LOG_DIR}/tunnel.log"

exec /usr/bin/caffeinate -s -i ${AUTOSSH_PATH} \
    -M 0 \
    -N \
    -o "ServerAliveInterval=15" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "TCPKeepAlive=yes" \
    -o "StrictHostKeyChecking=no" \
    -o "IdentityFile=${SSH_KEY}" \
    -o "ConnectionAttempts=5" \
    -o "ConnectTimeout=10" \
    -R "${TUNNEL_PORT}:localhost:${LOCAL_SSH_PORT}" \
    ${SERVER_USER}@${SERVER_IP} \
    -p ${SERVER_PORT}
WRAPEOF
    chmod +x "${TUNNEL_WRAPPER}"

    # =============================================
    # 9. WATCHDOG SCRIPT (every 30 seconds)
    # =============================================
    echo -e "${BLUE}Creating watchdog script (30s interval)...${NC}"
    cat > "${WATCHDOG_SCRIPT}" << 'WATCHEOF'
#!/bin/bash
# TamerClaw Tunnel Watchdog v2
# Runs every 30 seconds. Verifies tunnel is FUNCTIONAL, not just alive.

LOG="/var/log/tamerclaw-tunnel/watchdog.log"
MAX_LOG_LINES=300

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
    if [ -f "$LOG" ]; then
        local lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
        if [ "$lines" -gt "$MAX_LOG_LINES" ]; then
            tail -n "$MAX_LOG_LINES" "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
        fi
    fi
}

SERVER="${TAMERCLAW_SERVER_USER:-root}@${TAMERCLAW_SERVER_IP}"
SERVER_PORT=22
TUNNEL_PORT=2222
CONSECUTIVE_FAIL_FILE="/var/log/tamerclaw-tunnel/.consecutive_fails"

get_fails() {
    cat "$CONSECUTIVE_FAIL_FILE" 2>/dev/null || echo 0
}

set_fails() {
    echo "$1" > "$CONSECUTIVE_FAIL_FILE"
}

restart_tunnel() {
    log "RESTARTING: Killing autossh for launchd restart..."
    killall autossh 2>/dev/null
    pkill -f "ssh.*-R.*2222:localhost" 2>/dev/null
    sleep 2
    killall -9 autossh 2>/dev/null
    pkill -9 -f "ssh.*-R.*2222:localhost" 2>/dev/null
    log "autossh killed — launchd KeepAlive will restart in ~15s"
}

# Check 1: Is autossh running?
AUTOSSH_PID=$(pgrep autossh 2>/dev/null | head -1)
if [ -z "$AUTOSSH_PID" ]; then
    log "WARN: autossh not running — launchd should restart it"
    set_fails 0
    exit 0
fi

# Check 2: Can we reach the server at all?
if ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" "echo ok" &>/dev/null; then
    FAILS=$(get_fails)
    FAILS=$((FAILS + 1))
    set_fails $FAILS
    log "WARN: Cannot reach server (attempt $FAILS) — network may be down"

    if [ "$FAILS" -ge 10 ]; then
        log "Server unreachable for 5+ minutes — restarting autossh to clear state"
        restart_tunnel
        set_fails 0
    fi
    exit 0
fi

# Check 3: Is our tunnel port bound on the server?
PORT_BOUND=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" "ss -tln | grep ':${TUNNEL_PORT}'" 2>/dev/null)

if [ -z "$PORT_BOUND" ]; then
    FAILS=$(get_fails)
    FAILS=$((FAILS + 1))
    set_fails $FAILS
    log "FAIL: Tunnel port not bound on server (attempt $FAILS)"

    if [ "$FAILS" -ge 2 ]; then
        log "Tunnel dead for 1+ minute — force restarting"
        ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" \
            "ss -tlnp | grep ':${TUNNEL_PORT}' | grep -oP 'pid=\K[0-9]+' | xargs -I{} kill {} 2>/dev/null" &>/dev/null
        restart_tunnel
        set_fails 0
    fi
    exit 0
fi

# Port is bound — tunnel is working
FAILS=$(get_fails)
if [ "$FAILS" -gt 0 ]; then
    log "OK: Tunnel recovered after $FAILS failed checks"
fi
set_fails 0

# Every 10th run (~5 min), do a full end-to-end verification
COUNTER_FILE="/var/log/tamerclaw-tunnel/.check_counter"
COUNTER=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
COUNTER=$((COUNTER + 1))
echo "$COUNTER" > "$COUNTER_FILE"

if [ $((COUNTER % 10)) -eq 0 ]; then
    MAC_USER="${TAMERCLAW_MAC_USER:-msoldev}"
    E2E=$(ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" \
        "ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes -p ${TUNNEL_PORT} ${MAC_USER}@localhost 'echo e2e-ok' 2>/dev/null" 2>/dev/null)
    if [ "$E2E" = "e2e-ok" ]; then
        log "OK: End-to-end verified (check #$COUNTER)"
    else
        log "WARN: Port bound but e2e failed — restarting tunnel"
        ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" \
            "ss -tlnp | grep ':${TUNNEL_PORT}' | grep -oP 'pid=\K[0-9]+' | xargs -I{} kill {} 2>/dev/null" &>/dev/null
        restart_tunnel
    fi
fi
WATCHEOF
    chmod +x "${WATCHDOG_SCRIPT}"

    # =============================================
    # 10. NETWORK CHANGE LISTENER
    # =============================================
    echo -e "${BLUE}Creating network change listener...${NC}"
    cat > "${NETWATCH_SCRIPT}" << 'NETWEOF'
#!/bin/bash
# TamerClaw Tunnel Network Watcher
# Uses scutil to watch for network changes.

LOG="/var/log/tamerclaw-tunnel/netwatch.log"
MAX_LOG_LINES=200

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
    if [ -f "$LOG" ]; then
        local lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
        if [ "$lines" -gt "$MAX_LOG_LINES" ]; then
            tail -n "$MAX_LOG_LINES" "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
        fi
    fi
}

log "Network watcher started"

SERVER="${TAMERCLAW_SERVER_USER:-root}@${TAMERCLAW_SERVER_IP}"
SERVER_PORT=22
TUNNEL_PORT=2222

while true; do
    scutil -w State:/Network/Global/IPv4 -t 120 2>/dev/null
    CHANGE_STATUS=$?

    if [ "$CHANGE_STATUS" -eq 0 ]; then
        log "Network change detected — waiting 5s for stabilization..."
        sleep 5
    else
        sleep 1
    fi

    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" "echo ok" &>/dev/null; then
        PORT_BOUND=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" "ss -tln | grep ':${TUNNEL_PORT}'" 2>/dev/null)
        if [ -z "$PORT_BOUND" ]; then
            log "Network OK but tunnel NOT bound — restarting autossh"
            ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$SERVER" -p "$SERVER_PORT" \
                "ss -tlnp | grep ':${TUNNEL_PORT}' | grep -oP 'pid=\K[0-9]+' | xargs -I{} kill {} 2>/dev/null" &>/dev/null
            killall autossh 2>/dev/null
            pkill -f "ssh.*-R.*${TUNNEL_PORT}:localhost" 2>/dev/null
            sleep 3
            log "autossh killed — launchd will restart"
        else
            if [ "$CHANGE_STATUS" -eq 0 ]; then
                log "Network changed but tunnel still working — OK"
            fi
        fi
    else
        if [ "$CHANGE_STATUS" -eq 0 ]; then
            log "Network changed but server unreachable — will retry"
        fi
    fi
done
NETWEOF
    chmod +x "${NETWATCH_SCRIPT}"

    # =============================================
    # 11. CREATE LAUNCHDAEMONS
    # =============================================
    echo ""
    echo -e "${BLUE}Creating LaunchDaemons...${NC}"

    # --- Tunnel Daemon ---
    cat > "${DAEMON_PLIST}" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${DAEMON_LABEL}</string>
    <key>UserName</key>
    <string>${MAC_USER}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${TUNNEL_WRAPPER}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/tunnel.err</string>
</dict>
</plist>
PLISTEOF
    chown root:wheel "${DAEMON_PLIST}"
    chmod 644 "${DAEMON_PLIST}"

    # --- Watchdog Daemon ---
    cat > "${WATCHDOG_PLIST}" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WATCHDOG_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${WATCHDOG_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/watchdog-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/watchdog-daemon.err</string>
</dict>
</plist>
PLISTEOF
    chown root:wheel "${WATCHDOG_PLIST}"
    chmod 644 "${WATCHDOG_PLIST}"

    # --- Network Change Listener ---
    cat > "${NETWATCH_PLIST}" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${NETWATCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${NETWATCH_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/netwatch-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/netwatch-daemon.err</string>
</dict>
</plist>
PLISTEOF
    chown root:wheel "${NETWATCH_PLIST}"
    chmod 644 "${NETWATCH_PLIST}"

    # --- Caffeinate Daemon ---
    cat > "${CAFFEINATE_PLIST}" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${CAFFEINATE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>-i</string>
        <string>-d</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
PLISTEOF
    chown root:wheel "${CAFFEINATE_PLIST}"
    chmod 644 "${CAFFEINATE_PLIST}"

    # =============================================
    # 12. LOAD ALL DAEMONS
    # =============================================
    echo ""
    echo -e "${BLUE}Loading LaunchDaemons...${NC}"
    launchctl load "${CAFFEINATE_PLIST}"
    sleep 1
    launchctl load "${DAEMON_PLIST}"
    launchctl load "${WATCHDOG_PLIST}"
    launchctl load "${NETWATCH_PLIST}"

    sleep 5

    # =============================================
    # 13. VERIFY
    # =============================================
    local autossh_count=$(pgrep -c autossh 2>/dev/null || echo 0)

    if [ "$autossh_count" -ge "1" ]; then
        echo ""
        echo -e "${GREEN}============================================${NC}"
        echo -e "${GREEN}  Tunnel v2 -- ACTIVE${NC}"
        echo -e "${GREEN}============================================${NC}"
        echo ""
        echo "  Running daemons:"
        echo "    - autossh tunnel (caffeinate-wrapped)"
        echo "    - Watchdog (every 30s -- verifies tunnel actually works)"
        echo "    - Network change listener (instant reconnect on network change)"
        echo "    - caffeinate (standalone sleep prevention)"
        echo ""
        echo "  Logs:"
        echo "    - Tunnel:   ${LOG_DIR}/tunnel.log"
        echo "    - Watchdog: ${LOG_DIR}/watchdog.log"
        echo "    - Network:  ${LOG_DIR}/netwatch.log"
        echo "    - autossh:  ${LOG_DIR}/autossh.log"
        echo ""
        echo "  Commands:"
        echo "    - Status:  sudo bash $0 status"
        echo "    - Stop:    sudo bash $0 stop"
        echo "    - Restart: sudo bash $0 stop && sudo bash $0 start"
        echo ""
        echo -e "  ${GREEN}Server can now: ssh ${MAC_USER}@localhost -p ${TUNNEL_PORT}${NC}"
    else
        echo -e "${RED}Tunnel failed to start. Check:${NC}"
        echo "  ${LOG_DIR}/tunnel.err"
        exit 1
    fi
}

# ---- Main ----

CMD="${1:-start}"

case "$CMD" in
    start)  cmd_start "$@" ;;
    stop)   cmd_stop ;;
    status) check_status ;;
    *)
        echo "Usage: sudo bash $0 [start|stop|status]"
        exit 1
        ;;
esac
