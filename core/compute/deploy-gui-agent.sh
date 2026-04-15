#!/bin/bash
# =============================================================================
# Deploy GUI Agent to Mac Mini
# Run this from the server when the SSH tunnel is active.
# Usage: bash deploy-gui-agent.sh
# =============================================================================

set -euo pipefail

SSH_CMD="ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o BatchMode=yes -p 2222 msoldev@localhost"
SCP_CMD="scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o BatchMode=yes -P 2222"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== GUI Agent Deployment ==="

# 1. Check SSH connectivity
echo "[1/6] Checking SSH connectivity..."
if ! $SSH_CMD 'echo ok' >/dev/null 2>&1; then
  echo "ERROR: Cannot reach Mac Mini via SSH tunnel on port 2222."
  echo "Make sure the reverse tunnel is active on the Mac."
  exit 1
fi
echo "  SSH connection OK"

# 2. Create directories on Mac
echo "[2/6] Creating directories on Mac Mini..."
$SSH_CMD 'mkdir -p ~/claude-gui-agent /tmp/claude-compute/gui-queue /tmp/claude-compute/screenshots'
echo "  Directories created"

# 3. Upload gui-server.sh
echo "[3/6] Uploading gui-server.sh..."
$SCP_CMD "$SCRIPT_DIR/gui-server.sh" msoldev@localhost:~/claude-gui-agent/gui-server.sh
$SSH_CMD 'chmod +x ~/claude-gui-agent/gui-server.sh'
echo "  gui-server.sh deployed and made executable"

# 4. Upload LaunchAgent plist
echo "[4/6] Installing LaunchAgent..."
$SCP_CMD "$SCRIPT_DIR/com.tamerclaw.gui-agent.plist" msoldev@localhost:~/Library/LaunchAgents/com.tamerclaw.gui-agent.plist
echo "  LaunchAgent plist installed"

# 5. Unload old agent (if running) and load new one
echo "[5/6] Loading LaunchAgent..."
$SSH_CMD 'launchctl unload ~/Library/LaunchAgents/com.tamerclaw.gui-agent.plist 2>/dev/null || true'
$SSH_CMD 'launchctl load ~/Library/LaunchAgents/com.tamerclaw.gui-agent.plist'
echo "  LaunchAgent loaded"

# 6. Verify it's running
echo "[6/6] Verifying..."
sleep 2
if $SSH_CMD 'pgrep -f gui-server.sh' >/dev/null 2>&1; then
  echo "  GUI Agent server is RUNNING"
  PID=$($SSH_CMD 'pgrep -f gui-server.sh' | head -1)
  echo "  PID: $PID"
else
  echo "  WARNING: gui-server.sh not detected via pgrep."
  echo "  This is expected if running from SSH — the LaunchAgent runs in the Aqua session."
  echo "  It will start automatically on next console login or reboot."
  echo ""
  echo "  To verify on the Mac console, run:"
  echo "    launchctl list | grep tamerclaw"
  echo "    cat /tmp/claude-compute/gui-server.log"
fi

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Quick test (from server):"
echo "  node -e \"import('./gui.js').then(g => g.screenshot().then(console.log))\""
