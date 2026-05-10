# splites — Board

Convention: tasks have IDs `W.{n}` for worker-queue items that don't map to a specific MVP-PLAN checkbox; `phase X.Y.Z` for items that map directly to a checkbox in `docs/MVP-PLAN.md` (close them in MVP-PLAN as part of the same commit). Owner: `worker`, `steward`, or `pete`. Tags: `cells-coordination`, `lume-vendor`, `code`, `docs`, `cost-approval-needed`, `decision-needed`, `needs-pete-session`.

> **State as of 2026-05-10 04:40 UTC:** Cells team unblocked (WS proxy 1011 fix promoted to `wells-stable-2026-05-10a`). 14-item autonomous queue, ~20 hr of runway. **Pete pre-approved shipping without gates** + granted access to `cf` + `wrangler` CLIs (account PKAI, `5a6fef07a998d84ec047ef43d0543342`). Worker can create smoke-only R2 buckets, ship image library, ship lume `@MainActor` fix without checking in.

---

## In Progress

_(empty)_

---

## Todo (priority order)

### A.2 R2 polish (Pete's #1)

- [ ] **W.1 — A.2 R2 GC tracks local retention.** When local checkpoint retention rotates a checkpoint out, also remove the corresponding R2 object. New env `WELL_R2_RETAIN_FOREVER=1` to keep R2 forever (matches the existing MVP-PLAN A.2 box). Touches `lib/checkpoints.ts` retention path + `lib/r2.ts` delete; add 2-3 tests covering rotate-with-r2, rotate-without-r2, and the retain-forever opt-out. **Closes:** `docs/MVP-PLAN.md` § A.2 — "R2 GC tracks local retention." Owner: `worker`. Tags: `code`.

- [ ] **W.2 — A.2 R2 round-trip smoke.** New `scripts/smoke-r2-sync.ts` that creates a checkpoint with R2 configured, verifies the R2 object lands, deletes the local checkpoint, restores from R2, verifies disk integrity (sha256 match). Run against dev welld :7879. **Closes:** `docs/MVP-PLAN.md` § A.2 — "Smoke: round-trip." Owner: `worker`. Tags: `code`. **R2 setup**: create smoke-only bucket via `wrangler r2 bucket create wells-smoke-r2`, mint scoped key via `wrangler r2 bucket api-token create wells-smoke-r2-key --bucket wells-smoke-r2 --permission 'admin-read-write'`. Tear down at end of smoke (delete bucket + revoke key) so we don't accumulate orphan creds.

### Quick wins

- [ ] **W.8 — Audit `docs/MVP-PLAN.md` § A.1.3 cleanup.** Several A.1 sub-items shipped via B.0.9 work but the boxes weren't ticked. Walk § A.1.3 and tick anything that's actually done. Doc-only, ~30 min. Owner: `worker`. Tags: `docs`.

- [ ] **W.9 — `/healthz` exposes pool depth.** Currently `/healthz` returns lume + vz_xpc_count + degraded. Add a `pool` block: `{target_size, ready_count, provisioning_count, warming_count, adopting_count}`. Cells team monitoring will use it to know whether their next `well create` will pool-adopt or fall through to fresh-create. Touches `daemon/welld.ts` healthz handler + a `lib/poolRegistry.ts` summary helper. Tests: extend the existing healthz tests with a pool-block case. ~30 min. Owner: `worker`. Tags: `code`.

### Lume @MainActor variance (Pete's #3) + supporting smokes

- [ ] **W.6 — Lume `@MainActor` variance — diagnose.** Per `docs/MVP-PLAN.md` § B.0.9.d.5.b residual: ~20% of smoke cycles bump 15-15.5s on create+warm because lume's MainActor still occasionally hangs even after B.0.11.h. First fire: instrument `lib/createWell.ts` with per-phase timing logs (clonefile, lume.create, lume.start, waitForDhcpLease #1, waitForSshReady #1, sysrq+disk-release, lume.start #2, waitForDhcpLease #2, waitForSshReady #2). Subsequent fires: run a 50-cycle stress against dev welld :7879, capture distribution to `docs/findings-create-warm-distribution.md`, identify which phase has the long tail. May require lume-side `sample` captures during slow cycles. Owner: `worker`. Tags: `code`, `lume-vendor` (if a fix requires lume changes). **Don't ship a lume patch this fire** — fix scope decided after diagnosis.

- [ ] **W.10 — Wake reliability stress smoke.** Today `scripts/smoke-hibernate-wake.ts` runs 3 cycles. New `scripts/smoke-wake-stress.ts` runs 30+ hibernate→wake cycles back-to-back, captures per-phase timing distribution (hibernate ms, wake ms, ssh-after-wake ms), asserts on p50/p95/p99 thresholds, writes results to `docs/findings-wake-stress-2026-05-10.md`. Will surface lume `@MainActor` variance more cleanly than W.6's create+warm path; data feeds back into W.6/W.7. Run against dev welld :7879. ~2 hr. Owner: `worker`. Tags: `code`.

- [ ] **W.11 — Pool-depth maintenance under churn smoke.** Today `scripts/smoke-warm-pool.ts` is single-cycle. New `scripts/smoke-pool-churn.ts` sets `pool_size=2`, drives 20 back-to-back `well create` + `well destroy` cycles, asserts the filler keeps pool depth stable across the churn (no race conditions in `triggerFillIfNeeded` + the housekeeping tick). Bonus: parallel fan-out test (3 concurrent creates → assert pool drains then refills correctly). Surfaces the kind of race we'd hit in production if cells team scales fan-out. ~2 hr. Owner: `worker`. Tags: `code`.

### Image library on R2 (Pete's #2 — W.3 → W.4 → W.5)

- [ ] **W.3 — Image library on R2: design.** Write `docs/proposals/image-library-on-r2.md` covering bucket layout (`<bucket>/images/<image-name>/{disk.img, meta.json, manifest.json}`), versioning (manifest-based or content-hashed?), credentials story (per-image or per-Mac?), CLI surface (`well image push <name>`, `well image pull <name>`, `well image list --remote`), security boundary (a base image is a fresh boot disk — anyone with bucket read can boot it), Phase E fit. Pete pre-approved shipping; W.4/W.5 follow without a review gate. ~1 hr. Owner: `worker`. Tags: `docs`.

- [ ] **W.4 — Image library on R2: push half.** Implement `well image push <name>` per W.3's design. Streams `disk.img` to R2, writes meta.json, updates a remote manifest. Use `wrangler r2 bucket create wells-images` (or whatever W.3 picks) + scoped key for this. Owner: `worker`. Tags: `code`. **Depends on:** W.3.

- [ ] **W.5 — Image library on R2: pull half.** Implement `well image pull <name>` + implicit-pull during `well create --from-image` when missing locally. Owner: `worker`. Tags: `code`. **Depends on:** W.4.

### Lume variance fix (depends on W.6 findings)

- [ ] **W.7 — Lume `@MainActor` variance — fix or escalate.** Based on W.6 findings: ship a targeted fix (probably async probe machinery instead of bounded blocking) OR write `docs/findings-lume-mainactor-variance.md` if scope is bigger than a fire (e.g., needs lume-side architectural change). Pete pre-approved shipping; no need to escalate the fix approach unless it's truly a multi-day vendor patch. Owner: `worker`. Tags: `code`, `lume-vendor`. **Depends on:** W.6.

### Tech debt + investigations

- [ ] **W.12 — welld unhandled-rejection log audit.** Welld's process-level `unhandledRejection` + `uncaughtException` handlers log+continue (per `daemon/welld.ts:140`). Walk the last week of `~/.wells/welld.log` + `/tmp/welld-*.log`, classify recurring patterns (lume timeouts, ssh subprocess errors, R2 upload failures), and decide for each: (a) genuinely safe to swallow, (b) should propagate as a 500 instead of being swallowed, or (c) is a real bug worth filing. Output: `docs/findings-welld-rejection-audit-2026-05-10.md` with classification + recommendations. Code changes follow as separate fires for each "real bug" found. ~1-2 hr. Owner: `worker`. Tags: `docs`.

- [ ] **W.13 — B.0.11.d — Investigate concurrent fork lume crash.** Open MVP-PLAN box: three concurrent `well create --from-image` triggered "lume serve unresponsive; respawning" + the in-flight forks hung. Write `scripts/exp-concurrent-fork.ts` that drives N parallel forks against dev welld :7879, captures the crash signature (lume PID, `sample` output, last-N lines of lume log), tries N ∈ {2, 3, 4, 5} to find the threshold. Output: `docs/findings-concurrent-fork-crash.md` with verdict — bundle-creation race, VZ.framework constraint, or something else. **Closes:** `docs/MVP-PLAN.md` § B.0.11.d. ~3-4 hr. Owner: `worker`. Tags: `code`, `lume-vendor`.

- [ ] **W.14 — Lume vendor cleanup** (`vendor/lume.patches/` drop ± rename). Project CLAUDE.md TODO: "rename `vendor/lume/` → its own top-level dir under a wells-namespaced name … and either drop `vendor/lume.patches/` or move all in-tree edits there." Decision pending from Pete on whether to rename + what to call it (themed name vs "wells engine" vs leave alone). **Don't pick this fire up tonight** until Pete answers. When unblocked: at minimum, drop `vendor/lume.patches/` (dead code per CLAUDE.md — patches are in-tree). The rename portion follows Pete's pick. Owner: `worker`. Tags: `code`, `lume-vendor`, `decision-needed`. **Blocked on:** Pete's pick on the rename name.

---

## Blocked

_(empty — items move here when worker reaches them and finds an unmet gate)_

---

## Done

_Recently shipped (last ~24h). Older items live in git log + `docs/cells-integration.md` Promotions table._

- [x] **2026-05-10 04:22 UTC** — WS proxy 1011 fix shipped + promoted to `wells-stable-2026-05-10a`. `lib/proxy.ts:buildUpstreamWsInit` forwards client headers + subprotocols to upstream WS. Cells team `cells talk` repro unblocked. Commits: `9c7a34c`, `59b2941`, `3477980`, `41d92ab`. See `docs/cells-integration.md` for the full Promotions row.
- [x] **2026-05-09** — A.1 phase fully shipped (pre-warmed pool, sub-3s `well create`, `well pool` CLI + REST). Promoted to `wells-stable-2026-05-09j`.
