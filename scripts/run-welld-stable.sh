#!/usr/bin/env bash
# Stable welld launcher — meant to run from a worktree pinned to a
# wells-stable-* tag. The cells team's integration target.
#
# Setup (one-time):
#   git worktree add ~/Projects/wells-stable wells-stable-YYYY-MM-DD
#   cp -R bin/vwell bin/vwell.app ~/Projects/wells-stable/bin/  # or rebuild
#   ~/Projects/wells-stable/scripts/run-welld-stable.sh
set -e
export WELL_PORT=7878
export WELL_STATE_DIR="$HOME/.wells"
export WELL_LUME_PORT=7777
export WELL_LOG_FILE="$HOME/.wells/welld.log"
# WELL_PUBLIC_BASE — defaults to `cells.md` (Pattern B, depth-1) so the
# out-of-box install works under Cloudflare Universal SSL without paying
# for Advanced Certificate Manager ($10/mo per zone for depth-2 wildcards).
# Override by setting WELL_PUBLIC_BASE in the env before launching:
#   WELL_PUBLIC_BASE=wells.cells.md     # Pattern A (depth-2; requires ACM)
#   WELL_PUBLIC_BASE=<your-domain>      # operator's own domain
#   WELL_PUBLIC_BASE= ./run-welld-...   # explicit empty → em-dash sentinel
export WELL_PUBLIC_BASE="${WELL_PUBLIC_BASE-cells.md}"
cd "$(dirname "$0")/.."
exec bun run daemon/welld.ts
