# splites — Current Status

**Updated:** 2026-05-10 ~12:30 UTC by `pete-session` (post-host-reboot wake verification).
**Phase:** Phase A in flight. A.1 (autosleep/wake/warm + pool) shipped + verified post-reboot. A.2 (R2 sync) GC done; round-trip smoke gated on R2 token (Pete-only).
**Health:** 🟢 Stable at `wells-stable-2026-05-10d`. **Wake works again** — Pete's host reboot fixed W.27. All cells team flows operational; mitigation can be dropped.

## TL;DR

Pete restarted the Mac at ~12:18 UTC. Wake regression cleared. Wake-stress smoke 30/30 passed (wake p95 829ms, ssh-after-wake p95 1147ms). Cells team is fully unblocked. Two open Pete decisions remain: W.2 (R2 token mint) and W.22 (steward starvation, durable-fix call).

## What changed since last steward fire (10:30 UTC)

- **Pete restarted the Mac at ~12:18 UTC** — the W.27 fix path the regression doc recommended.
- **Verified wake works**: dev welld back up; created `wake-postreboot` well, hibernate 207ms + wake 839ms.
- **Full wake-stress smoke green**: `scripts/smoke-wake-stress.ts`, 30/30 cycles, 0 failures. Tight distributions.
- **Docs updated**: `cells-integration.md` banner flipped ✅; `findings-wake-regression-permission-denied.md` marked RESOLVED with the post-reboot evidence; `findings-wake-stress-2026-05-10.md` overwritten with green data.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **W.2 — R2 round-trip smoke** | R2 token returning `Access Denied` on `wells-smoke-r2` bucket | Pete: mint a bucket-scoped R2 token in Cloudflare console |
| W.22 — steward cron starvation (durable fix) | Resolved-by-side-effect (MAX_ITER cap-out opened the idle window). Durable fix space documented in BOARD. | Pete decides: integrate / Stop-hook gate / accept-cap-out-as-window |

## What's NOT stuck (cells team can use these now)

- ✅ Bake → save (validate=true) → fork: writes survive (graceful-stop fix).
- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2 if creds set).
- ✅ `cells bake` flow (W.24 plist PATH + W.25 images shape tolerance + W.23 pool zombie cleanup all in `wells-stable-2026-05-10d`).
- ✅ Image library on R2 (W.3+W.4+W.5).
- ✅ Concurrent fan-out up to N=4 fresh-creates.
- ✅ **Watchdog autosleep + wake-on-traffic** (post-reboot — wake-stress 30/30 green).
- ✅ **Pool fast-path adopt** (works again now that wake works).
- ✅ **Thaw primitive** (`POST /v1/wells {name, from_thaw}`) — code shipped, wake works, end-to-end now testable.

## Substrate facts (verified live this session)

| Metric | Value | Source |
|---|---|---|
| Create+warm p50 | 14.2s | 125 samples (74 stable + 51 dev) |
| Create+warm p95 | **17.4s** (was 27.1s pre-W.7+W.21, -36%) | `docs/findings-create-warm-distribution-2026-05-10.md` |
| `diskReleased` p95 | **4.5s** (was 6.4s, -30%) | Same |
| **Hibernate p95** | **201ms** (post-reboot, 30 samples) | `docs/findings-wake-stress-2026-05-10.md` |
| **Wake p95** | **829ms** (post-reboot, 30 samples) | Same |
| **SSH-after-wake p95** | **1147ms** | Same |
| Concurrent-fork ceiling | **4** (lume stable; vmnet bootp DHCP race breaks N≥5) | `docs/findings-concurrent-fork-crash.md` |
| Concurrent-restoreState ceiling | **1** (must serialize wake/thaw) | `docs/findings-thaw.md` |
| Test suite | 532/532 green | `bun test` default sequential |

## Pete needs to decide

- **W.2 R2 token.** Mint a bucket-scoped R2 token for `wells-smoke-r2`.
- **W.22 steward starvation fix.** Architectural call — recommendation in BOARD's W.22 entry is option (c) (accept cap-out as natural cadence — zero eng).
- **W.14 slice 3 (`bin/lume` → `bin/vwell` rename).** Defaulted to deferred.

## Cells team status

**Fully unblocked.** Bake + birth + steady-state + watchdog autosleep + wake-on-traffic + thaw primitive all operational. The `auto_sleep_seconds: null` mitigation from earlier today can be dropped. `docs/cells-integration.md` banner is now ✅.

## Next planned cycle

Pete chose `keep going` — natural next steps:
- Verify thaw end-to-end (W.26 was code-complete but blocked on wake; now testable).
- Run pool churn smoke (W.11) and concurrent-fork-with-wake smokes.
- Or close W.2 once Pete mints the R2 token.
