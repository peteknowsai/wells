# Blocked — 2026-05-06

Phase 9's four remaining unchecked boxes are all waiting on Pete's manual host setup. The loop can't make code progress here.

## What's blocked

Under `### Phase 9 — Services & public URL bridge` in `docs/MVP-PLAN.md`:

- [ ] Cloudflare Tunnel installed as launchd service
- [ ] DNS: wildcard CNAME `*.splites.cells.md` → tunnel
- [ ] WebSocket Upgrade verified end-to-end through the tunnel
- [ ] External `curl https://<name>.splites.cells.md/healthz` smoke

The first two are manual-only. The last two are verification steps that depend on the first two being done.

## What Pete needs to do

Follow `docs/install.md`. Once `sudo launchctl list | grep cloudflared` shows the service running and `dig *.splites.cells.md` resolves to a `cfargotunnel.com` target, the first two boxes can tick. Then the two smokes are codable / runnable.

## What I tried

Nothing — proceeding would mean either (a) signing up for a Cloudflare account on Pete's behalf (clear scope violation), or (b) jumping to Phase 10 work in `~/Projects/cells` (the loop's "first phase with unchecked items" rule says stay on Phase 9).

## Pete's call

1. Do the manual setup, then resume the loop. Or:
2. Tell me to skip ahead to Phase 10 (cells integration). The four blocked boxes can finish whenever; they don't gate Phase 10 since Phase 10 is initially CLI-side cells changes that work against any splited URL.
3. Tell me to delete this file and pick the smallest non-blocked thing in the repo (smoke scripts, doc polish, etc.) — explicitly out-of-MVP-plan scope but useful.

The recommendation: option 1 if you're going to do it tonight, option 2 if you want to keep code shipping. Don't pick option 3 — small busywork shouldn't preempt the actual MVP path.

---

## 2026-05-06 (recheck)

Loop fired again. Re-verified:

- `cloudflared` is installed (`/opt/homebrew/bin/cloudflared`, v2025.9.0). ✓
- `dig *.splites.cells.md` returns Cloudflare proxied A records — so a wildcard CNAME *exists* but I can't see the target through the orange-cloud proxy. ✓ (likely)
- `cloudflared tunnel list` shows no `splites-proxy` tunnel. ✗
- `~/.cloudflared/` has no `splites-config.yml`. ✗
- `launchctl list | grep cloud` — no entry. ✗

So three of the four steps in `docs/install.md` aren't done: tunnel create, splites-config.yml, launchd install. Without those, the cloudflared half of Phase 9 can't tick.

Blocker still real. Same call as before — pick an option. Telling the loop to skip ahead is one word away.

---

## 2026-05-06 (Pete said "do it" — got most of the way, hit SSL wall)

Did the cloudflared work end-to-end:

- Created tunnel `splites-proxy` (uuid `eaddeff4-1d90-405b-8191-3991a4aeef8e`).
- Routed `*.splites.cells.md` to it (had to use `--overwrite-dns` because the first attempt routed to the wrong tunnel — `cloudflared`'s default config resolves names through `~/.cloudflared/config.yml` which is cells-api-local; explicit UUIDs avoid that).
- Wrote `~/.cloudflared/splites-config.yml`.
- Started `cloudflared tunnel --config ~/.cloudflared/splites-config.yml run` as a user process (matching how cells-proxy runs — no launchd). 4 connections, healthy.
- Started splited with `SPLITES_PUBLIC_BASE=splites.cells.md`.

External smoke fails on TLS, not the tunnel:

```
$ curl https://pete.splites.cells.md/
curl: (35) sslv3 alert handshake failure
```

**Root cause: Cloudflare Universal SSL doesn't cover multi-level wildcards.** It auto-provisions certs for the apex + one wildcard level (`*.cells.md`). It does NOT cover `*.splites.cells.md` (two levels deep). Cloudflare's edge therefore has no cert for `pete.splites.cells.md` and rejects the TLS handshake.

Confirmed by inspecting the existing `pete.cells.md` cert — its SANs are `cells.md, pete.cells.md, *.pete.cells.md`. Per-host. The `*.cells.md` wildcard pattern that cells uses works because it's at depth 1.

**Pete's options:**

1. **Buy Advanced Certificate Manager** ($10/mo per zone) for `cells.md`. Provisions wildcard certs at any depth. Cleanest fix; preserves the `<name>.splites.cells.md` URL shape cells's worker bridge expects.
2. **Use a flat namespace under `cells.md`.** E.g., `splite-pete.cells.md`. Single label, covered by Universal SSL. Each splite needs a per-host CNAME (not a wildcard — DNS doesn't support `splite-*` wildcards), so `splite create` would have to call the Cloudflare API to add the CNAME at create time. More moving pieces but free.
3. **Use a different domain entirely** (`splites.dev`, etc.). Pete buys it; Universal SSL covers `*.splites.dev` at depth 1.
4. **Path-based routing**: `https://splites.cells.md/<name>/...`. SSL works (covered by `*.cells.md`). Breaks cells's expectation that each splite has its own hostname for the WS bridge — would need cells worker changes too.
5. **Order ACM yourself via the Cloudflare API** if you have ACM enabled on the account but not the zone.

What's currently running (so don't be surprised):
- `cloudflared tunnel --config ~/.cloudflared/splites-config.yml run` (background user process, ~4 connections)
- `bun run daemon/splited.ts` with SPLITES_PUBLIC_BASE set (background)

Both are safe to leave running or to kill. To kill: `pkill -f "cloudflared.*splites"; pkill -f "bun run.*splited"`. To delete the tunnel if abandoning the path: `cloudflared tunnel delete eaddeff4-1d90-405b-8191-3991a4aeef8e` (and remove the wildcard CNAME from Cloudflare DNS).

Recommendation: option 1 ($10/mo for ACM). The URL shape is what cells expects, you avoid a per-create API hop, and it scales to many splites without per-host record management. If you want to defer the cost, option 2 is the cheap workable second choice.

Stopping per loop discipline.

---

## 2026-05-06 (third loop firing — SSL still unresolved)

Re-verified: `pete.splites.cells.md` still TLS-handshake-fails. Nothing has changed since the previous note. Pete needs to pick one of the four options above before the loop can advance Phase 9. Stopping.
