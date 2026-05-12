#!/usr/bin/env bash
# Flush macOS bootpd's vmnet DHCP lease table.
#
# Cells team 2026-05-11: failed bakes / aborted well-creates leak
# entries into /var/db/dhcpd_leases. vmnet's bootpd never GCs, so
# the IP pool eventually fills and new wells time out at the DHCP
# step. /healthz surfaces the orphan count; this script actually
# flushes.
#
# WARNING: this nukes EVERY lease, including legit running wells.
# Stop running wells before flushing (or accept brief DHCP renewal
# churn). Idempotent: re-running just zeroes an empty file.
#
# Requires sudo. The file is `root:wheel` 0644 — welld (running as
# pete) can read but not write, so this can't ship inside the daemon
# without a privilege model decision (A.3-egress style). For now
# this is the documented manual flush.

set -euo pipefail

LEASES_FILE="/var/db/dhcpd_leases"

if [ ! -f "$LEASES_FILE" ]; then
  echo "No lease file at $LEASES_FILE — nothing to flush."
  exit 0
fi

# Check what's running. Best-effort — if welld isn't reachable,
# proceed anyway (operator's job to know).
RUNNING_COUNT=0
if [ -f "$HOME/.wells/token" ]; then
  RUNNING_COUNT=$(curl -fsS -H "Authorization: Bearer $(cat ~/.wells/token)" \
      http://127.0.0.1:7878/v1/wells 2>/dev/null \
    | python3 -c 'import json,sys; print(sum(1 for w in json.load(sys.stdin).get("wells", []) if w.get("status") == "running"))' 2>/dev/null \
    || echo 0)
fi

LEASE_COUNT=$(grep -c '^{' "$LEASES_FILE" 2>/dev/null || echo 0)

echo "Current state:"
echo "  $LEASE_COUNT lease entries in $LEASES_FILE"
echo "  $RUNNING_COUNT wells currently running (per welld)"
echo ""

if [ "$RUNNING_COUNT" -gt 0 ]; then
  echo "WARNING: $RUNNING_COUNT well(s) currently running. Flushing will"
  echo "force them to renew their DHCP leases on the next packet — usually"
  echo "harmless (vmnet's bootpd will re-issue the same IP) but in rare"
  echo "cases the running cell briefly loses network."
  echo ""
fi

read -r -p "Proceed with flush? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

echo "Flushing $LEASES_FILE..."
sudo bash -c "> $LEASES_FILE"

echo "Restarting bootpd to drop in-memory lease state..."
sudo launchctl kickstart -k system/com.apple.bootpd 2>/dev/null || true

echo "Done. New leases will be issued on the next DHCPDISCOVER."
echo ""
echo "Verify with: curl -s -H \"Authorization: Bearer \$(cat ~/.wells/token)\" \\"
echo "  http://127.0.0.1:7878/healthz | python3 -m json.tool | grep -A 3 vmnet_leases"
