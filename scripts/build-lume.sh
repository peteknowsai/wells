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
echo "==> wrote $OUT"
ls -la "$OUT"
