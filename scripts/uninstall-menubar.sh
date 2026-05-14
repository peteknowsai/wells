#!/usr/bin/env bash
# Stop the Wells menu bar LaunchAgent and remove its plist. Inverse of
# scripts/install-menubar.sh. Idempotent — fine to run when nothing is
# installed. Does not delete the built app at bin/WellsMenuBar.app.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/md.cells.welld.menubar.plist"
LABEL="md.cells.welld.menubar"

if launchctl list | grep -q "$LABEL"; then
  echo "==> stopping $LABEL"
  if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
    :
  else
    launchctl unload "$PLIST" 2>/dev/null || true
  fi
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "==> removed $PLIST"
fi

echo "Wells menu bar is no longer managed by launchd."
echo "(The built app at bin/WellsMenuBar.app is kept; 'open' it any time.)"
