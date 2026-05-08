# Wells — host install (one-time)

For the public-URL bridge: cells's CF Worker dials `https://<name>.wells.cells.md`, Cloudflare Tunnel terminates TLS at the edge, and `cloudflared` on the Mac forwards to welld's reverse proxy at `127.0.0.1:7878`. Welld dispatches by `Host` header to the right well's guest:8080.

This is one-time host setup. Once it's done, every new well gets a working public URL automatically — no per-well DNS, no per-well tunnel.

## Prerequisites

- A domain on Cloudflare you control. The default in this repo is `wells.cells.md`. Substitute your own domain in the steps below if different — just keep `WELL_PUBLIC_BASE` and the wildcard CNAME aligned.
- `welld` running (`bun run daemon/welld.ts`). It listens on `127.0.0.1:7878`.

## 1. Install cloudflared

```sh
brew install cloudflared
cloudflared --version   # any 2024+ release is fine
```

## 2. Authenticate

```sh
cloudflared tunnel login
```

Opens a browser. Pick the zone (`cells.md`). Cloudflare drops a cert at `~/.cloudflared/cert.pem`.

## 3. Create a dedicated tunnel

```sh
cloudflared tunnel create wells-proxy
```

Prints a tunnel UUID and writes a credentials JSON to `~/.cloudflared/<UUID>.json`. Save the UUID — you need it for the CNAME.

The `wells-proxy` name keeps this tunnel decoupled from cells's existing `cells-proxy` (so a cells outage doesn't drag wells down).

## 4. Advanced Certificate Manager (one-time, $10/mo per zone)

Cloudflare Universal SSL covers depth-1 wildcards (`*.cells.md`) but not depth-2 (`*.wells.cells.md`). Without ACM, the edge has no cert for `<name>.wells.cells.md` and TLS handshakes fail.

In the dashboard: SSL/TLS → Edge Certificates → Order Advanced Certificate. Hostnames: `*.wells.cells.md` and `wells.cells.md`. CA: Google Trust Services. Validity: 3 months (auto-renewed). Validation: TXT (forced for wildcards; Cloudflare auto-adds the record since the zone is on CF). Provisioning: 5–30 min.

Verify when active:

```sh
echo | openssl s_client -connect any.wells.cells.md:443 -servername any.wells.cells.md 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName
```

The SAN list should include `*.wells.cells.md`.

## 5. Wildcard CNAME

```sh
cloudflared tunnel route dns --overwrite-dns <UUID> "*.wells.cells.md"
```

`--overwrite-dns` is needed if the wildcard already exists pointing at a different tunnel. (`cloudflared tunnel route dns <name>` resolves the tunnel name through `~/.cloudflared/config.yml`'s default tunnel — pass the UUID to be unambiguous.)

This routes every `<anything>.wells.cells.md` to the tunnel.

## 6. Tunnel config

Write `~/.cloudflared/wells-config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<you>/.cloudflared/<UUID>.json

ingress:
  - hostname: "*.wells.cells.md"
    service: http://127.0.0.1:7878
  - service: http_status:404
```

Single ingress: every well hostname goes to welld; everything else 404s.

## 7. Run the tunnel

Two options. **Option A (matches cells-proxy):** run as a user-level background process — simple, no sudo, but doesn't survive reboot:

```sh
nohup cloudflared tunnel --config ~/.cloudflared/wells-config.yml run > ~/cloudflared-wells.log 2>&1 &
```

**Option B (system launchd, survives reboot):**

```sh
sudo cloudflared --config ~/.cloudflared/wells-config.yml service install
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

Note: `cloudflared service install` writes one launchd plist (`com.cloudflare.cloudflared`). If cells-proxy is also using launchd, the second install overwrites the first — keep both as user processes (option A) instead, or hand-write a per-tunnel plist.

## 8. Tell welld the public base

Welld only emits the `url` field on well resources when `WELL_PUBLIC_BASE` is set, and only proxies requests whose `Host` header matches it.

```sh
export WELL_PUBLIC_BASE=wells.cells.md
bun run daemon/welld.ts
```

Persist it however you start welld (launchd plist `EnvironmentVariables`, shell profile, etc).

## 9. Verify

Boot a well (`well create test`) and run a service on its 8080. Then from any machine on the internet:

```sh
curl https://test.wells.cells.md/
```

Should reach the in-guest server. WebSocket Upgrade through the same hostname works the same way (this is how cells's CF Worker DO holds its persistent `/agent` WS).

Or run the bundled smoke against an existing well:

```sh
scripts/smoke-public-url.sh <well-name>
```

It brings up a temporary HTTP + WS server inside the well, exercises both, and tears down.

## What cells gets out of the box

### SSH user: `sprite`

Every well boots with a `sprite` user (uid 1001, NOPASSWD sudo). Cells's birth flow — DNA push, bashrc.d setup, `/home/sprite/agent` — should SSH as `sprite@<ip>`. This mirrors the sprites contract exactly; no adjustments needed on the cells side.

The `ubuntu` user is still present for operator debug and fallback. `well exec` and `well console` currently SSH as `ubuntu` (internal tooling). Cells's own direct SSH should use `sprite`.

### Seeding env vars at create time: `--env`

```sh
well create cells-x --env CELLS_PROXY_SECRET=abc123 [--env KEY=VAL ...]
```

Each `--env KEY=VAL` pair lands in `/etc/environment` on the well at first boot via cloud-init. PAM loads `/etc/environment` on every SSH session (including non-login shells), so the secret is present from the moment the well is reachable — no post-birth `configure-cell-proxy.sh` round-trip needed.

### Wake-on-demand exec

`well exec` wakes a stopped or paused well before SSH. Internally it POSTs `/v1/wells/{n}/start` first; the daemon's start handler calls `ensureRunning` so paused wells unpause too. Cold-start to first exec output is roughly 5 seconds. Cells code that calls `POST /v1/wells/{n}/exec` (HTTP or WS) also gets wake-on-demand — the daemon handles it server-side.

## Troubleshooting

- **`cloudflared` 1033 error**: tunnel started but no ingress matches. Check the config's `hostname:` value matches the wildcard CNAME exactly.
- **`502 well '<name>' not found or not running`**: the request reached welld but the well isn't registered or has no DHCP lease. `well list` and `well info <name>`.
- **`502 bad gateway: Unable to connect`**: the well is running but nothing is listening on guest:8080. Register a service via `PUT /v1/wells/<name>/services/<id>`.
- **Bare-host requests get 401**: that's correct. `curl http://127.0.0.1:7878/` (no `Host: <n>.wells.cells.md`) hits the API path, which requires a bearer token. Only proxy traffic skips auth.
