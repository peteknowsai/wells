#!/usr/bin/env bash
# One-shot helper: rebuild bin/lume.app with real Apple Developer
# signing once Pete has the cert + provisioning profile in place.
# Idempotent — re-run after lume changes.
#
# Usage:
#   scripts/activate-signing.sh ~/Downloads/splites-lume.provisionprofile
#
# What it does:
#   1. Verifies the cert exists in keychain
#   2. Stages the provisioning profile in vendor/lume.patches/
#      (gitignored — never committed)
#   3. Re-runs scripts/build-lume.sh in signed mode
#   4. Restarts splited so it picks up the bundled lume.app
#   5. Smoke-tests: starts pete via HTTP /run, asserts running state
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_SRC="${1:-}"

if [ -z "$PROFILE_SRC" ]; then
  echo "usage: $0 <path-to-.provisionprofile>" >&2
  exit 1
fi
if [ ! -f "$PROFILE_SRC" ]; then
  echo "no such file: $PROFILE_SRC" >&2
  exit 2
fi

# Stash profile in a stable, gitignored location.
STASH_DIR="$ROOT/vendor/lume.patches"
mkdir -p "$STASH_DIR"
PROFILE_DEST="$STASH_DIR/splites-lume.provisionprofile"
cp "$PROFILE_SRC" "$PROFILE_DEST"
chmod 0600 "$PROFILE_DEST"
echo "==> staged profile at $PROFILE_DEST"

# Verify Developer ID Application cert in keychain. Match by team prefix
# so we don't hard-code a name change.
IDENTITY_LINE=$(security find-identity -p codesigning -v 2>&1 \
  | grep -E "Developer ID Application:" \
  | head -1)
if [ -z "$IDENTITY_LINE" ]; then
  echo "no 'Developer ID Application' cert found in keychain" >&2
  echo "  (run security find-identity -p codesigning -v to inspect)" >&2
  exit 3
fi
# Lines look like: '  1) <hash> "Developer ID Application: Pete McCarthy (46622GTWYJ)"'
IDENTITY=$(echo "$IDENTITY_LINE" | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+[A-F0-9]+[[:space:]]+"([^"]+)"/\1/')
echo "==> using identity: $IDENTITY"

# Run the build with signing on.
SPLITES_SIGNING_IDENTITY="$IDENTITY" \
SPLITES_PROVISION_PROFILE="$PROFILE_DEST" \
  "$ROOT/scripts/build-lume.sh"

echo
echo "==> signed bin/lume.app entitlements:"
codesign -d --entitlements - "$ROOT/bin/lume.app/Contents/MacOS/lume" 2>&1 | grep -A1 -E "(virtualization|networking)" || true

echo
echo "==> restart splited (this is what loads the new binary)"
pkill -9 -f "bun run.*splited" 2>/dev/null || true
pkill -9 -f "lume serve" 2>/dev/null || true
sleep 1
> /tmp/splited.log
> /tmp/lume-serve.log
SPLITES_PUBLIC_BASE=splites.cells.md \
  bun run "$ROOT/daemon/splited.ts" > /tmp/splited.log 2>&1 &
sleep 4

echo "=== procs ==="
ps aux | grep -E "(splited\.ts|lume serve)" | grep -v grep | awk '{print $2, $11, $12, $13, $14}'

echo
echo "=== healthz ==="
curl -s http://127.0.0.1:7878/healthz -w " HTTP %{http_code}\n"

echo
echo "=== smoke: stop pete (clean slate) → start via HTTP /run → expect running ==="
TOKEN=$(cat ~/.splites/token)
curl -s -X POST http://127.0.0.1:7878/v1/splites/pete/stop \
  -H "Authorization: Bearer $TOKEN" >/dev/null
sleep 2

curl -sS -X POST -H "Content-Type: application/json" -d '{"noDisplay":true}' \
  http://127.0.0.1:7777/lume/vms/pete/run -w "\n  HTTP %{http_code}\n"

echo "=== watch 60s for running state ==="
for i in $(seq 1 12); do
  sleep 5
  STATE=$(curl -s http://127.0.0.1:7777/lume/vms/pete | jq -r '.status // "?"')
  IP=$(curl -s http://127.0.0.1:7777/lume/vms/pete | jq -r '.ipAddress // "null"')
  echo "  T+${i}*5s: status=$STATE ip=$IP"
  if [ "$STATE" = "running" ] && [ "$IP" != "null" ]; then
    echo
    echo "==> SUCCESS: lume serve started pete via HTTP. Hot tier is now wirable."
    exit 0
  fi
done

echo
echo "==> pete failed to start. Check /tmp/lume-serve.log for the actual error." >&2
echo "    (entitlement mismatch, profile not authorizing, etc.)" >&2
tail -20 /tmp/lume-serve.log >&2
exit 4
