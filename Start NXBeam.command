#!/bin/bash
# NXBeam for macOS: double-click to start (the first time: right-click > Open).
cd "$(dirname "$0")" || exit 1
# a downloaded zip marks every file as quarantined, which stops node, ffmpeg
# and the USB module from running: clear the mark for this folder once
xattr -dr com.apple.quarantine . 2>/dev/null
if [ -x runtime/node ]; then
  exec ./runtime/node src/index.js "$@"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close"
  exit 1
fi
if ! cmp -s package.json node_modules/.nxbeam-package.json; then
  npm install --omit=dev --no-fund --no-audit --loglevel=error && cp package.json node_modules/.nxbeam-package.json
fi
exec node src/index.js "$@"
