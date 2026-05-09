#!/usr/bin/env bash
# Dev welld — my experimental playground. Insulated from stable so cells
# team's verified service stays put while I iterate on optimizations.
set -e
export WELL_PORT=7879
export WELL_STATE_DIR="$HOME/.wells-dev"
export WELL_LUME_PORT=7780
# Note: lume bundles share `~/.lume/` between stable and dev. Lume's
# settings file is global and adding multi-location complicates a
# bundle-creation race (lume's POST returns before bundle dir is on
# disk; wells's clonefile then needs that dir). Workaround: use unique
# `dev-*` prefixes in this welld's well names so they don't collide.
export WELL_LOG_FILE="$HOME/.wells-dev/welld.log"
# WELL_PUBLIC_BASE — same default as stable. Override via env if
# testing a different domain shape.
export WELL_PUBLIC_BASE="${WELL_PUBLIC_BASE-wells.cells.md}"
cd "$(dirname "$0")/.."
exec bun run daemon/welld.ts
