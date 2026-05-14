#!/usr/bin/env bash
# Install the Wells menu bar app as a per-user macOS LaunchAgent so it
# auto-starts on login alongside welld. Builds the app first if it's
# missing. Uses scripts/menubar.plist.template.
#
# Idempotent: re-running unloads the existing agent and reinstalls.
#
# Usage:
#   scripts/install-menubar.sh
#
# Uninstall:
#   scripts/uninstall-menubar.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/scripts/menubar.plist.template"
PLIST="$HOME/Library/LaunchAgents/md.cells.welld.menubar.plist"
LABEL="md.cells.welld.menubar"
APP="$ROOT/bin/WellsMenuBar.app"

if [ ! -f "$TEMPLATE" ]; then
  echo "missing $TEMPLATE" >&2
  exit 1
fi

# Build the app if it isn't there yet (bin/ is gitignored).
if [ ! -d "$APP" ]; then
  echo "==> $APP missing — building it"
  "$ROOT/scripts/build-menubar.sh"
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/.wells"

# Render template. Use sed with | as delimiter since paths contain /.
sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PROJECT_ROOT__|$ROOT|g" \
  "$TEMPLATE" > "$PLIST"

echo "==> wrote $PLIST"

# Unload first if already loaded — idempotent reinstall.
if launchctl list | grep -q "$LABEL"; then
  echo "==> unloading existing $LABEL"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
fi

echo "==> bootstrapping $LABEL"
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  :
else
  launchctl load "$PLIST"
fi

echo ""
echo "Wells menu bar is now managed by launchd — it auto-starts on login"
echo "and restarts on crash. A clean Quit from its menu stays quit."
echo "Stop:    scripts/uninstall-menubar.sh"
echo "Restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
