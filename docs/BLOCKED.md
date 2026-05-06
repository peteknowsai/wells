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
