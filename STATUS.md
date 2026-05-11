# splites — Current Status

**Updated:** 2026-05-11 ~05:35 UTC by `worker` (Pete Loop iter 10/200, post-P1.3-unblock + W.28-W.39 tidy-up sprint).
**Phase:** Phase A in flight. A.1 (autosleep/wake/warm + pool) shipped + verified. A.2 (R2 sync) **fully closed** — round-trip smoke green 14:50 UTC. A.3 (egress enforcement) DEFERRED 2026-05-11 — no concrete consumer.
**Health:** 🟢 Stable at `wells-stable-2026-05-10h`. Cells team P1.3 birth flow end-to-end GREEN as of 21:32 UTC yesterday; they're now in P1.4-P1.16 + P1b smoke matrix. Wake works, hibernate works, talk smoke green.

## TL;DR

Cells team's P1.3 birth flow lit up end-to-end 2026-05-10 21:32 UTC after a 4-fix sprint over the shared chat channel: (1) `--env` propagation to `/etc/environment`, (2) rinse no longer wipes `/etc/machine-id` (which was triggering `sshd-keygen.service`'s `ConditionFirstBoot=yes` on Apple VZ guests at cold-boot entropy), (3) `clearLastTouched` on well create+destroy (watchdog state leak — 6s auto-hibernate after birth), (4) `WELL_PUBLIC_BASE=cells.md` plist flip for cert coverage. After cells went green I shipped 8 worker tidy-up + test-backfill commits (W.28-W.39); test suite now at 600/600 green (was 540 at start of session). Chat-channel monitor remains armed for cells's P1.4-P1.16 work.

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
| **W.30 — Re-bake leaner `ubuntu-25.10-base` + stable promotion** | Substrate code drops bun/pi/grub-dead-code; needs re-bake to take effect on disk. Stable promotion timing is Pete's call (don't mid-cells-team-sprint). | Pete: pick a moment when cells team is between phases |
| **W.14 slice 3 (`bin/lume` → `bin/vwell` rename)** | Forces a stable wrapper update + probably a stable promotion. Low value. | Pete: opt in or close |

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
| Test suite | **600/600 green** | `bun test` default sequential |

## Pete needs to decide

- **W.30 stable promotion timing** for the leaner base image (drops bun/pi/grub-dead-code).
- **W.14 slice 3 (`bin/lume` → `bin/vwell` rename).** Defaulted to deferred.

## Cells team status

**Marching on P1.4-P1.16 + P1b smoke matrix.** P1.3 birth flow is green end-to-end. Shared chat channel `/tmp/cells-wells-chat/` monitor remains armed; cells's last message at 21:32Z: "ping when something else breaks." No incoming since.

## Next planned cycle

Pete Loop continues fire-by-fire. Worker has been grinding test backfill + tidy-up since cells team went green; will keep going until a cells-team-surfaced issue arrives, a Pete decision unblocks one of the stuck items, or hits MAX_ITER=200.
