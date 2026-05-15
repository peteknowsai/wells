#!/usr/bin/env bash
# Install the host-forwarder as a per-user LaunchAgent. The forwarder
# bridges Mac loopback ports to a dashboard cell over vmnet — needed
# because cloudflared running under launchd is blocked by macOS Local
# Network gating from reaching 192.168.64.x directly.
#
# Opt-in: not wired into scripts/install.sh because it's dashboard-
# specific infrastructure, not wells substrate. Run it on the host
# where the wells dashboard is published behind a Cloudflare tunnel.
#
# Edit scripts/host-forwarder.ts to point at the right cell IP/ports
# before installing.
#
# Idempotent: re-running boots out the existing agent and reinstalls.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/scripts/host-forwarder.plist.template"
PLIST="$HOME/Library/LaunchAgents/md.cells.welld.host-forwarder.plist"
LABEL="md.cells.welld.host-forwarder"

if [ ! -f "$TEMPLATE" ]; then
  echo "missing $TEMPLATE" >&2
  exit 1
fi

BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
  echo "bun not on PATH — install bun first (curl -fsSL https://bun.sh/install | bash)" >&2
  exit 2
fi
BUN_DIR="$(dirname "$BUN_PATH")"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.wells/logs"

sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PROJECT_ROOT__|$ROOT|g" \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__BUN_DIR__|$BUN_DIR|g" \
  "$TEMPLATE" > "$PLIST"

echo "==> wrote $PLIST"

if launchctl list | grep -q "$LABEL"; then
  echo "==> booting out existing $LABEL"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi

echo "==> bootstrapping $LABEL"
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 1
if launchctl list | grep -q "$LABEL"; then
  echo "==> host-forwarder is up. Log: $HOME/.wells/logs/host-forwarder.log"
else
  echo "==> host-forwarder didn't start — check $HOME/.wells/logs/host-forwarder.err" >&2
  exit 3
fi
