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
cd "$(dirname "$0")/.."
exec bun run daemon/welld.ts
