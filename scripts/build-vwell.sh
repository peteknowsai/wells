#!/usr/bin/env bash
# Build the vendored Swift engine into bin/vwell (wrapper) +
# bin/vwell.app (signed .app bundle). The SPM target and the inner
# binary stay named "lume" (upstream) — that name must match the
# Info.plist CFBundleExecutable, or codesign treats the binary as a
# bare Mach-O, mis-derives the signing identifier from the filename,
# and AMFI rejects the virtualization entitlement at load. Only the
# bundle dir + wrapper carry the wells-owned "vwell" name.
# Idempotent — re-runs are no-ops if SPM has nothing to rebuild.
#
# Two modes:
#
#   Signed mode (production): set WELL_SIGNING_IDENTITY and
#   WELL_PROVISION_PROFILE to produce a .app bundle codesigned with
#   a real Developer ID + the virtualization entitlement. Required for
#   `vwell serve` to start VMs (com.apple.security.virtualization is a
#   restricted entitlement that adhoc signing can't grant).
#
#   Unsigned mode (default): fast iteration; produces an adhoc-signed
#   flat binary. vwell serve starts and answers HTTP, but cannot
#   instantiate VZVirtualMachine — welld has to fall back to the
#   `lume run` subprocess path (which transparently uses upstream's
#   notarized lume.app for VM start).
#
# Env vars (signed mode):
#   WELL_SIGNING_IDENTITY  — e.g. "Developer ID Application: Pete McCarthy (46622GTWYJ)"
#   WELL_PROVISION_PROFILE — path to the .provisionprofile
#   WELL_BUNDLE_ID         — defaults to md.cells.well.engine
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LUME_SRC="$ROOT/engine/vwell-src"
BIN_DIR="$ROOT/bin"
OUT_BIN="$BIN_DIR/vwell"
APP_BUNDLE="$BIN_DIR/vwell.app"
# Wells-owned entitlements file (under engine/, our patch scope —
# NOT the vendored upstream resources under engine/vwell-src/).
# Matches the keys our Developer ID provisioning profile grants.
# Apple migrated VMNet to a new prefixed key
# (`com.apple.developer.networking.vmnet`) — upstream's
# `lume.entitlements` still uses the older `com.apple.vm.networking`
# which our newly-issued profile doesn't authorize, so the profile
# would reject at AMFI.
ENTITLEMENTS="$ROOT/engine/well-engine.entitlements"
INFO_PLIST_TEMPLATE="$LUME_SRC/resources/Info.plist"
BUNDLE_ID="${WELL_BUNDLE_ID:-md.cells.well.engine}"

if [ ! -d "$LUME_SRC" ]; then
  echo "engine/vwell-src/ missing — re-vendor first (see engine/vwell-src.txt)" >&2
  exit 2
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "swift not on PATH — install Xcode CLT (xcode-select --install)" >&2
  exit 3
fi

mkdir -p "$BIN_DIR"

# wells: lume Swift sources are owned outright in engine/vwell-src/.
# We used to keep edits as patches and apply/reverse them around the
# build; the source is wells-owned now (W.14) and we edit in place.

echo "==> swift build -c release in engine/vwell-src"
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
  echo "couldn't locate built lume binary under engine/vwell-src/.build/" >&2
  find .build -name lume -type f 2>/dev/null >&2 || true
  exit 4
fi

# Branch: signed vs adhoc.
if [ -n "${WELL_SIGNING_IDENTITY:-}" ] && [ -n "${WELL_PROVISION_PROFILE:-}" ]; then
  echo "==> signed build mode (identity: $WELL_SIGNING_IDENTITY)"

  if [ ! -f "$WELL_PROVISION_PROFILE" ]; then
    echo "WELL_PROVISION_PROFILE points at non-existent file: $WELL_PROVISION_PROFILE" >&2
    exit 5
  fi
  if [ ! -f "$ENTITLEMENTS" ]; then
    echo "missing entitlements file: $ENTITLEMENTS" >&2
    exit 6
  fi

  # Assemble .app bundle. Mirrors engine/vwell-src/scripts/build/build-release.sh.
  rm -rf "$APP_BUNDLE"
  mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
  cp "$BUILT" "$APP_BUNDLE/Contents/MacOS/lume"
  chmod +x "$APP_BUNDLE/Contents/MacOS/lume"

  # SPM-built resource bundle (lume_lume.bundle) carries CLI templates and
  # similar non-code assets. Copy if present.
  if [ -d ".build/release/lume_lume.bundle" ]; then
    cp -rf ".build/release/lume_lume.bundle" "$APP_BUNDLE/Contents/Resources/"
  fi

  # Info.plist — substitute version + bundle ID.
  VERSION="$(cat VERSION 2>/dev/null || echo "0.0.0")"
  sed \
    -e "s/__VERSION__/$VERSION/g" \
    -e "s|com.trycua.lume|$BUNDLE_ID|g" \
    "$INFO_PLIST_TEMPLATE" > "$APP_BUNDLE/Contents/Info.plist"

  # Embed the provisioning profile. macOS pulls entitlement authorizations
  # from this file at load time.
  cp "$WELL_PROVISION_PROFILE" "$APP_BUNDLE/Contents/embedded.provisionprofile"

  echo "==> codesign binary (with hardened runtime + entitlements)"
  codesign --force --options runtime \
    --sign "$WELL_SIGNING_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$APP_BUNDLE/Contents/MacOS/lume"

  echo "==> codesign bundle"
  codesign --force --sign "$WELL_SIGNING_IDENTITY" "$APP_BUNDLE"

  # The bundle codesign with --force re-signs nested code (including the
  # main binary) and STRIPS entitlements — `codesign -d --entitlements -`
  # confirms this on Developer ID + hardened runtime builds. Re-sign the
  # binary one more time so the entitlements stick. Without this,
  # com.apple.security.virtualization is missing and AMFI rejects every
  # VZVirtualMachine instantiation at load time.
  echo "==> re-codesign binary (restore entitlements after bundle sign)"
  codesign --force --options runtime \
    --sign "$WELL_SIGNING_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$APP_BUNDLE/Contents/MacOS/lume"

  # bin/vwell becomes a wrapper that execs the bundled binary, so existing
  # callers (engine/lumeProcess.ts spawns "$BIN_DIR/vwell serve") still work.
  cat > "$OUT_BIN" <<WRAPPER_EOF
#!/bin/sh
exec "$APP_BUNDLE/Contents/MacOS/lume" "\$@"
WRAPPER_EOF
  chmod +x "$OUT_BIN"

  echo "==> wrote $APP_BUNDLE + $OUT_BIN wrapper"
  codesign -d --entitlements - "$APP_BUNDLE/Contents/MacOS/lume" 2>&1 | grep -E "(virtualization|networking)" || true
else
  # Adhoc / unsigned fallback. lume serve runs but can't start VMs —
  # the daemon falls back to `lume run` subprocess which uses the
  # entitled upstream binary.
  echo "==> unsigned (adhoc) build"
  echo "    (export WELL_SIGNING_IDENTITY + WELL_PROVISION_PROFILE to enable VM start via lume serve)"
  rm -rf "$APP_BUNDLE"
  cp "$BUILT" "$OUT_BIN"
  chmod +x "$OUT_BIN"
fi

ls -la "$OUT_BIN"
