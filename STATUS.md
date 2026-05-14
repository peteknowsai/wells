# wells — Current Status

**Updated:** 2026-05-14 ~01:30 UTC by `worker` (manual session). Boundary cleanup arc (Piece 2 + Piece 3 + /seal + W.78 + IP race + 409-vs-500) closed end-to-end across ~5hrs. Wells main went `63c3de0` → `33ebd6a` across 8 commits. Cells coordinated and shipped 7 commits on their side in parallel.
**Phase:** Phase A closed 2026-05-12. Boundary cleanup (Pi 1/2/3 of `docs/proposals/wells-cells-boundary-cleanup.html`) closed 2026-05-13. Next milestone: wells 1.0 (~2026-06-06 target).
**Health:** 🟢 Stable on the post-Pi2/Pi3/seal substrate. Welld at `46d7e5e` + doc cleanup `33ebd6a` (running since 2026-05-14 01:24:44Z bounce). Cells's post-4th-bounce reconcile shows **zero drift** — pool_size_before=12, welld_known=12, no evictions. W.78 fast-skip resurrect held the registry through the bounce; the boundary holds.

## What changed since last STATUS (2026-05-12 ~23:30 UTC)

**splites → wells rename (2026-05-13 morning).** Folder + GH repo + tracked-file sweep + plist + scripts. Two surprises captured in memory: gitignored `bin/vwell` wrappers carrying build-time absolute paths, and `git worktree repair` doesn't fix the case where both ends moved. Recipe inline in `feedback_folder_rename_gotchas.md`. Two stragglers (`well-firstboot.service` Documentation URL + `dhcp.test.ts` fixture) surfaced during cells's later verification and got swept in `4a4b683`.

**Piece 2 shipped — pool moved to cells (2026-05-13 ~19:00 UTC, commit `1ab5160`).** -2301 LoC from wells across 22 files. `poolFill`, `poolFiller`, `poolRegistry`, `adoptFromPool`, `identityReset` modules deleted; `lib/handlers/pool.ts` gone; `well pool` CLI gone; `PoolMember*` schemas gone; `PATHS.pool*` gone. Cells owns `~/.cells/pool.json` going forward; cells's new `reconcilePool()` (their main `c3f2d8b`) diffs against welld `GET /v1/wells` and evicts entries welld doesn't have. Coordinated end-to-end via `/comms cells` two-way chat channel.

**Piece 3 + rename stragglers shipped (2026-05-13 ~19:10 UTC, commit `ff51dd7`).** Deleted createWell's warming sequence (cells's pool builder now warms via /seal instead). Operator-created wells stay running with cidata attached as `alive_running`. Fresh `well create` 6-8s faster on the operator path. -156 LoC.

**W.78 — startup-resurrect orphan fast-skip (2026-05-13 ~19:15 UTC, commit `eb47da3`).** Bobby-class ghosts (registry entries whose lume bundles are gone) no longer jam POST /v1/wells for 60s × N during welld startup. When `lume.info` returns null, skip with "orphan registry entry" reason instead of falling through to startWell's 60s SSH timeout. 32 ghosts: 32min → 320ms. Surfaced during cells's Pi2 verification post-bounce at 19:08Z.

**`POST /v1/wells/{name}/seal` shipped (2026-05-13 ~19:25 UTC, commit `7fa429c`).** Post-Pi3 replacement for the deleted createWell warming sequence: halt → restart no cidata → flip hibernate_ready=true. Cells's pool builder calls this AFTER provisioning so the disk-only hibernate snapshot captures the provisioned cell (not the bare base image). Architecturally cleaner than pre-Pi3. +315 LoC, 5 handler tests. cells main `04daa03` consumes it in `bakePoolMember`.

**Cells's V1.5 + V1.10 re-run on /seal-baked members:** sleep **589ms** (target 0.6s), wake **380ms** (target 1.9s), warm-path alive **69ms** (target 3s — 43× under). Boundary cleanup verified green end-to-end.

**Two follow-up fixes shipped (2026-05-13 ~19:45 UTC, commit `46d7e5e`).** (1) `HibernateNotReadyError` on the gate; handler maps to 409 `well_not_hibernate_ready` instead of generic 500 `hibernate_failed` (matches the doc contract). (2) `reservedIps` Set in `lib/ipPool.ts` closes the IP-allocator race cells team observed at 19:11Z (5 parallel POSTs → 3 wells, 2 collided on .202). `createWell` `try/finally` guarantees release on either path.

**Doc rewrites:** `cells-pool-builder-primitives.md` rewritten for post-Pi3 / /seal (`b9040c6`). `state-schema.md` + `architecture.md` + `cells-integration.md` /healthz block scrubbed of pool refs (this session). BLOCKED.md cleared — both entries resolved/deferred, history in git.

**Test suite:** 980 → 989 across the arc. Sequential mode reliably 5-6s.

**Wells main commits this session (in order):** `1ab5160` (Pi2), `4a4b683` (rename strag), `ff51dd7` (Pi3), `eb47da3` (W.78), `7fa429c` (/seal), `b9040c6` (doc rewrite), `46d7e5e` (follow-ups), `33ebd6a` (doc cleanup), + the in-flight session cleanup (this STATUS update).

**Welld bounces:** 4 in the session, all clean. Cells's `reconcilePool()` made the in-flight drift class self-healing.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **W.73 resurrect race** (Tier-4 VMs crash post-resurrect even though lume reports running) | Pre-Pi3 issue, still open. Class distinct from W.78 (which closed the orphan-bundle case). Repro needs Tier-4 wells in registry at welld kickstart time. Mostly latent now that Tier-4 pool moved to cells. | Worker, next session if it bites again |
| **Final V1 acceptance run + 1.0 cut** | Cells team's scoring (their suite, their targets). Wells reports substrate-side latency / error-rate / concurrency wire; cells decides. | Cells team (acceptance), Pete (cut tag) |

## What's NOT stuck (cells team can use these now)

- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2).
- ✅ Watchdog autosleep + wake-on-traffic.
- ✅ `/seal` for hibernate-legal pool members (post-Pi3 primitive).
- ✅ Hibernate / wake with sibling-survive (W.74) — verified cells's V1.5 sleep+auto-wake post-/seal.
- ✅ Burst birth from warm pool (V1.10 verified post-/seal).
- ✅ Boundary holds: 4 bounces this session, cells reconcile shows zero drift each time.
