#!/usr/bin/env bash
# Stable welld launcher — meant to run from a worktree pinned to a
# wells-stable-* tag. The cells team's integration target.
#
# Setup (one-time):
#   git worktree add ~/Projects/splites-stable wells-stable-YYYY-MM-DD
#   cp -R bin/lume bin/lume.app ~/Projects/splites-stable/bin/  # or rebuild
#   ~/Projects/splites-stable/scripts/run-welld-stable.sh
set -e
export WELL_PORT=7878
export WELL_STATE_DIR="$HOME/.wells"
export WELL_LUME_PORT=7777
export WELL_LOG_FILE="$HOME/.wells/welld.log"
# WELL_PUBLIC_BASE — defaults to `wells.cells.md` (Pattern A) so the
# out-of-box install works for cells's CF Worker dispatch. Override
# by setting WELL_PUBLIC_BASE in the env before launching. Common
# overrides:
#   WELL_PUBLIC_BASE=cells.md           # Pattern B (direct, no infix)
#   WELL_PUBLIC_BASE=<your-domain>      # operator's own domain
#   WELL_PUBLIC_BASE= ./run-welld-...   # explicit empty → em-dash sentinel
export WELL_PUBLIC_BASE="${WELL_PUBLIC_BASE-wells.cells.md}"
cd "$(dirname "$0")/.."
exec bun run daemon/welld.ts
