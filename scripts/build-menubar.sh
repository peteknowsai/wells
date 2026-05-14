#!/usr/bin/env bash
# Build the Wells menu bar app — a tiny NSStatusItem utility that shows
# welld's health in the macOS menu bar and offers a one-click restart.
#
# Compiles menubar/WellsMenuBar.swift and assembles an ad-hoc-signed .app
# bundle at bin/WellsMenuBar.app (gitignored — a regenerable build artifact,
# same as bin/vwell and bin/lume.app).
#
# Usage:
#   scripts/build-menubar.sh
#
# Run it:
#   open bin/WellsMenuBar.app
# Auto-start on login:
#   scripts/install-menubar.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/menubar/WellsMenuBar.swift"
APP="$ROOT/bin/WellsMenuBar.app"
MACOS_DIR="$APP/Contents/MacOS"
BIN="$MACOS_DIR/WellsMenuBar"

if [ ! -f "$SRC" ]; then
  echo "missing $SRC" >&2
  exit 1
fi

echo "==> compiling $SRC"
rm -rf "$APP"
mkdir -p "$MACOS_DIR"

# -swift-version 5: this is a small single-file utility and all UI work is
# correctly main-thread; Swift 5 mode keeps the build free of strict-
# concurrency churn without changing behavior.
swiftc -O -swift-version 5 -o "$BIN" "$SRC"

echo "==> writing Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>md.cells.well.menubar</string>
    <key>CFBundleExecutable</key>
    <string>WellsMenuBar</string>
    <key>CFBundleName</key>
    <string>Wells Menu Bar</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

echo "==> ad-hoc codesigning"
codesign --force --sign - "$APP"

echo ""
echo "built: $APP"
echo "run:   open \"$APP\""
echo "login: scripts/install-menubar.sh"
