#!/usr/bin/env bash
# Dev welld — my experimental playground. Insulated from stable so cells
# team's verified service stays put while I iterate on optimizations.
set -e
export WELL_PORT=7879
export WELL_STATE_DIR="$HOME/.wells-dev"
export WELL_LUME_PORT=7780
export WELL_LOG_FILE="$HOME/.wells-dev/welld.log"
cd "$(dirname "$0")/.."
exec bun run daemon/welld.ts
