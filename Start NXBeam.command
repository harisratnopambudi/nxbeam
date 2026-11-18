#!/bin/bash
# NXBeam for macOS: double-click to start (the first time: right-click > Open).
cd "$(dirname "$0")" || exit 1
# a downloaded zip marks every file as quarantined, which stops node, ffmpeg
# and the USB module from running: clear the mark for this folder once
xattr -dr com.apple.quarantine . 2>/dev/null
# NXBEAM_LAUNCHER=2: this launcher applies an online update (exit code 75)
export NXBEAM_LAUNCHER=2
main() {
  while :; do
    if [ -x runtime/node ] || [ -f runtime/node.next ]; then
      if [ -f runtime/node.next ]; then mv -f runtime/node.next runtime/node; chmod +x runtime/node; fi
      NODE=./runtime/node
    else
      if ! command -v node >/dev/null 2>&1; then
        echo "Node.js 18+ is required: https://nodejs.org"
        read -n 1 -s -r -p "Press any key to close"
        exit 1
      fi
      if ! cmp -s package.json node_modules/.nxbeam-package.json; then
        npm install --omit=dev --no-fund --no-audit --loglevel=error && cp package.json node_modules/.nxbeam-package.json
      fi
      NODE=node
    fi
    "$NODE" src/index.js "$@"
    code=$?
    if [ "$code" -eq 75 ]; then "$NODE" tools/apply-update.js; xattr -dr com.apple.quarantine . 2>/dev/null; continue; fi
    exit "$code"
  done
}
main "$@"
