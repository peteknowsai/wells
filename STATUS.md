# splites — Current Status

**Updated:** 2026-05-10 ~10:30 UTC by `steward` (silent-mode fire — Pete async, no touches).
**Phase:** Phase A in flight. A.1 (autosleep/wake/warm + pool) shipped. A.2 (R2 sync) GC done; round-trip smoke gated on a Pete-only blocker (R2 token).
**Health:** 🟡 Stable at `wells-stable-2026-05-10d`. Cells team's main flows (bake/birth/steady-state) all work. **Wake is broken** (W.27, host-level VZ regression) — auto-hibernate + wake-on-traffic don't function until Pete intervenes; cells team mitigation is `auto_sleep_seconds: null`.

## TL;DR

Pete Loop hit MAX_ITER=200 and auto-stopped at ~09:50 UTC; substantive work landed in iters 1-22, iters 23-200 were no-ops awaiting Pete. Three Pete decisions outstanding: W.27 (wake regression — host reboot), W.2 (R2 token mint), W.22 (steward-starvation durable fix).

## What changed since last steward fire

This is the first steward fire of the session — entire session arc summarized in JOURNAL's `09:36 UTC — fires 3-15 cluster` and `09:30 UTC — session arc summary (iterations 1-28)` entries. Highlights:

- **Three stable promotions** in one session: `2026-05-10a` (WS proxy), `-10b` (lume supervisor adopted-gap), `-10c` (graceful-stop), `-10d` (graceful-stop + plist PATH + images shape + pool zombie prune).
- **Cells-team triple unblock**: W.23 pool zombie auto-prune, W.24 plist PATH `/usr/sbin`, W.25 images-shape tolerance — all cut into `-10d` and live-verified.
- **Thaw primitive (W.26)** shipped end-to-end — `POST /v1/wells {name, from_thaw}` + `lib/thaw.ts` with serialized concurrency, full bundle mirror, hibernate.config.json path-rewrite. First thaw worked, subsequent attempts hit W.27.
- **Perf wins verified live** (W.7+W.21): create p95 27.1s → 17.4s (-36%), `diskReleased` p95 6.4s → 4.5s (-30%). Both shipped into `-10d` stable.
- **Concurrent-fork ceiling pinned at 4** (vmnet bootp DHCP race breaks N≥5; lume itself is stable). Cells team can fan-out up to 4 fresh-creates without partial-failure mitigation.
- **Wake regression surfaced + bisected** (W.27): every restoreState fails with VZ "permission denied". Graceful-stop revert tested live + ruled out — issue is below us in the stack (Apple VZ daemon, TCC, or accumulated lume process state).
- **Image library on R2** (W.3+W.4+W.5): design + push + pull + auto-pull-on-create all shipped. Phase E Colony prerequisite.
- **Welld robustness audit** (W.12+W.19+W.20): port-bind exits, watchdog backoff after 5 fails.
- **Vendor cleanup** (W.14 slices 1+2): `engine/lume.ts` → `vwell.ts`; `vendor/lume/` → `engine/vwell-src/`. Slice 3 (`bin/lume` → `bin/vwell`) deferred to Pete.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **W.27 — wake regression** | VZ `permission denied` on every restoreState since ~04:30 UTC. Graceful-stop revert tested + ruled out. Issue likely host-level (VZ daemon state, TCC, or accumulated lume process state). | Pete: test wake on stable directly to localize, then host reboot if still broken. See `docs/findings-wake-regression-permission-denied.md`. |
| W.10 / W.11 / W.26 thaw end-to-end | Wake required | W.27 |
| **W.2 — R2 round-trip smoke** | R2 token returning `Access Denied` on `wells-smoke-r2` bucket | Pete: mint a bucket-scoped R2 token in Cloudflare console |
| W.22 — steward cron starvation (durable fix) | Resolved-by-side-effect (MAX_ITER cap-out opened the idle window). Durable fix space documented in BOARD. | Pete decides: integrate / Stop-hook gate / accept-cap-out-as-window |

## What's NOT stuck (cells team can use these now)

- ✅ Bake → save (validate=true) → fork: writes survive (graceful-stop fix).
- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2 if creds set).
- ✅ `cells bake` flow (W.24 plist PATH + W.25 images shape tolerance + W.23 pool zombie cleanup all in `wells-stable-2026-05-10d`).
- ✅ Image library on R2 (W.3+W.4+W.5).
- ✅ Concurrent fan-out up to N=4 fresh-creates.
- ✅ Pool fast-path adopt is partial — adoption goes through wake (broken). Set `defaults.pool_size=0` to skip until W.27 resolves.

## Substrate facts (verified live this session)

| Metric | Value | Source |
|---|---|---|
| Create+warm p50 | 14.2s | 125 samples (74 stable + 51 dev) |
| Create+warm p95 | **17.4s** (was 27.1s pre-W.7+W.21, -36%) | `docs/findings-create-warm-distribution-2026-05-10.md` |
| `diskReleased` p95 | **4.5s** (was 6.4s, -30%) | Same |
| Concurrent-fork ceiling | **4** (lume stable; vmnet bootp DHCP race breaks N≥5) | `docs/findings-concurrent-fork-crash.md` |
| Concurrent-restoreState ceiling | **1** (must serialize wake/thaw) | `docs/findings-thaw.md` |
| Test suite | 532/532 green | `bun test` default sequential |

## Pete needs to decide (silent-mode — see `NEEDS_PETE.md`)

- **W.27 host reboot or stable wake-test.** Wake regression deterministic, blocks autosleep + thaw + smoke-wake-stress.
- **W.2 R2 token.** Mint a bucket-scoped R2 token for `wells-smoke-r2`.
- **W.22 steward starvation fix.** Architectural call — recommendation in BOARD's W.22 entry is option (c) (accept cap-out as natural cadence — zero eng).
- **W.14 slice 3 (`bin/lume` → `bin/vwell` rename).** Defaulted to deferred.

## Cells team status

**Mostly unblocked.** Bake + birth + steady-state cell ops all work in `wells-stable-2026-05-10d`. Watchdog autosleep + wake-on-traffic broken pending W.27 — mitigate with `auto_sleep_seconds: null` until resolved. `docs/cells-integration.md` has the substrate facts + ⚠️ banner for the wake regression.

## Next planned cycle

Pete Loop is auto-stopped (MAX_ITER=200). No autonomous worker fires until Pete starts a new loop or invokes a manual fire. When Pete returns:
- Resolves W.27 → unblocks thaw end-to-end, smoke-wake-stress live runs, watchdog testing.
- Resolves W.2 → closes A.2 round-trip smoke MVP-PLAN box.
- Decides W.22 fix → either integrates steward into worker or accepts the cap-out window (steward fired here is concrete proof option-c works).
