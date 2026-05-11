# splites — Current Status

**Updated:** 2026-05-11 ~08:35 UTC by `worker` (manual session post Pete Loop iter 145 stop, DHCP-leak end-to-end sprint).
**Phase:** Phase A in flight. A.1 (autosleep/wake/warm + pool) shipped + verified. A.2 (R2 sync) **fully closed**. A.3 (egress enforcement) DEFERRED 2026-05-11 — no concrete consumer.
**Health:** 🟢 Stable at `wells-stable-2026-05-11a`. Cells team P1.3 birth flow GREEN since 2026-05-10 21:32Z; they're mid-burst-test now on cells side (P1.4-P1.16). Wake works, hibernate works, talk smoke green. **Bundle 4-deep awaiting cells's restart signal**: W.14 slice 3 + W.65 + W.66 + W.67.

## TL;DR

Past ~24h shipped end-to-end resolution of the DHCP-lease-leak that cells team surfaced 06:28Z: **W.63** (visibility — orphan count in /healthz), **W.64** (privileged helper + auto-release on destroy, narrow sudoers, mkdir-lock for macOS), **W.65** (startup resurrection — wells whose prior state was alive_* get cold-started on welld bounce, makes Tier 4 birth wedge durable), **W.30** re-bake (lean ubuntu-25.10-base shipped as `wells-stable-2026-05-11a`), **W.66** (failure-path lease release in poolFill + handleCreateWell), **W.67** (orphan-only flush — `/flush` no longer nukes legit running wells' leases; pre-W.67 bug in orphan calc fixed too — now correctly excludes pool members + adopted lume_name entries). Three Pete decisions resolved 2026-05-11: W.22 killed (steward role gone), W.14 slice 3 shipped (`bin/lume` → `bin/vwell`), A.3 deferred. **W.68 queued for next sprint**: welld-owns-leases architecture — replaces the whack-a-mole with a single invariant guardian (welld publishes lease entries on alive transitions + ~10s safety sweep; lease file becomes a derived artifact). Test suite 600 → 707 green.

## What changed since last STATUS (12:30 UTC)

- **15:10 UTC** — Cells team P1.3 unblock bundle: `--env` propagation to `/etc/environment`, `ServiceDefinition.user` field, `well exec --user=<u>` via SSH-as-well + sudo-switch, `well exec --tty` passes through sudo. 539/539 tests green.
- **14:50 UTC** — **W.2 R2 round-trip smoke verified live.** 41:18 wall-clock end-to-end on a 50GB sparse disk, sha match. Three plumbing fixes: r2.ts 16MB partSize (S3 multipart cap), async R2 upload (Bun.serve idleTimeout), client-side R2 download via S3Client. MVP-PLAN A.2 ticked.
- **~21:00-21:32 UTC** — 4-fix sprint over `/tmp/cells-wells-chat/`: cells P1.3 birth flow goes from "cell-base broken" to "talk smoke GREEN" in ~25 min. Bundle promoted to `wells-stable-2026-05-10g` (machine-id rinse fix), then `-10h` (clearLastTouched + watchdog state). Plist flipped to `WELL_PUBLIC_BASE=cells.md`.
- **04:00-05:35 UTC (2026-05-11)** — Pete Loop iter 1-10, worker tidy-up + test-backfill sprint:
  - **W.28** — Dropped bun + pi from `templates/cloud-init-base.yaml` (cells now owns the agent stack via their commit `3fde0c8`).
  - **W.29** — Ripped grub `random.trust_cpu=on` dead code (proved triple-no-op on ARM by cells's audit).
  - **W.32** — Ticked stale MVP-PLAN checkboxes (B.0.9.c absorbed by .d.4.e + W.10; B.0.9.d.2 absorbed by warming sequence; B.0.11.d resolved by W.13).
  - **W.33** — `buildWellSeed` hdiutil round-trip tests (3 tests) verifying `etc-environment.append` conditional staging.
  - **W.34** — Backfilled `clearLastTouched` tests (4 tests) covering the exact watchdog state-leak regression.
  - **W.35** — `resolve.ts` readWellPin coverage (7 tests).
  - **W.36** — `apiClient.ts` test coverage via real Bun.serve (11 tests).
  - **W.37** — `diskReleased.ts` real-subprocess test coverage (4 tests).
  - **W.38** — `identityReset.ts` source-read contract tests (12 tests).
  - **W.39** — Schema test coverage for `NetworkRule`/`NetworkPolicy*`/`ServiceDefinition`/`ExecRequest` (19 tests, including the just-shipped optional `user` field).
- **Test suite**: 532 → 600/600 green (+68 tests across W.33-W.39).

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **Welld restart deploys the 4-patch bundle** (W.14 slice 3 + W.65 + W.66 + W.67) | Cells team mid-burst-test (07:45Z: "hold off on the restart"). Bundle ready to deploy in one bootout+bootstrap+kickstart. | Cells team: ping when between phases |
| **W.68 — Welld owns lease entries architecture** | Design captured; ~2 day focused build. Best ordered after the 4-patch bundle deploys + verifies green, or coded in parallel and bundled into a single 5-patch deploy. | Pete: pick "start now" vs "wait for bundle deploy first" |
| **splites → wells folder + GH repo rename** | Pete picked "next quiet window" (after bundle deploys + cells green). One focused session: folder, repo, hardcoded paths, plist, restart. | Pete: trigger when bundle is stable |

## What's NOT stuck (cells team can use these now)

- ✅ Bake → save (validate=true) → fork: writes survive (graceful-stop fix) + forks no longer trigger sshd-keygen.service (machine-id rinse fix).
- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2).
- ✅ `cells bake` flow + R2 image library (W.3+W.4+W.5).
- ✅ Concurrent fan-out up to N=4 fresh-creates.
- ✅ **Watchdog autosleep + wake-on-traffic** (post-reboot + clearLastTouched leak fix).
- ✅ **Pool fast-path adopt + thaw primitive**.
- ✅ **`well exec --user=cell`** + **`/etc/environment` --env propagation** + **`ServiceDefinition.user`**.
- ✅ **Local talk path** (proxy vhost dispatch on `<name>.cells.md`).

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
| Test suite | **707/707 green** | `bun test` default sequential |

## Pete needs to decide

- **W.68 start timing** — code in parallel + bundle into a single 5-patch deploy, OR wait for the 4-patch bundle to deploy + verify green before starting.
- **splites → wells rename timing** — already picked "next quiet window"; trigger fires after bundle is stable.

## Cells team status

**Mid-burst-test on cells side.** 07:45Z: phase_a_ms 640 → 17 (38x), cell first-token at 993ms via deepseek-flash. That's the magic-moment metric — Tier 4 birth wedge working end-to-end. Asked us to hold the welld restart until they're between phases. 08:03Z surfaced the /flush running-collateral bug → W.67 shipped at 08:30Z in response. Chat monitor armed; waiting on their next ping.

## Next planned cycle

Manual session (Pete Loop stopped at iter 145). Standing posture: wait for cells's restart signal → deploy bundle → verify green → either start W.68 or wait per Pete's call. Architecture work (W.68 + splites→wells rename) queued for the post-bundle quiet window.
