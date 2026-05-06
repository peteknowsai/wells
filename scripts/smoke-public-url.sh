#!/usr/bin/env bash
# End-to-end smoke for the public URL bridge: external HTTPS + WSS through
# Cloudflare → cloudflared → splited → splite's guest:8080.
#
# Brings up a temporary HTTP server (then a WS echo) inside the target
# splite, runs both checks, tears them down. Requires:
#   - splited running with SPLITES_PUBLIC_BASE set (e.g. splites.cells.md)
#   - cloudflared splites-proxy tunnel running
#   - ACM cert active for *.<base> (otherwise TLS handshake fails)
#
# Usage: scripts/smoke-public-url.sh <splite-name> [base]
set -euo pipefail

NAME="${1:?usage: $0 <splite-name> [base]}"
BASE="${2:-splites.cells.md}"
URL="https://${NAME}.${BASE}"
WS_URL="wss://${NAME}.${BASE}/agent"

# DHCP lease for ssh into the guest.
LEASE=$(grep -A2 "name=${NAME}\b" /var/db/dhcpd_leases | grep ip_address | head -1 | awk -F= '{print $2}')
[ -n "$LEASE" ] || { echo "no DHCP lease for splite '$NAME'"; exit 1; }
SSH_KEY="$HOME/.splites/vms/$NAME/ssh_key"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $SSH_KEY"

cleanup() {
  ssh $SSH_OPTS "ubuntu@$LEASE" 'sudo systemctl stop splite-smoke-http splite-smoke-ws 2>/dev/null; sudo systemctl reset-failed splite-smoke-http splite-smoke-ws 2>/dev/null; sudo rm -f /tmp/splite-smoke-ws.mjs' 2>/dev/null || true
}
trap cleanup EXIT

echo "[1] start an HTTP server in $NAME on :8080"
ssh $SSH_OPTS "ubuntu@$LEASE" 'sudo systemctl reset-failed splite-smoke-http 2>/dev/null; sudo systemd-run --unit=splite-smoke-http --working-directory=/tmp python3 -m http.server 8080' > /dev/null
sleep 2

echo "[2] external HTTPS: curl $URL"
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$URL")
[ "$CODE" = "200" ] || { echo "  ✗ expected 200, got $CODE"; exit 1; }
echo "  ✓ HTTP 200"

echo "[3] swap in a WS echo server"
ssh $SSH_OPTS "ubuntu@$LEASE" 'sudo systemctl stop splite-smoke-http; sudo systemctl reset-failed splite-smoke-http splite-smoke-ws 2>/dev/null; cat > /tmp/splite-smoke-ws.mjs <<"EOF"
import http from "node:http";
import crypto from "node:crypto";
const srv = http.createServer();
srv.on("upgrade", (req, sock) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(["HTTP/1.1 101 Switching Protocols","Upgrade: websocket","Connection: Upgrade","Sec-WebSocket-Accept: " + accept,"",""].join("\r\n"));
  sock.on("data", (buf) => {
    const len = buf[1] & 0x7f;
    const masked = (buf[1] & 0x80) !== 0;
    let off = 2;
    let mask = null;
    if (masked) { mask = buf.slice(off, off+4); off += 4; }
    const payload = Buffer.from(buf.slice(off, off+len));
    if (mask) for (let i=0;i<payload.length;i++) payload[i]^=mask[i%4];
    const text = "echo: " + payload.toString("utf-8");
    const resp = Buffer.alloc(2 + text.length);
    resp[0] = 0x81; resp[1] = text.length;
    resp.write(text, 2);
    sock.write(resp);
  });
});
srv.listen(8080);
EOF
sudo systemd-run --unit=splite-smoke-ws node /tmp/splite-smoke-ws.mjs' > /dev/null
sleep 2

echo "[4] external WSS: $WS_URL"
TMP=$(mktemp -t splite-ws-smoke.XXXXXX)
trap "rm -f $TMP; cleanup" EXIT
cat > "$TMP" <<EOF
const ws = new WebSocket("${WS_URL}");
ws.onopen = () => ws.send("hello via tunnel");
ws.onmessage = (ev) => { console.log(ev.data); ws.close(); };
ws.onerror = (e) => { console.error("ws error:", (e).message ?? "unknown"); process.exit(2); };
ws.onclose = () => process.exit(0);
setTimeout(() => { console.error("timeout"); process.exit(2); }, 10000);
EOF
OUT=$(bun run "$TMP")
[ "$OUT" = "echo: hello via tunnel" ] || { echo "  ✗ expected 'echo: hello via tunnel', got '$OUT'"; exit 1; }
echo "  ✓ WSS roundtrip ok"

echo
echo "PASS — $URL serves HTTPS and WSS end-to-end through the tunnel."
