#!/usr/bin/env bash
# Stop welld's LaunchAgent and remove the plist. Inverse of
# scripts/install-launchd.sh. Idempotent — fine to run when nothing
# is installed.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/md.cells.welld.plist"
LABEL="md.cells.welld"

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

echo "welld is no longer managed by launchd. (Logs at ~/.wells/welld.log are kept.)"
