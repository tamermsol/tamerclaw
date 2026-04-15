#!/bin/bash
# -----------------------------------------------------------
# GUI Access Setup Script for Mac Mini
# Run this ON the Mac Mini to install dependencies and
# configure permissions for remote GUI control by agents.
# -----------------------------------------------------------

set -e

echo "Setting up GUI access for TamerClaw agents..."
echo ""

# --- 1. Install cliclick (mouse/keyboard automation) --------
echo "1/5  Installing cliclick..."
if command -v cliclick &>/dev/null; then
  echo "  cliclick already installed: $(which cliclick)"
else
  brew install cliclick
  echo "  cliclick installed"
fi

# --- 2. Install tesseract (OCR) ----------------------------
echo "2/5  Installing tesseract (OCR)..."
if command -v tesseract &>/dev/null; then
  echo "  tesseract already installed: $(which tesseract)"
else
  brew install tesseract
  echo "  tesseract installed"
fi

# --- 3. Create working directories -------------------------
echo "3/5  Creating working directories..."
mkdir -p /tmp/claude-compute/gui
echo "  /tmp/claude-compute/gui created"

# --- 4. Check macOS permissions -----------------------------
echo "4/5  Checking macOS permissions..."
echo ""
echo "  MANUAL STEPS REQUIRED:"
echo "  You need to grant these permissions in System Settings -> Privacy & Security:"
echo ""
echo "  Accessibility:"
echo "     System Settings -> Privacy & Security -> Accessibility"
echo "     -> Add Terminal (or iTerm/your SSH terminal)"
echo "     -> Add sshd-keygen-wrapper (/usr/libexec/sshd-keygen-wrapper)"
echo ""
echo "  Screen Recording:"
echo "     System Settings -> Privacy & Security -> Screen Recording"
echo "     -> Add Terminal (or iTerm/your SSH terminal)"
echo "     -> Add sshd-keygen-wrapper"
echo ""
echo "  Automation:"
echo "     System Settings -> Privacy & Security -> Automation"
echo "     -> Allow Terminal to control System Events, Finder, etc."
echo ""

# --- 5. Test everything ------------------------------------
echo "5/5  Running tests..."
echo ""

# Test screencapture
if screencapture -x /tmp/claude-compute/gui/test-setup.png 2>/dev/null; then
  echo "  Screen capture works"
  rm -f /tmp/claude-compute/gui/test-setup.png
else
  echo "  Screen capture failed — grant Screen Recording permission"
fi

# Test osascript
if osascript -e 'return "ok"' &>/dev/null; then
  echo "  osascript works"
else
  echo "  osascript failed"
fi

# Test cliclick
if cliclick p &>/dev/null; then
  echo "  cliclick works (mouse position: $(cliclick p))"
else
  echo "  cliclick failed — grant Accessibility permission"
fi

# Test Accessibility API
if osascript -e 'tell application "System Events" to get name of first application process' &>/dev/null; then
  echo "  Accessibility API works"
else
  echo "  Accessibility API failed — grant Accessibility permission to Terminal/sshd"
fi

# Test tesseract
if command -v tesseract &>/dev/null; then
  echo "  tesseract available: $(tesseract --version 2>&1 | head -1)"
else
  echo "  tesseract not installed (OCR won't work)"
fi

echo ""
echo "==========================================="
echo "  Setup complete!"
echo ""
echo "  Next: Grant the permissions listed above"
echo "  in System Settings, then re-run this to"
echo "  verify everything works."
echo "==========================================="
