#!/usr/bin/env bash
# One-shot helper: rebuild bin/vwell.app with real Apple Developer
# signing once Pete has the cert + provisioning profile in place.
# Idempotent — re-run after lume changes.
#
# Usage:
#   scripts/activate-signing.sh ~/Downloads/wells-lume.provisionprofile
#
# What it does:
#   1. Verifies the cert exists in keychain
#   2. Stages the provisioning profile in engine/ (gitignored —
#      never committed; matches the .gitignore pattern engine/*.provisionprofile)
#   3. Re-runs scripts/build-vwell.sh in signed mode
#   4. Restarts welld so it picks up the bundled vwell.app
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
STASH_DIR="$ROOT/engine"
mkdir -p "$STASH_DIR"
PROFILE_DEST="$STASH_DIR/wells-lume.provisionprofile"
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
WELL_SIGNING_IDENTITY="$IDENTITY" \
WELL_PROVISION_PROFILE="$PROFILE_DEST" \
  "$ROOT/scripts/build-vwell.sh"

echo
echo "==> signed bin/vwell.app entitlements:"
codesign -d --entitlements - "$ROOT/bin/vwell.app/Contents/MacOS/lume" 2>&1 | grep -A1 -E "(virtualization|networking)" || true

echo
echo "==> restart welld (this is what loads the new binary)"
pkill -9 -f "bun run.*welld" 2>/dev/null || true
pkill -9 -f "lume serve" 2>/dev/null || true
sleep 1
> /tmp/welld.log
> /tmp/lume-serve.log
WELL_PUBLIC_BASE=wells.cells.md \
  bun run "$ROOT/daemon/welld.ts" > /tmp/welld.log 2>&1 &
sleep 4

echo "=== procs ==="
ps aux | grep -E "(welld\.ts|lume serve)" | grep -v grep | awk '{print $2, $11, $12, $13, $14}'

echo
echo "=== healthz ==="
curl -s http://127.0.0.1:7878/healthz -w " HTTP %{http_code}\n"

echo
echo "=== smoke: stop pete (clean slate) → start via HTTP /run → expect running ==="
TOKEN=$(cat ~/.wells/token)
curl -s -X POST http://127.0.0.1:7878/v1/wells/pete/stop \
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
