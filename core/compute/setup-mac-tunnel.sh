#!/bin/bash
# ============================================================
# Mac Mini Reverse SSH Tunnel Setup
# Run THIS SCRIPT on the Mac Mini to connect it to the server.
#
# Creates a persistent reverse tunnel so the server can
# reach the Mac Mini on localhost:2222.
#
# Uses a LaunchAgent for clean single-instance management.
# Run with: bash setup-mac-tunnel.sh [start|stop|status]
#
# Prerequisites:
#   - SSH key already exchanged
#   - autossh installed: brew install autossh
# ============================================================

SERVER_IP="${TAMERCLAW_SERVER_IP:-203.161.35.95}"
SERVER_USER="${TAMERCLAW_SERVER_USER:-root}"
SERVER_PORT=22
TUNNEL_PORT=2222
LOCAL_SSH_PORT=22
LABEL="com.tamerclaw.tunnel"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PIDFILE="/tmp/tamerclaw-tunnel.pid"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ---- Helper Functions ----

kill_all_autossh() {
    echo -e "${YELLOW}Cleaning up ALL existing autossh processes...${NC}"
    # Unload LaunchAgent if loaded
    launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null
    launchctl unload "$PLIST" 2>/dev/null
    # Kill every autossh process
    killall autossh 2>/dev/null
    # Also kill any orphaned SSH tunnel processes
    pkill -f "ssh.*-R.*${TUNNEL_PORT}:localhost" 2>/dev/null
    sleep 1
    # Verify they're dead
    local count=$(pgrep -c autossh 2>/dev/null || echo 0)
    if [ "$count" -gt "0" ]; then
        echo -e "${RED}Force killing remaining autossh processes...${NC}"
        pkill -9 autossh 2>/dev/null
        pkill -9 -f "ssh.*-R.*${TUNNEL_PORT}:localhost" 2>/dev/null
        sleep 1
    fi
    rm -f "$PIDFILE"
    echo -e "${GREEN}All autossh processes cleaned up.${NC}"
}

check_status() {
    local count=$(pgrep -c autossh 2>/dev/null || echo 0)
    if [ "$count" -eq "1" ]; then
        echo -e "${GREEN}Tunnel is running (1 autossh process)${NC}"
        return 0
    elif [ "$count" -gt "1" ]; then
        echo -e "${RED}WARNING: $count autossh processes running! Run: bash $0 stop && bash $0 start${NC}"
        return 1
    else
        echo -e "${YELLOW}Tunnel is not running.${NC}"
        return 1
    fi
}

# ---- Commands ----

cmd_stop() {
    echo -e "${GREEN}=== Stopping Mac Mini Tunnel ===${NC}"
    kill_all_autossh
    # Remove LaunchAgent plist to prevent restart on reboot
    rm -f "$PLIST"
    echo -e "${GREEN}Tunnel stopped and LaunchAgent removed.${NC}"
}

cmd_start() {
    echo -e "${GREEN}=== TamerClaw Compute Extension - Tunnel Setup ===${NC}"
    echo ""

    # Check autossh
    if ! command -v autossh &> /dev/null; then
        echo -e "${RED}autossh not found. Installing...${NC}"
        brew install autossh
    fi
    AUTOSSH_PATH=$(which autossh)

    # Test SSH connectivity
    echo "Testing SSH connectivity to server..."
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP} -p ${SERVER_PORT} "echo ok" &>/dev/null; then
        echo -e "${GREEN}SSH to server works${NC}"
    else
        echo -e "${RED}Cannot SSH to server. Check SERVER_IP and SSH keys.${NC}"
        exit 1
    fi

    # Enable Remote Login
    if ! systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
        echo "Enabling Remote Login..."
        sudo systemsetup -setremotelogin on
    fi

    # CLEAN SLATE: kill everything first
    kill_all_autossh

    # Create LaunchAgent plist (single instance, managed by launchd)
    echo ""
    echo "Creating LaunchAgent for managed tunnel..."
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${AUTOSSH_PATH}</string>
        <string>-M</string>
        <string>0</string>
        <string>-N</string>
        <string>-o</string>
        <string>ServerAliveInterval=30</string>
        <string>-o</string>
        <string>ServerAliveCountMax=3</string>
        <string>-o</string>
        <string>ExitOnForwardFailure=yes</string>
        <string>-o</string>
        <string>StrictHostKeyChecking=no</string>
        <string>-R</string>
        <string>${TUNNEL_PORT}:localhost:${LOCAL_SSH_PORT}</string>
        <string>${SERVER_USER}@${SERVER_IP}</string>
        <string>-p</string>
        <string>${SERVER_PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>NetworkState</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/tmp/tamerclaw-tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tamerclaw-tunnel.err</string>
</dict>
</plist>
PLISTEOF

    # Load the LaunchAgent (this starts it)
    launchctl load "$PLIST"

    sleep 2

    # Verify
    local count=$(pgrep -c autossh 2>/dev/null || echo 0)
    if [ "$count" -eq "1" ]; then
        echo -e "${GREEN}Reverse tunnel established! (single managed process)${NC}"
        echo "  Server can now: ssh <user>@localhost -p ${TUNNEL_PORT}"
        echo "  Logs: /tmp/tamerclaw-tunnel.log"
        echo "  Errors: /tmp/tamerclaw-tunnel.err"
        echo ""
        echo "  Tunnel will auto-start on login and reconnect on network changes."
        echo "  To stop:  bash $0 stop"
        echo "  To check: bash $0 status"
    elif [ "$count" -gt "1" ]; then
        echo -e "${RED}WARNING: Multiple autossh processes detected ($count). Cleaning up...${NC}"
        kill_all_autossh
        launchctl load "$PLIST"
        sleep 2
        echo -e "${GREEN}Retried. Check: bash $0 status${NC}"
    else
        echo -e "${RED}Tunnel failed to start. Check /tmp/tamerclaw-tunnel.err${NC}"
        exit 1
    fi
}

# ---- Main ----

CMD="${1:-start}"

case "$CMD" in
    start)  cmd_start ;;
    stop)   cmd_stop ;;
    status) check_status ;;
    *)
        echo "Usage: bash $0 [start|stop|status]"
        exit 1
        ;;
esac
