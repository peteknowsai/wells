#!/usr/bin/env bash
# Build, Developer-ID sign, zip, and upload the wells release binaries.
#
# The signed engine bundle (bin/vwell.app) and the menu bar app
# (bin/WellsMenuBar.app) can't be rebuilt on an arbitrary machine —
# they need Pete's Developer ID + provisioning profile. So they ship
# as GitHub release ASSETS, and scripts/install.sh pulls them. This
# script is the producer side: run it once per release on the build
# machine.
#
# Usage:
#   scripts/package-release.sh <tag> [--no-upload]
#
#   <tag>         the release to attach assets to (must already exist —
#                 cut the tag + `gh release create` first)
#   --no-upload   build + sign + zip into dist/ but skip the upload
#                 (use to dry-run on a machine before the release exists)
#
# Env:
#   WELL_PROVISION_PROFILE   path to the .provisionprofile
#                            (default: engine/splites-lume.provisionprofile)
#   The Developer ID Application identity is auto-detected from the keychain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG=""
NO_UPLOAD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-upload) NO_UPLOAD=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $1 (try --help)" >&2; exit 1 ;;
    *) TAG="$1"; shift ;;
  esac
done

if [ -z "$TAG" ] && [ "$NO_UPLOAD" -eq 0 ]; then
  echo "usage: scripts/package-release.sh <tag> [--no-upload]" >&2
  exit 1
fi

PROFILE="${WELL_PROVISION_PROFILE:-$ROOT/engine/splites-lume.provisionprofile}"
DIST="$ROOT/dist"

# ── Preflight ─────────────────────────────────────────────────────
echo "==> preflight"
IDENTITY_LINE="$(security find-identity -p codesigning -v 2>&1 \
  | grep -E 'Developer ID Application:' | head -1)"
if [ -z "$IDENTITY_LINE" ]; then
  echo "no 'Developer ID Application' identity in keychain" >&2
  exit 1
fi
IDENTITY="$(echo "$IDENTITY_LINE" \
  | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+[A-F0-9]+[[:space:]]+"([^"]+)"/\1/')"
echo "    identity: $IDENTITY"

if [ ! -f "$PROFILE" ]; then
  echo "provisioning profile not found: $PROFILE" >&2
  echo "(set WELL_PROVISION_PROFILE to override)" >&2
  exit 1
fi
echo "    profile:  $PROFILE"

if [ "$NO_UPLOAD" -eq 0 ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh not on PATH — needed for upload (or pass --no-upload)" >&2
    exit 1
  fi
  if ! gh release view "$TAG" >/dev/null 2>&1; then
    echo "release '$TAG' doesn't exist — create it first:" >&2
    echo "  gh release create $TAG --title ... --notes ..." >&2
    exit 1
  fi
  echo "    target release: $TAG"
fi

# ── Build + sign the engine bundle ────────────────────────────────
echo "==> building bin/vwell.app (signed)"
WELL_SIGNING_IDENTITY="$IDENTITY" WELL_PROVISION_PROFILE="$PROFILE" \
  bash "$ROOT/scripts/build-vwell.sh"

# ── Build + Developer-ID re-sign the menu bar app ─────────────────
# build-menubar.sh ad-hoc signs; re-sign with the real identity +
# hardened runtime so a fresh machine doesn't get Gatekeeper friction.
# CFBundleExecutable matches the binary name here, so codesign derives
# the identifier from the bundle correctly (no entitlements needed —
# it's a plain NSStatusItem app).
echo "==> building bin/WellsMenuBar.app (Developer-ID signed)"
bash "$ROOT/scripts/build-menubar.sh"
codesign --force --options runtime --sign "$IDENTITY" "$ROOT/bin/WellsMenuBar.app"

# ── Zip both bundles ──────────────────────────────────────────────
# ditto preserves bundle structure / symlinks; plain `zip` can mangle
# .app bundles. --keepParent puts the bundle dir at the zip root.
echo "==> zipping into dist/"
rm -rf "$DIST"
mkdir -p "$DIST"
ditto -c -k --keepParent "$ROOT/bin/vwell.app" "$DIST/vwell.app.zip"
ditto -c -k --keepParent "$ROOT/bin/WellsMenuBar.app" "$DIST/WellsMenuBar.app.zip"

# ── Verify signatures ─────────────────────────────────────────────
echo "==> verifying signatures"
codesign --verify --strict "$ROOT/bin/vwell.app" \
  && echo "    vwell.app: signature ok"
codesign --verify --strict "$ROOT/bin/WellsMenuBar.app" \
  && echo "    WellsMenuBar.app: signature ok"
ls -lh "$DIST"/*.zip | awk '{print "    " $NF " (" $5 ")"}'

# ── Upload ────────────────────────────────────────────────────────
if [ "$NO_UPLOAD" -eq 1 ]; then
  echo ""
  echo "--no-upload: built + zipped into dist/, skipped the release upload."
  exit 0
fi

echo "==> uploading to release $TAG"
gh release upload "$TAG" \
  "$DIST/vwell.app.zip" \
  "$DIST/WellsMenuBar.app.zip" \
  --clobber

echo ""
echo "done — vwell.app.zip + WellsMenuBar.app.zip attached to release $TAG."
echo "scripts/install.sh will now pull them on machines without a local build."
