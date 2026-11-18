#!/usr/bin/env sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }
# NXBEAM_LAUNCHER=2: this launcher applies an online update (exit code 75)
export NXBEAM_LAUNCHER=2
main() {
  while :; do
    # install dependencies only the first time or after NXBeam was updated
    if ! cmp -s package.json node_modules/.nxbeam-package.json; then
      echo "Installing dependencies (once)..."
      npm install --omit=dev --no-fund --no-audit --loglevel=error && cp package.json node_modules/.nxbeam-package.json
    fi
    node src/index.js "$@"
    code=$?
    if [ "$code" -eq 75 ]; then node tools/apply-update.js; continue; fi
    exit "$code"
  done
}
main "$@"
