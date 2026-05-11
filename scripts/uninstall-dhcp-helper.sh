#!/usr/bin/env bash
# Uninstall welld-dhcp-helper. Reverses scripts/install-dhcp-helper.sh.

set -euo pipefail

HELPER_DST="/usr/local/sbin/welld-dhcp-helper"
SUDOERS_FILE="/etc/sudoers.d/welld-dhcp"

if [ "$(id -u)" = "0" ]; then
  echo "Don't run as root — sudo is invoked internally." >&2
  exit 1
fi

if [ -f "$SUDOERS_FILE" ]; then
  sudo rm "$SUDOERS_FILE"
  echo "✓ removed $SUDOERS_FILE"
fi

if [ -f "$HELPER_DST" ]; then
  sudo rm "$HELPER_DST"
  echo "✓ removed $HELPER_DST"
fi

echo ""
echo "Uninstall complete. Welld will fall back to log-only behavior on destroy"
echo "(can't release leases without the helper) — install again to restore."
