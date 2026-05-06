# 0002 — Bridge: Cloudflare Tunnel + public hostname (not Workers VPC)

**Status:** accepted (2026-05-06)

## Context

Splites needs each guest's port 8080 reachable from the internet so cells's CF Worker bridge (`cells-front-<name>` Durable Object) can hold a persistent outbound WebSocket to the splite's `/agent` endpoint. Two viable Cloudflare paths in 2026:

1. **Traditional Cloudflare Tunnel + public hostname.** `cloudflared` on the host advertises `*.splites.cells.md` (wildcard CNAME → tunnel). The Worker dials the URL like any internet hostname. WebSocket support is documented and battle-tested.

2. **Workers VPC binding** (public beta, April 2026). Same `cloudflared` on the host, but the Worker binds via `env.VPC.fetch(...)` instead of dialing a public URL. No public DNS needed. Free during beta. **WebSocket support not documented** in the VPC API reference or beta announcements as of 2026-05.

## Decision

Traditional Cloudflare Tunnel + public hostname (`*.splites.cells.md`) for the MVP bridge. Rolling this into Phase 9 (the URL/bridge piece was originally deferred to Phase A; pulling forward because cells's bridge demo can't ship without it).

## Rationale

- **WebSocket is the load-bearing protocol.** Cells's Worker DO holds a persistent WS to the splite's `/agent`. Traditional tunnels have documented WS support and years of production use; VPC bindings have neither.
- **Cells's existing CF Worker code transfers with one URL constant change.** The Worker keeps dialing a public hostname — just `<name>.splites.cells.md` instead of `<name>-XXX.sprites.app`. No bridge-side rework.
- **Same `cloudflared` binary either way.** Install, login, register tunnel — identical work. Only the Worker-side binding shape differs.
- **VPC binding for WS would be a research project.** MVP is the wrong place for "probably works" — we want documented, verified.
- **No security cost for solo use.** The tunnel hostname routes through Cloudflare's edge with TLS termination at the edge; splited gates the actual `/agent` upgrade on `Authorization: Bearer $CELLS_PROXY_SECRET` (matches cells's existing pattern). Static routes can be public.

## Reconsider when

- Cloudflare publishes documentation confirming WebSocket support over Workers VPC bindings (worth migrating — no public hostname is a nicer security posture).
- We benchmark the VPC binding path with cells's actual WS pattern and verify it works.
- We have non-WS workloads where VPC bindings are obviously the right shape (e.g., management API access from a Worker without exposing splited publicly). These can use VPC bindings *alongside* the public hostname for the bridge — both can coexist.

## Implementation notes

- **Tunnel topology**: dedicated `splites-proxy` tunnel, separate from cells's existing `cells-proxy` tunnel (which serves `*.cells.md`). Splites lifecycle stays decoupled — a cells outage or tunnel cycle doesn't drag splites down. May consolidate later (single tunnel, two ingress patterns) if operational complexity warrants — that's a one-config-file change, no protocol impact.
- DNS: wildcard CNAME `*.splites.cells.md` → `<splites-tunnel-id>.cfargotunnel.com`. One-time manual setup.
- `cloudflared`: runs as a launchd service on the Mac Mini, configured via its own `~/.cloudflared/splites-config.yml` (separate from `cells-proxy-config.yml`). Single ingress: `*.splites.cells.md` → `http://127.0.0.1:7878` (splited's reverse-proxy port).
- Splited's reverse proxy: dispatches by `Host` header. `pete.splites.cells.md` → splite `pete`'s guest:8080.
- Auth: cells's existing `CELLS_PROXY_SECRET` bearer gating on the `/agent` WS upgrade. Static HTTP is public (sprites parity).
- Documented in `docs/install.md` (one-time host setup).
