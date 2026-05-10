# splites — Board

Convention: tasks have IDs `W.{n}` for worker-queue items that don't map to a specific MVP-PLAN checkbox; `phase X.Y.Z` for items that map directly to a checkbox in `docs/MVP-PLAN.md` (close them in MVP-PLAN as part of the same commit). Owner: `worker`, `steward`, or `pete`. Tags: `cells-coordination`, `lume-vendor`, `code`, `docs`, `cost-approval-needed`, `decision-needed`, `needs-pete-session`.

> **State as of 2026-05-10 ~10:30 UTC (steward):** Pete Loop hit MAX_ITER=200 and auto-stopped. Substantive work shipped in iters 1-22; iters 23-200 were no-ops awaiting Pete decisions. Stable lives at `wells-stable-2026-05-10d` (graceful-stop + plist PATH + images shape + pool zombie auto-prune). 532/532 tests green. **W.27 (wake regression — VZ "permission denied" on every restoreState) is the load-bearing blocker** — gates W.10/W.11/W.26-thaw-end-to-end live. **W.2 (R2 round-trip smoke) is blocked on a bucket-scoped R2 token.** **W.22 (steward starvation) was resolved by side effect** — Pete Loop's auto-stop at MAX_ITER opened the idle window the cron needed; this steward fire is the first concrete proof the cap-out architecture works.
>
> **Pete pre-approved shipping without gates** + granted access to `cf` + `wrangler` CLIs (account PKAI, `5a6fef07a998d84ec047ef43d0543342`).

---

## In Progress

_(none — worker hit MAX_ITER and auto-stopped; queue is steady-state)_

---

## Todo (priority order)

### Tech debt + investigations

- [ ] **W.14 — Lume vendor cleanup (only slice 3 left, low value — leave for Pete to call).** Slice 1 + slice 2 shipped 2026-05-10 (commits `831f935`, `ea69e3d`). What's done: `engine/lume.ts` → `engine/vwell.ts`; `vendor/lume/` → `engine/vwell-src/`; entitlements + LICENSE + .txt moved out of vendor; build-lume.sh, .gitignore, all live docs updated; vendor/ removed. **Remaining:** rename `bin/lume` → `bin/vwell`. Low value — `splites-stable/bin/lume` is a wrapper that execs `splites/bin/lume.app/Contents/MacOS/lume`, so renaming forces a stable wrapper update too (+ probably a stable promotion to keep cells team uninterrupted). Defer until Pete asks for it. Owner: `pete`. Tags: `code`, `lume-vendor`.

---

## Blocked

- **W.27 — Wake regression: VZ "permission denied" on every restoreState.** Owner: `pete` (needs-pete-session: host reboot). Surfaced 2026-05-10 09:00 UTC. Every `well wake` / `from_thaw` / `lume.restoreState` fails with "permission denied" inside Apple's framework, AFTER lume's diagnostic checks pass (save+restore snapshot match, files readable, entitlements present). Last known good wake: 04:02 UTC. **Graceful-stop revert HYPOTHESIS RULED OUT** (tested 09:11 UTC: revert + rebuild + dev welld+lume restart → wake still fails). The regression is below us in the stack — Apple's VZ daemon, TCC, or accumulated lume process state across this session's many killAndRestart cycles. Live-impact: smoke-wake-stress run shows 0/30 cycles complete (`docs/findings-wake-stress-2026-05-10.md`). **Recommended next step (Pete):** test wake on stable directly to localize, then host reboot if still broken. Reverting graceful-stop does NOT help and would re-break cells's bake — leaving graceful-stop in place. Tags: `needs-pete-session`, `cells-coordination`, `lume-vendor`.

- **W.2 — A.2 R2 round-trip smoke.** Owner: `pete`. Smoke script (`scripts/smoke-r2-sync.ts`, commit `0df2d1c`) shipped — 226 lines, end-to-end create-checkpoint-verify-delete-restore-sha256 flow against dev welld with bucket `wells-smoke-r2`. **No longer blocked on W.18** (graceful-stop welld restart cleared the lume corruption) and the `disk:"10GB"` shrink bug is fixed. Active blocker: R2 bucket-scoped token returning `Access Denied` on `wells-smoke-r2`. **Pete unsticks:** mint a bucket-scoped token in the Cloudflare console + confirm the bucket exists. Tags: `needs-pete-session`.

- **W.22 — Pete Loop steward-cron starvation (resolved-by-side-effect, decision-needed for durable fix).** Pete Loop's Stop hook re-injects the worker prompt at end of every turn, so the REPL is never "idle" and CronCreate jobs only fire when idle. The every-3h steward cron (set up 06:00 UTC) didn't fire once during the 200-iter worker run. **Resolved-by-side-effect:** Pete Loop's MAX_ITER=200 auto-stop opened the idle window — this steward fire is the first concrete proof the cap-out architecture works. **Durable fix space:** (a) integrate steward INTO the worker — every Nth fire becomes a steward fire; (b) modify the Stop hook to skip re-inject if the next steward fire is within ~5 min; (c) accept the natural cap-out window as the steward cadence (every ~200 fires ≈ ~17 wall-clock-hours). **Recommendation:** option (c) — zero engineering, predictable cadence, and the 200-fire window is roughly daily-ish for typical loop pacing. Owner: `pete` (architectural call). Tags: `decision-needed`.

---

## Done

_Recently shipped (last ~24h). Older items live in git log + `docs/cells-integration.md` Promotions table._

- [x] **2026-05-10 09:36 UTC** — **W.26 — Thaw primitive shipped (code complete, end-to-end blocked on W.27).** `lib/thaw.ts` + `POST /v1/wells {name, from_thaw}` + `well create --from-thaw=<src>` mirror the existing `from_image` shape. Bundle materialization copies src's config.json, nvram.bin, disk.img, hibernate.bin, AND `hibernate.config.json` (with path-rewrite from src's name → cln's name; JSON has escaped slashes, both `/<src>/` and `\/<src>\/` forms covered). MAC mutation rejected — VZ requires byte-identical config.json at restoreState. Concurrency serialized through a module-level promise chain (Phase 2 verdict: lume's restoreState ceiling is 1; concurrent callers `Promise.all` and trust wells to serialize). Fire 5's first thaw worked end-to-end (HTTP 201 + status running) — proves the design. Subsequent thaw attempts hit W.27 wake regression. Findings: `docs/findings-thaw.md`. Cells team can use thaw API once W.27 clears.
- [x] **2026-05-10 09:33 UTC** — **W.13 — Concurrent-fork ceiling = 4.** Ran `scripts/exp-concurrent-fork.ts --range=2,3,4,5,6` end-to-end on dev. Verdict: lume itself is stable at all tested N (PID never changed, zero respawns, no hang dumps). The actual ceiling is **vmnet's DHCP**: N=4 all succeed cleanly (~12s each), N=5 has 1 DHCP timeout, N=6 has 2 timeouts. Failure mode is parallel-bootp-race in vmnet's bootpd; lume + welld + VZ handle the fan-out fine. Cells team can fan-out up to 4 concurrent fresh-creates without partial-failure mitigation; ≥5 needs either serialization or a tolerated-failure pattern. Findings: `docs/findings-concurrent-fork-crash.md`.
- [x] **2026-05-10 09:15 UTC** — **W.7 — sysrq-s + DHCP poll perf wins verified live.** Generated 5 fresh creates on dev :7879 (post-graceful-stop binary, post-W.21 DHCP poll tightening), re-ran `scripts/analyze-create-profile.ts` against stable + dev welld.log (125 total samples, 51 from this fresh batch). **Headline:** total create p95 dropped 27.1s → **17.4s** (-9.7s, -36%). `diskReleased` p95 dropped 6.4s → **4.5s** (-1.9s, -30%) — sysrq-s pre-flush helps Apple's VZ flush less post-halt. Findings updated: `docs/findings-create-warm-distribution-2026-05-10.md`.
- [x] **2026-05-10 08:25 UTC** — **W.23 (cells-team) — Pool registry zombie cleanup + drain --all.** `prunePoolZombies()` runs at welld startup before the filler initializes — walks registry, drops members where `bundleDir(name)` is missing on disk, logs each prune as `warn`. `well pool drain --all` (and `?all=true` query param) drops every member regardless of state. Three new tests in `lib/poolFiller.test.ts`. **Live-verified 09:36 UTC:** synthetic zombie pruned at startup; registry cleared.
- [x] **2026-05-10 08:15 UTC** — **W.25 (cells-team) — `GET /v1/wells/images` shape-failure tolerance.** `handleListImages` per-entry validates against `ImageResource`, drops malformed entries with a warn log (name + first 3 errors), returns the rest. Cells's `cmdBake` `.catch(() => null)` no longer collapses on a single drifted meta. New regression test in `lib/imageStore.test.ts`.
- [x] **2026-05-10 08:00 UTC** — **W.24 (cells-team) — Launchd plist PATH includes `/usr/sbin`.** `scripts/welld.plist.template` PATH now includes `/usr/sbin:/sbin` so `lib/diskReleased.ts` and `lib/createWell.ts` can find `lsof` on launchd-started welld instances.
- [x] **2026-05-10 07:50 UTC** — **`wells-stable-2026-05-10c` graceful-stop fix.** Cells team's NEEDS_PETE.md ping #2 was right — wells's `lume.stop()` was Apple's forceful `VZVirtualMachine.stop()` ("pull the cord"), dropping in-flight VirtIO writes before host fsync. Patch routes through `requestStop()` (ACPI), polls state→.stopped (200ms intervals, 30s timeout), forceful fallback. Smoke verified end-to-end on dev: writes survive stop+restart and save+fork. W.18 (dev DHCP timeout) cleared as a side effect — was the same lume corruption. Findings: `docs/findings-graceful-stop.md`.
- [x] **2026-05-10 08:55 UTC** — **W.21 — Tighten DHCP poll interval (createWell.ts).** Dropped `waitForDhcpLease`'s polling interval from 2000ms → 500ms.
- [x] **2026-05-10 08:45 UTC** — **W.7 — Shipped sysrq-s pre-flush in warming halt.** Both `lib/createWell.ts` and `lib/poolFill.ts` now do `sudo sync && echo s | tee /proc/sysrq-trigger && echo o | tee /proc/sysrq-trigger`.
- [x] **2026-05-10 08:35 UTC** — **W.6 — Create+warm long tail diagnosed from historical logs.** Built `scripts/analyze-create-profile.ts`. Total create p50=14.5s, p95=27.1s, p99=83.7s. Long-tail phase is `diskReleased` (6.4s p95) — not lume @MainActor. W.7 redirected at the right phase.
- [x] **2026-05-10 08:25 UTC** — **W.13 — Concurrent-fork experiment shipped (script).** New `scripts/exp-concurrent-fork.ts` (~360 lines).
- [x] **2026-05-10 08:10 UTC** — **W.11 — Pool churn smoke shipped.** New `scripts/smoke-pool-churn.ts` (~270 lines).
- [x] **2026-05-10 08:00 UTC** — **W.10 — Wake reliability stress smoke shipped.** New `scripts/smoke-wake-stress.ts` (~330 lines). Live-verified during this session: produced `docs/findings-wake-stress-2026-05-10.md` (0/30 cycles passed — surfaces W.27 directly).
- [x] **2026-05-10 07:50 UTC** — **W.14 slice 2 — `vendor/` is gone.**
- [x] **2026-05-10 07:35 UTC** — **W.14 slice 1 — `engine/lume.ts` → `engine/vwell.ts`.**
- [x] **2026-05-10 07:25 UTC** — **W.19 + W.20 — both audit follow-ups shipped.** `uncaughtException` exits on port-bind failure; watchdog backs off after 5 consecutive hibernate failures.
- [x] **2026-05-10 07:15 UTC** — **W.12 — welld log audit done.**
- [x] **2026-05-10 07:05 UTC** — **W.15 — Test isolation flakies, investigated.** Default `bun test` reliably 520/520; `--concurrent` not safe.
- [x] **2026-05-10 06:55 UTC** — **W.5 — Image library pull half + auto-pull on create.**
- [x] **2026-05-10 06:42 UTC** — **W.4 — Image library push half.**
- [x] **2026-05-10 06:32 UTC** — **W.3 — Image library on R2: design shipped.** `docs/proposals/image-library-on-r2.md`.
- [x] **2026-05-10 06:25 UTC** — **W.18 — investigated to a clear blocker (resolved by graceful-stop ship).**
- [x] **2026-05-10 06:18 UTC** — **W.8 — MVP-PLAN § A.1.3 audit.**
- [x] **2026-05-10 06:13 UTC** — **W.17 — `well exec --user=<user>` equals-syntax (cells team).**
- [x] **2026-05-10 06:08 UTC** — **W.9 — `/healthz` exposes pool depth.**
- [x] **2026-05-10 06:10 UTC** — **W.16 — fork-empty-home rinse claim resolved by cells team.**
- [x] **2026-05-10 05:45 UTC** — **W.1 — A.2 R2 GC tracks local retention.**
- [x] **2026-05-10 05:40 UTC** — Stable promoted to `wells-stable-2026-05-10b` (lume supervisor adopted-gap fix).
- [x] **2026-05-10 04:22 UTC** — WS proxy 1011 fix shipped + promoted to `wells-stable-2026-05-10a`.
- [x] **2026-05-09** — A.1 phase fully shipped (pre-warmed pool, sub-3s `well create`, `well pool` CLI + REST). Promoted to `wells-stable-2026-05-09j`.
