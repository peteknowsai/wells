#!/usr/bin/env bash
# End-to-end smoke that replays every cells call shape catalogued in
# docs/sprites-parity.md against a live welld + well. No cells
# process required — we become cells for the test.
#
# Requires:
#   - welld running on 127.0.0.1:7878
#   - $WELL_TOKEN set (or readable from ~/.wells/token)
#   - <well-name> exists and is running
#
# Usage: scripts/smoke-cells-call-shapes.sh <well-name>
set -euo pipefail

NAME="${1:?usage: $0 <well-name>}"
BASE="${WELL_API_URL:-http://127.0.0.1:7878}"
TOKEN="${WELL_TOKEN:-$(cat "$HOME/.wells/token")}"
WELL="bun run $(dirname "$0")/../cli/well.ts"
export WELL_API_URL="$BASE"
export WELL_TOKEN="$TOKEN"

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

echo
echo "=== HTTP API (cells's api() shape) ==="

echo "[1] GET /v1/sprites/${NAME} (cells.ts:3020 — alias path)"
RESP=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/sprites/$NAME")
echo "$RESP" | jq -e '.status and (.url or true) and .created_at and (.last_running_at or true)' > /dev/null \
  || fail "missing sprites-shaped fields"
pass "status=$(jq -r .status <<<"$RESP"), url=$(jq -r .url <<<"$RESP"), created_at present"

echo "[2] POST /v1/sprites/${NAME}/exec (cells's deliberate/index.ts:37)"
RESP=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":["bash","-lc","echo cell-says-hi from $(hostname); echo err-stream >&2; exit 3"]}' \
  "$BASE/v1/sprites/$NAME/exec")
[ "$(jq -r .exit_code <<<"$RESP")" = "3" ] || fail "exit_code mismatch"
[ "$(jq -r .stdout <<<"$RESP")" = "cell-says-hi from $NAME" ] || fail "stdout mismatch: $(jq -r .stdout <<<"$RESP")"
[ "$(jq -r .stderr <<<"$RESP")" = "err-stream" ] || fail "stderr mismatch"
pass "exit_code, stdout, stderr round-trip with snake_case names"

echo "[3] GET /v1/sprites/${NAME}/policy/network (cells.ts:3021 — tolerated 4xx)"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/sprites/$NAME/policy/network" \
  | jq -e '.rules' > /dev/null || fail "rules field missing"
pass "rules array present"

echo "[4] PUT /v1/sprites/${NAME}/services/smoke-svc (cells's register-site-service.sh)"
PAYLOAD='{"cmd":"bash","args":["-lc","sleep 60"],"workdir":"/tmp"}'
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/v1/sprites/$NAME/services/smoke-svc" > /dev/null || true
curl -fsS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD" "$BASE/v1/sprites/$NAME/services/smoke-svc" > /dev/null
pass "service PUT accepted"

echo "[5] DELETE /v1/sprites/${NAME}/services/smoke-svc (idempotent)"
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/v1/sprites/$NAME/services/smoke-svc" > /dev/null
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/v1/sprites/$NAME/services/smoke-svc" > /dev/null
pass "DELETE idempotent"

echo
echo "=== CLI shape (cells's sprite shell-outs) ==="

echo "[6] sprite info -s <n> | awk '/^URL:/ {print \$2}' (deploy-cell-worker.sh:36)"
URL=$($WELL info -s "$NAME" | awk '/^URL:/ {print $2}')
[ -n "$URL" ] || fail "URL line missing or empty"
pass "URL: $URL"

echo "[7] sprite api -s <n> /v1/sprites/<n>/policy/network -X POST -H ... -d ... (sprite-tools)"
$WELL api -s "$NAME" "/v1/sprites/$NAME/policy/network" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"rules":[{"action":"allow","domain":"github.com"}]}' \
  | jq -e '.accepted == true' > /dev/null || fail "policy api passthrough failed"
pass "curl-style flags accepted; policy ack'd"

echo "[8] sprite exec with shell metacharacters (cells.ts:1975 et al.)"
OUT=$($WELL exec -s "$NAME" -- bash -c 'echo "it works"; printf "%s\n" "$0"')
[ "$OUT" = $'it works\nbash' ] || fail "shell-escape regression: got '$OUT'"
pass "metacharacters survive ssh round-trip"

echo "[9] sprite restore <id> (top-level verb; cells.ts:3751)"
# Don't actually restore — just verify the verb is recognized.
OUT=$($WELL restore nonexistent-cp -s "$NAME" 2>&1 || true)
echo "$OUT" | grep -q "restoring '$NAME'" || fail "flat restore verb not recognized"
pass "flat restore verb recognized"

echo "[10] sprite checkpoint create -s <n> --comment <label>"
RESP=$($WELL checkpoint create -s "$NAME" --comment "smoke check $(date +%H%M%S)" 2>&1)
echo "$RESP" | grep -q "smoke check" || fail "comment not echoed"
pass "checkpoint with comment landed"

echo "[11] sprite url update --auth public -s <n> (cells.ts:3842 hatch step)"
$WELL url update --auth public -s "$NAME" > /dev/null
ANON_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "https://${NAME}.cells.md/" || echo 000)
[ "$ANON_CODE" = "200" ] || [ "$ANON_CODE" = "502" ] || fail "expected anon 200/502 with auth=public, got $ANON_CODE"
pass "auth=public flips proxy"

$WELL url update --auth well -s "$NAME" > /dev/null
ANON_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "https://${NAME}.cells.md/" || echo 000)
[ "$ANON_CODE" = "401" ] || fail "expected anon 401 with auth=well, got $ANON_CODE"
pass "auth=well gates proxy"

# Restore default for a polite exit.
$WELL url update --auth public -s "$NAME" > /dev/null

echo
echo "PASS — wells is cells-call-shape-compatible."
