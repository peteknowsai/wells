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
# Pattern A (current default per docs/cells-integration.md): cells's CF
# Worker bridges `<name>.cells.md` → `<name>.wells.cells.md`. Welld's
# /v1/wells/<n> response uses this to populate the URL field, which
# cells-side `deploy-cell-worker.sh` parses out of `well info` output.
# Without it, URL renders as em-dash ("—") — a confusing-but-explicit
# "unset" sentinel that's blown up cells's awk-pipeline at least once.
export WELL_PUBLIC_BASE="${WELL_PUBLIC_BASE:-wells.cells.md}"
cd "$(dirname "$0")/.."
exec bun run daemon/welld.ts
