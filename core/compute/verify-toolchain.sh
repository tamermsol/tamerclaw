#!/bin/bash
# Verify Mac Mini compute toolchain — run from server
# Usage: bash verify-toolchain.sh

SSH_CMD="ssh -o ConnectTimeout=10 -o BatchMode=yes -p 2222 msoldev@localhost"
PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  result=$($SSH_CMD "export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:~/flutter/bin:\$PATH && $cmd" 2>&1)
  if [ $? -eq 0 ]; then
    echo "PASS $name: $result"
    ((PASS++))
  else
    echo "FAIL $name: FAILED"
    ((FAIL++))
  fi
}

echo "Mac Mini Compute -- Toolchain Verification"
echo "================================================"

# Connectivity
$SSH_CMD "echo online" > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "PASS SSH Connection: online"
  ((PASS++))
else
  echo "FAIL SSH Connection: OFFLINE"
  echo "Mac Mini is not reachable. Check reverse SSH tunnel."
  exit 1
fi

check "Node.js" "node --version"
check "NPM" "npm --version"
check "Flutter" "flutter --version 2>/dev/null | head -1"
check "Dart" "dart --version 2>/dev/null"
check "FFmpeg" "ffmpeg -version 2>/dev/null | head -1"
check "ImageMagick" "magick --version 2>/dev/null | head -1"
check "Whisper" "source ~/compute-env/bin/activate && python3 -c 'import whisper; print(whisper.__version__)'"
check "Xcode" "xcodebuild -version 2>/dev/null | head -1"
check "CocoaPods" "pod --version"
check "Python3" "python3 --version"

echo ""
echo "================================================"
echo "Results: $PASS passed, $FAIL failed"
echo "Disk: $($SSH_CMD 'df -h / | tail -1 | awk "{print \$4 \" free of \" \$2}"' 2>/dev/null)"
