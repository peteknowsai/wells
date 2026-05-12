# splites — Current Status

**Updated:** 2026-05-12 ~21:30 UTC by `worker` (manual session, 1.0-prep day: ten chunks shipped from road-to-wells-1.0).
**Phase:** Phase A **formally closed 2026-05-12** (A.1.3 parent ticked, all sub-boxes a–g shipped). v0.2.0 squash-merged to `main` 2026-05-12 covers operational maturity, image substrate, static IPs. Next milestone: wells 1.0 (~2026-06-06 target).
**Health:** 🟢 Stable at `wells-stable-2026-05-11a`. Cells team V1 acceptance ran end-to-end at 17:45Z on 2026-05-11: **6 ✓** in their own scoring, **1 metric-fail** (V1.3 first-token — cells's metric, cells's call), **1 not-impl**, **1 blocked** on W.72 static IPs (V1.10 pool-depth-10 burst, unblocked by the 5/17 deploy). Boundary-cleanup bundle (W.72 + image alias + Piece 1 publisher-deletion + Piece 3 simplify-vm-creation + W.68 lease ownership) staged on `feature/phase-a` for 5/17 bounce — all gated behind `defaults.static_ip_range = null` + `hibernate_ready = false` so stable behaves unchanged until then.

## What changed since last STATUS (2026-05-11 ~09:05 UTC)

**v0.2.0 cut (2026-05-12).** `feature/phase-a`'s first wave squashed to main: dashboard live, publisher-deletion (Piece 1), W.72 static IPs three sub-slices, image alias system, Piece 3 simplify-vm-creation. Test suite 696 → 774 across the squash window.

**Cells V1 acceptance ran (2026-05-11 17:45Z).** End-to-end against `wells-stable-2026-05-11a`. Substrate side reports clean — the V1.3 first-token miss is in-cell (cells team's tuning, not wells's wire).

**Road-to-wells-1.0 doc landed (2026-05-12).** `docs/proposals/road-to-wells-1.0.html` — 5-phase plan with sized scope, Gantt, "Pete-owned" callout, DoD, after-1.0 section. Phase 1 (boundary sprint) on branch; Phase 2 (cells pool migration) blocked on cells team; Phase 3 (cleanup + Phase A residuals) drives this week's wells-side work; Phase 4 (rename + docs) Pete-owned + wells-docs; Phase 5 cuts 1.0.

**Five chunks shipped to main today (2026-05-12):**

- **A.1.3.c — Tier transition benchmarks** landed in `state-tiers.md` § Benchmarks. Hibernate p95 201ms / wake p95 829ms / cold create p95 17.4s / hibernate.bin ~28% of allocated RAM. Closes one Phase A residual.
- **A.1.3.g — Scenario coverage smoke + findings.** New `scripts/smoke-scenario-coverage.ts` (touch-aware, reads runtime.json from disk to avoid poisoning the watchdog), new `docs/findings-scenario-coverage.md` with full S1–S10 verdict (6 ✅, 2 ❌ documented gaps, 2 ⚠️ partial). Closes second Phase A residual. **A.1.3 parent ticked; Phase A formally closed.**
- **`docs/overview.md` — 1.0 reader tour.** Single-page intro: pitch, wells/cells boundary (codifies decision-ownership rule), components, state layout, REST surface, lifecycle, 1.0 vs 1.x scope, three-user SSH model. Layered (plain-English per section). Closes Phase 4 doc item.
- **`docs/install.md` pass.** Three corrections: three-user model (`cell` agent + `well` SSH + `ubuntu` debug; cells's birth flow goes through SSH-as-well + sudo-switch); verify example defaults to depth-1; replaced stale "cold-start ~5s" with measured wake-from-hibernate ~1s. Closes Phase 4 install-docs item (partial; fresh-Mac walkthrough deferred to rename + V1 acceptance).
- **Lume supervisor respawn-stats test coverage.** New `engine/lumeProcess.test.ts`: 14 tests pin window math + degraded-flag threshold. Closes "lume supervisor's respawn logic" item from MVP-PLAN's B.0 test-coverage backfill.
- **Daemon test scaffolding pattern.** New `lib/handlers/`: three welld handlers extracted to pure deps-injected orchestrators (`lifecycle.ts`, `hibernation.ts`, `getWell.ts`) with 29 unit tests covering 404 / verb dispatch / error mapping / vanished race / ordering. `wellResourceResponse` moved to `lib/apiResponse.ts` so handler imports don't pull the daemon's top-level side effects. Pattern is reusable for the rest of welld's handlers when gaps warrant.

**Test suite:** 707 → 820 (+113) green (sequential mode, ~4.0s).

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **Boundary-cleanup bundle deploys** (W.72 + image alias + W.68 + Piece 1 + Piece 3) | Scheduled for 5/17 bounce. Cells team mid-V1-acceptance + V1.10 pool burst awaits this deploy. | Pete: 5/17 bounce (or operationally any time stable is quiet) |
| **Pool code deletion (~1,100 LoC) from welld** | Gated on cells team's pool migration (Phase 2 of road-to-1.0, ~5/19–5/23). Can't delete what's still in use. | Cells team: Phase 2 completion |
| **splites → wells folder + GH repo rename** | Pete picked "next quiet window" (after bundle deploys + cells green). One focused session: folder, repo, hardcoded paths, plist, restart. | Pete: trigger when bundle is stable |
| **Final V1 acceptance run + 1.0 cut** | Cells team's scoring (their suite, their targets). Wells reports substrate-side latency / error-rate / concurrency wire; cells decides. | Cells team (acceptance), Pete (cut tag) |

## What's NOT stuck (cells team can use these now)

- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2).
- ✅ **Watchdog autosleep + wake-on-traffic** (post-reboot + clearLastTouched leak fix; sig-6 + welld-internal touches confirmed in A.1.3.g smoke).
- ✅ **Pool fast-path adopt + thaw primitive** (~481ms per concurrent thaw).
- ✅ **`well exec --user=cell`** + **`/etc/environment` --env propagation** + **`ServiceDefinition.user`**.
- ✅ **Local talk path** (proxy vhost dispatch on `<name>.cells.md`, depth-1 default).
- ✅ Concurrent fan-out up to N=4 fresh-creates; concurrent restoreState ceiling N=1 (serialized in `lib/thaw.ts`).

## Substrate facts (current measured)

| Metric | Value | Source |
|---|---|---|
| Create+warm p50 | 14.2s | 125 samples (74 stable + 51 dev) |
| Create+warm p95 | **17.4s** | `docs/findings-create-warm-distribution-2026-05-10.md` |
| `diskReleased` p95 | **4.5s** | Same |
| **Hibernate p95** | **201ms** | `docs/findings-wake-stress-2026-05-10.md` |
| **Wake p95** | **829ms** | Same |
| **SSH-after-wake p95** | **1147ms** | Same |
| `hibernate.bin` size | **~280MB for 1GB-allocated well** (sparse format, ~28% of RAM) | `docs/state-tiers.md` § Benchmarks |
| Concurrent-fork ceiling | **4** (vmnet bootp DHCP race at N≥5) | `docs/findings-concurrent-fork-crash.md` |
| Concurrent-restoreState ceiling | **1** (serialized at module level) | `docs/findings-thaw.md` |
| Test suite | **820/820 green** | `bun test` default sequential, ~4.0s |

## Pete needs to decide

- **5/17 bounce timing** — confirm the planned deploy window for the boundary-cleanup bundle. (Already pre-approved; question is just "go" vs "shift by a day if cells team needs the airspace.")
- **splites → wells rename timing** — picked "next quiet window"; trigger fires after bundle is stable + cells team's pool migration (Phase 2) progresses.

## Cells team status

V1 acceptance ran 2026-05-11 17:45Z (6 ✓ / 1 metric-fail / 1 not-impl / 1 blocked on W.72). Mid-tuning. Cells team's metric calls are theirs to make — wells's role is to surface substrate wire when asked (memory `feedback_decision_ownership`).

## Next planned cycle

Standing posture: hold the substrate, wait for 5/17 deploy, then start the pool-code deletion chunk after cells team's Phase 2 lands (~5/23). Until then: any unblocked 1.0 hardening (more B.0 test coverage; finding-docs hygiene; doc cross-link audit) is fair game. Architecture work (splites → wells rename) queued for Pete's quiet window.
