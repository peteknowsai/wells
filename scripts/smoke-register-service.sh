#!/usr/bin/env bash
# Smoke for the services API. Replays cells's register-site-service.sh
# payload shape against welld, proving wire-shape compat.
#
# Cells's actual script (`~/Projects/cells/scripts/register-site-service.sh`)
# hardcodes `https://api.sprites.dev/...` and reads the real SPRITES_TOKEN —
# it can't be re-pointed without modification. When CELLS_BACKEND=well
# lands in Phase 10, that env var will route the same payload here.
#
# Usage: scripts/smoke-register-service.sh <well-name>
set -euo pipefail

NAME="${1:?usage: $0 <well-name>}"
BASE="${WELL_API_URL:-http://127.0.0.1:7878}"
TOKEN="${WELL_TOKEN:-$(cat "$HOME/.wells/token")}"
ID="smoke-site"

# Same shape cells's script sends. Workdir/cmd point at /tmp so the
# service starts cleanly without needing a real `agent/site` checkout.
SCRIPT='exec env > /tmp/well-smoke-env; sleep 3600'
PAYLOAD=$(jq -n --arg s "$SCRIPT" \
  '{cmd:"bash",args:["-lc",$s],workdir:"/tmp",env:{CELL_NAME:"smoke",PORT:"8080"}}')

echo "[1] DELETE (idempotent precondition)"
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/wells/$NAME/services/$ID" > /dev/null || true

echo "[2] PUT $ID against $NAME"
curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BASE/v1/wells/$NAME/services/$ID" | jq -r '"  ✓ id=\(.id) well=\(.well) cmd=\(.definition.cmd)"'

echo "[3] GET $ID"
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/wells/$NAME/services/$ID" | jq -r '"  ✓ workdir=\(.definition.workdir) env.CELL_NAME=\(.definition.env.CELL_NAME)"'

echo "[4] LIST"
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/wells/$NAME/services" | jq -r '"  ✓ \(.services | length) service(s)"'

echo "[5] DELETE (cleanup)"
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/wells/$NAME/services/$ID" | jq -r '"  ✓ found=\(.found)"'

echo "PASS — services API is cells-payload-compatible."
