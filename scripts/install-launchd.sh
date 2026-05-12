#!/usr/bin/env bash
# Install welld as a per-user macOS LaunchAgent so it auto-starts on
# login, survives terminal close, and gets restarted on crash. Uses
# scripts/welld.plist.template; substitutes the user's paths before
# dropping it into ~/Library/LaunchAgents/.
#
# Idempotent: re-running unloads the existing agent and reinstalls.
#
# Usage:
#   scripts/install-launchd.sh
#
# Optional env:
#   WELL_PUBLIC_BASE — domain for the proxy (e.g. "wells.cells.md").
#                       Pulled from the current shell if set; otherwise
#                       written as empty and welld runs without proxy.
#
# Uninstall:
#   scripts/uninstall-launchd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/scripts/welld.plist.template"
PLIST="$HOME/Library/LaunchAgents/md.cells.welld.plist"
LABEL="md.cells.welld"

if [ ! -f "$TEMPLATE" ]; then
  echo "missing $TEMPLATE" >&2
  exit 1
fi

# Find bun. Refuse to install if it's not on PATH — the plist's
# ProgramArguments needs an absolute path because launchd doesn't
# inherit the user's interactive PATH.
BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
  echo "bun not on PATH — install bun first (curl -fsSL https://bun.sh/install | bash)" >&2
  exit 2
fi
BUN_DIR="$(dirname "$BUN_PATH")"

# WELL_PUBLIC_BASE is optional. Empty means proxy not configured.
PUBLIC_BASE="${WELL_PUBLIC_BASE:-}"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/.wells"

# Render template. Use sed with | as delimiter since paths contain /.
sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PROJECT_ROOT__|$ROOT|g" \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__BUN_DIR__|$BUN_DIR|g" \
  -e "s|__WELL_PUBLIC_BASE__|$PUBLIC_BASE|g" \
  "$TEMPLATE" > "$PLIST"

echo "==> wrote $PLIST"

# Unload first if already loaded — idempotent reinstall.
if launchctl list | grep -q "$LABEL"; then
  echo "==> unloading existing $LABEL"
  launchctl unload "$PLIST" 2>/dev/null || true
fi

echo "==> bootstrapping $LABEL"
# Use bootstrap (modern) instead of load (deprecated). Falls back to
# load on older macOS where bootstrap isn't available.
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  :
else
  launchctl load "$PLIST"
fi

# Give welld a couple seconds to start, then health-check.
sleep 3

if curl -sS --max-time 3 http://127.0.0.1:7878/healthz >/dev/null 2>&1; then
  echo "==> welld is up: $(curl -sS http://127.0.0.1:7878/healthz)"
else
  echo "==> welld didn't respond on /healthz within 3s — check $HOME/.wells/welld.log" >&2
  tail -20 "$HOME/.wells/welld.log" 2>/dev/null >&2
  exit 3
fi

echo ""
echo "welld is now managed by launchd. It will auto-restart on crash"
echo "and auto-start at login. Logs: $HOME/.wells/welld.log"
echo "Stop:    launchctl bootout gui/$(id -u)/$LABEL  (or: scripts/uninstall-launchd.sh)"
echo "Restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
