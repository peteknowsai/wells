#!/bin/bash
# Pete Loop — Stop hook for splites/wells.
#
# Fires when Claude Code's turn ends. If `.claude/.pete-loop.active` exists,
# re-injects the worker prompt to start the next iteration. Counter in the
# flag file caps runaway loops at MAX_ITER fires per /start-pete-loop call.
#
# Lifecycle:
#   /start-pete-loop  → writes "0" to the flag file + runs first worker fire
#   each turn ends    → this hook reads count, increments, re-injects worker
#   MAX_ITER reached  → hook removes flag + lets stop proceed with a notice
#   /stop-pete-loop   → removes flag manually
#
# IMPORTANT: PROJECT_ROOT must be an absolute path. Hooks run with no
# guaranteed cwd, so relative paths break the loop silently.

set -e

PROJECT_ROOT="/Users/pete/Projects/splites"
FLAG_FILE="$PROJECT_ROOT/.claude/.pete-loop.active"
MAX_ITER=200

# Loop not active — let the stop proceed normally.
if [ ! -f "$FLAG_FILE" ]; then
  exit 0
fi

# Read and increment iteration count.
COUNT=$(head -1 "$FLAG_FILE" 2>/dev/null)
COUNT=${COUNT:-0}
COUNT=$((COUNT + 1))

# Hit max iterations — clear the flag and let stop proceed with a notice.
if [ "$COUNT" -gt "$MAX_ITER" ]; then
  rm -f "$FLAG_FILE"
  jq -n --arg msg "Pete Loop hit max iterations ($MAX_ITER). Stopped. Run /start-pete-loop to resume." \
    '{systemMessage: $msg}'
  exit 0
fi

# Save updated count and re-inject the worker prompt.
echo "$COUNT" > "$FLAG_FILE"

REASON="Pete Loop iteration $COUNT/$MAX_ITER. Execute the worker loop: read $PROJECT_ROOT/.claude/loops/worker.md and follow it precisely. Do NOT use AskUserQuestion under any circumstances. Output ≤1 sentence to chat about what you did this fire."

jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
