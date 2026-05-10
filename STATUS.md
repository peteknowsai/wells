# splites — Current Status

**Updated:** 2026-05-10 09:05 UTC by `worker` (steward will overwrite at next :17 cron fire)
**Phase:** Phase A in flight. A.1 + A.2 R2 polish + image library (A.2 extension) shipped this session. A.1.3 sub-boxes ticked through to where dev welld blocks further work.
**Health:** 🟡 Stable green; dev welld is broken (W.18 — first-boot DHCP timeout). Cells team unaffected (they're on stable :7878).

## TL;DR

The 14-item autonomous queue Pete left running overnight cleared. Eighteen W.* items shipped: R2 GC tests (W.1), `/healthz` pool block (W.9), `well exec --user=value` parser fix (W.17), the full image-library-on-R2 surface (W.3 design + W.4 push + W.5 pull + auto-pull on `well create`), pool-churn / wake-stress / concurrent-fork stress scripts (W.10/11/13), welld log audit + port-bind exit + watchdog backoff (W.12/19/20), test-isolation findings (W.15), `engine/lume.ts` → `engine/vwell.ts` + `vendor/lume/` → `engine/vwell-src/` rename (W.14 slices 1+2), create-warm long-tail diagnosis (W.6) → sysrq-s pre-halt + DHCP poll tightening (W.7+W.21). Plus the cells-team fork-empty-home false alarm (W.16) and the rinse doc note. **520/520 tests green throughout.**

The remaining work is gated on Pete unblocking dev welld (W.18). Once that lands, four smokes + the analyzer can run live: `smoke-r2-sync`, `smoke-wake-stress`, `smoke-pool-churn`, `exp-concurrent-fork`. The W.7+W.21 perf changes need a fresh batch of creates to verify the diskReleased + DHCP improvements.

## What changed since last steward fire

(First steward fire of the session. Counter-bumped by all 23 worker fires.)

- **Cells team work:** stable promoted twice — `wells-stable-2026-05-10a` (WS proxy 1011 fix) at 04:22 UTC, then `wells-stable-2026-05-10b` (lume supervisor adopted-gap fix) at 05:40 UTC. Both verified by cells team's repro. Worker also flagged the rinse-empty-home claim as misdiagnosed (cells team accepted; they're moving DNA out of `/home/` to `/cell/`). `well exec --user=cell` parser fix shipped.
- **A.2 R2 closure:** R2 GC tests filled the missing coverage; smoke-r2-sync.ts shipped (live-verify on W.18). Tick the MVP-PLAN A.2 GC box.
- **Image library on R2:** complete primitive — design doc + push + pull + auto-pull on `well create --from-image` when `WELL_R2_LIBRARY_*` env is set. Phase E multi-Mac Colony prerequisite.
- **/healthz `pool` block** shipped — cells team can now predict next-create latency without scraping the registry file.
- **Lume vendor cleanup** (W.14): `vendor/` is gone. Engine sources at `engine/vwell-src/`, wrapper at `engine/vwell.ts`, entitlements at `engine/well-engine.entitlements`. Only `bin/lume` rename left (deferred, Pete's call).
- **Welld robustness:** port-bind uncaught exception now exits instead of zombie-continuing (W.19); watchdog skips per-well hibernate after 5 consecutive failures (W.20).
- **Create p95 perf:** W.6 diagnosis named `diskReleased` (6.4s p95) as the long tail; W.7 ships sysrq-s pre-halt to give Apple's VZ less dirty data; W.21 drops DHCP poll from 2s → 500ms (~3s expected savings/create on the happy path). Both blocked on W.18 to verify.
- **Test isolation:** W.15 confirmed `bun test` (default sequential) is reliably 520/520; `--concurrent` not safe; documented + warned in `lib/checkpoints.test.ts` header.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **W.18 — dev welld DHCP timeout** | Lume layer corruption (theory: aftermath of 03:41 + 03:59 UTC lume hangs left vmnet bootp in a bad state). Stable unaffected. | Pete: try recipe 2 in `docs/findings-w18-dev-dhcp-timeout.md` (clean lume+welld restart), report back. |
| W.2 / W.7-verify / W.10 / W.11 / W.13 live runs | Need fresh creates against dev welld | Unblocks once W.18 does |

## Pete needs to decide

- **Stable promotion of W.7 + W.21 perf?** Both are behavior-only changes that should improve create p50 by ~3s (DHCP poll tightening) and p95 of `diskReleased` (sysrq-s pre-flush). Both verified safe by `bun test` but not live-tested yet. Could promote alongside the W.18 unblock for a "stable refresh that includes the perf wins" or wait until live-verified. **Recommendation:** wait — promote `wells-stable-2026-05-10c` only after `analyze-create-profile.ts` shows the new distribution.
- **Pete Loop runaway risk?** Auto-fired 22+ times this session. MAX_ITER=200 caps it; we're at ~10% of cap. No runaway concern, but review the throughput when convenient.
- **`bin/lume` → `bin/vwell` rename (W.14 slice 3)?** Defaulted to "deferred." Stable's wrapper depends on `splites/bin/lume.app/Contents/MacOS/lume`; rename forces a stable wrapper update + likely a stable promotion to keep cells team uninterrupted. Skip unless Pete asks.

## Cells team status

**Unblocked.** Both this session's stable promotions cleared the active issues they hit. The cells team is using stable :7878; dev welld's DHCP timeout (W.18) doesn't touch them. Their migration of DNA out of `/home/well/` to `/cell/` is in progress on their side (~2 hours grep-and-replace). Worker added cells-relevant additions to `docs/cells-integration.md`: healthz `pool` block + image library `push/pull` surface.

## Next planned cycle

Worker continues with low-priority cleanup / docs work until Pete returns and either unblocks W.18 (then five live-runs + verify-perf cascade) or redirects. Steward cron fires at :17 every 3 hours; this STATUS gets overwritten by the steward at its next fire.
