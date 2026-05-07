#!/usr/bin/env bash
# Build the vendored lume Swift binary into bin/lume.
# Idempotent — re-runs are no-ops if SPM has nothing to rebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LUME_SRC="$ROOT/vendor/lume"
BIN_DIR="$ROOT/bin"
OUT="$BIN_DIR/lume"

if [ ! -d "$LUME_SRC" ]; then
  echo "vendor/lume/ missing — re-vendor first (see vendor/lume.txt)" >&2
  exit 2
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "swift not on PATH — install Xcode CLT (xcode-select --install)" >&2
  exit 3
fi

mkdir -p "$BIN_DIR"

echo "==> swift build -c release in vendor/lume"
cd "$LUME_SRC"
swift build -c release

# SPM emits the binary under a triple-specific path. Probe known layouts.
BUILT=""
for cand in \
  ".build/release/lume" \
  ".build/arm64-apple-macosx/release/lume" \
  ".build/x86_64-apple-macosx/release/lume"; do
  if [ -x "$cand" ]; then
    BUILT="$cand"
    break
  fi
done

if [ -z "$BUILT" ]; then
  echo "couldn't locate built lume binary under vendor/lume/.build/" >&2
  find .build -name lume -type f 2>/dev/null >&2 || true
  exit 4
fi

cp "$BUILT" "$OUT"
chmod +x "$OUT"

# NOTE on signing: applying lume.entitlements with adhoc signing
# (codesign --sign -) is WORSE than no signing — the kernel SIGKILLs
# the binary at startup because com.apple.security.virtualization is a
# restricted entitlement requiring a real Apple Developer ID.
# Once Pete's Developer cert is configured, swap this to
#   codesign --force --options runtime \
#     --sign "Developer ID Application: <name> (<TEAMID>)" \
#     --entitlements "$LUME_SRC/resources/lume.entitlements" "$OUT"
# (and optionally bundle into a .app structure with embedded
# .provisionprofile, mirroring vendor/lume/scripts/build/build-release.sh).
# See docs/BLOCKED.md.
echo "==> wrote $OUT (adhoc-signed; VM start needs upstream entitled binary)"
ls -la "$OUT"
