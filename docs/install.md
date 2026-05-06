# Splites — host install (one-time)

For the public-URL bridge: cells's CF Worker dials `https://<name>.splites.cells.md`, Cloudflare Tunnel terminates TLS at the edge, and `cloudflared` on the Mac forwards to splited's reverse proxy at `127.0.0.1:7878`. Splited dispatches by `Host` header to the right splite's guest:8080.

This is one-time host setup. Once it's done, every new splite gets a working public URL automatically — no per-splite DNS, no per-splite tunnel.

## Prerequisites

- A domain on Cloudflare you control. The default in this repo is `splites.cells.md`. Substitute your own domain in the steps below if different — just keep `SPLITES_PUBLIC_BASE` and the wildcard CNAME aligned.
- `splited` running (`bun run daemon/splited.ts`). It listens on `127.0.0.1:7878`.

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
cloudflared tunnel create splites-proxy
```

Prints a tunnel UUID and writes a credentials JSON to `~/.cloudflared/<UUID>.json`. Save the UUID — you need it for the CNAME.

The `splites-proxy` name keeps this tunnel decoupled from cells's existing `cells-proxy` (so a cells outage doesn't drag splites down).

## 4. Wildcard CNAME

In the Cloudflare dashboard for your zone, add a DNS record:

```
Type:   CNAME
Name:   *.splites
Target: <UUID>.cfargotunnel.com
Proxy:  Proxied (orange cloud)
TTL:    Auto
```

This routes every `<anything>.splites.cells.md` to the tunnel.

## 5. Tunnel config

Write `~/.cloudflared/splites-config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<you>/.cloudflared/<UUID>.json

ingress:
  - hostname: "*.splites.cells.md"
    service: http://127.0.0.1:7878
  - service: http_status:404
```

Single ingress: every splite hostname goes to splited; everything else 404s.

## 6. Run as a launchd service

```sh
sudo cloudflared --config ~/.cloudflared/splites-config.yml service install
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

The service starts at boot, restarts on crash. Check it:

```sh
sudo launchctl list | grep cloudflared
log stream --predicate 'subsystem == "com.cloudflare.cloudflared"' --info  # follow logs
```

## 7. Tell splited the public base

Splited only emits the `url` field on splite resources when `SPLITES_PUBLIC_BASE` is set, and only proxies requests whose `Host` header matches it.

```sh
export SPLITES_PUBLIC_BASE=splites.cells.md
bun run daemon/splited.ts
```

Persist it however you start splited (launchd plist `EnvironmentVariables`, shell profile, etc).

## 8. Verify

Boot a splite (`splite create test`) and run a service on its 8080. Then from any machine on the internet:

```sh
curl https://test.splites.cells.md/
```

Should reach the in-guest server. WebSocket Upgrade through the same hostname works the same way (this is how cells's CF Worker DO holds its persistent `/agent` WS).

## Troubleshooting

- **`cloudflared` 1033 error**: tunnel started but no ingress matches. Check the config's `hostname:` value matches the wildcard CNAME exactly.
- **`502 splite '<name>' not found or not running`**: the request reached splited but the splite isn't registered or has no DHCP lease. `splite list` and `splite info <name>`.
- **`502 bad gateway: Unable to connect`**: the splite is running but nothing is listening on guest:8080. Register a service via `PUT /v1/splites/<name>/services/<id>`.
- **Bare-host requests get 401**: that's correct. `curl http://127.0.0.1:7878/` (no `Host: <n>.splites.cells.md`) hits the API path, which requires a bearer token. Only proxy traffic skips auth.
