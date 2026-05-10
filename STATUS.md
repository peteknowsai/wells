# splites — Current Status

**Updated:** 2026-05-10 (post-cells-debug) by `pete+claude` — graceful-stop fix shipped, `wells-stable-2026-05-10c` cut and pushed, splites-stable worktree moved.
**Phase:** Phase A in flight. A.1 + A.2 + image library shipped this session. **Cells team's bake unblocks now** — graceful stop preserves post-boot writes through both `stop+restart` and `save+fork`.
**Health:** 🟢 Stable refreshed at `wells-stable-2026-05-10c`. Dev welld came back when stable+dev welld were restarted with patched lume binary (W.18 was the same lume corruption that the restart cleared).

## TL;DR

Cells team caught the smoking gun on their side: image save → fork was dropping every post-boot write. Diagnosed on the wells side: `lume.stop()` was Apple's forceful "pull the cord" stop, never `requestStop()` (which doesn't even exist in lume's source). Patch lands ACPI-shutdown via `requestStop()` → poll until `.stopped` → 30s timeout fallback. Smoke verified end-to-end on dev: write `/cell/marker.txt` → `well stop` → `well start` → marker survives; same well → `well image save` (validate=true) → fork → marker survives in fork. Stable promoted to `wells-stable-2026-05-10c` and the splites-stable worktree moved. **520/520 tests green.** See `docs/findings-graceful-stop.md`.

Earlier this session: 18 W.* items shipped — R2 GC tests (W.1), `/healthz` pool block (W.9), `well exec --user=value` parser fix (W.17), the full image-library-on-R2 surface (W.3+W.4+W.5), pool-churn / wake-stress / concurrent-fork stress scripts (W.10/11/13), welld log audit + port-bind exit + watchdog backoff (W.12/19/20), test-isolation findings (W.15), `vendor/lume/` → `engine/vwell-src/` rename (W.14 slices 1+2), create-warm long-tail diagnosis (W.6) → sysrq-s pre-halt + DHCP poll tightening (W.7+W.21).

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
- **Pete Loop hit MAX_ITER=200 and auto-stopped.** Iterations 40-200 were no-ops (chat-only, mostly no commits) — the substantive worker queue exhausted at iteration 39. The auto-stop validates the safety cap; no operator intervention required to halt the loop.
- **W.22 — steward cron starvation, RESOLVED-by-side-effect.** Pete Loop's MAX_ITER cap-out cleared the active flag, REPL went idle, this steward cron fire happened. The architectural fix (integrate steward into worker, or pause the Stop hook around steward fire times) is still worth doing but no longer urgent — the natural cap-out gives a steward window every ~200 fires. Leaving W.22 on BOARD with `decision-needed` for Pete to weigh in on the proper fix.
- **`bin/lume` → `bin/vwell` rename (W.14 slice 3)?** Defaulted to "deferred." Stable's wrapper depends on `splites/bin/lume.app/Contents/MacOS/lume`; rename forces a stable wrapper update + likely a stable promotion to keep cells team uninterrupted. Skip unless Pete asks.

## Cells team status

**Unblocked.** Both this session's stable promotions cleared the active issues they hit. The cells team is using stable :7878; dev welld's DHCP timeout (W.18) doesn't touch them. Their migration of DNA out of `/home/well/` to `/cell/` is in progress on their side (~2 hours grep-and-replace). Worker added cells-relevant additions to `docs/cells-integration.md`: healthz `pool` block + image library `push/pull` surface.

## Next planned cycle

Worker continues with low-priority cleanup / docs work until Pete returns and either unblocks W.18 (then five live-runs + verify-perf cascade) or redirects. Steward cron fires at :17 every 3 hours; this STATUS gets overwritten by the steward at its next fire.
