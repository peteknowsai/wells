# wells — Board

Convention: tasks have IDs `W.{n}` for worker-queue items that don't map to a specific MVP-PLAN checkbox; `phase X.Y.Z` for items that map directly to a checkbox in `docs/MVP-PLAN.md` (close them in MVP-PLAN as part of the same commit). Owner: `worker` or `pete`. Tags: `cells-coordination`, `lume-vendor`, `code`, `docs`, `cost-approval-needed`, `decision-needed`, `needs-pete-session`.

> **State as of 2026-05-14 (1.0-readiness pass):** Wells-side 1.0 scope is **done**. Phase A complete, boundary cleanup (Pi 1/2/3) closed, splites→wells rename done, Phase B's wells-side (B.0.x) complete. This session: confirmed reboot-survival (welld LaunchAgent, signed off by Pete), shipped the menu bar app, fixed a cells-reported `resolveWellIp` bug + swept siblings + stale "no DHCP lease" wording, then a plan-doc cleanup — Frozen tier (A.2) deferred to 1.x, B.1–B.4 moved out of wells's MVP (cells-side work). Remaining path to `v1.0.0`: cells's V1 acceptance run (cells-owned) → Pete cuts the tag. `main` at `eb586f9` + this cleanup.
>
> **Pete pre-approved shipping without gates** + granted access to `cf` + `wrangler` CLIs (account PKAI, `5a6fef07a998d84ec047ef43d0543342`).

---

## In Progress

_(none)_

---

## Todo (priority order)

### Worker-queue

- [ ] **W.73 — fix resurrect race with fresh lume serve.** Surfaced 2026-05-12 22:00Z bounce: `lib/resurrect.ts:startWell` returned success in <30ms per well (lume.start + waitForStatus both fast), but the Tier-4 (cidata-mounted, no warming) VMs crashed silently within seconds. Symptoms: lume reports `stopped` later, L3 dead from host, but the well revives cleanly via explicit `POST /v1/wells/<name>/start` afterward. Note: distinct from W.78 (orphan-bundle fast-skip, shipped 2026-05-13) — that closed the bobby-class jam where lume had no record. W.73 is the case where lume HAS the record + reports running, but the VM dies shortly after. Fix candidates: (a) gate resurrect on `waitForSshReady`, not just `waitForStatus(running)`; (b) brief settle delay between lume serve start and resurrect's lume.start calls; (c) probe-and-retry shape. Owner: `worker`. Tag: `code`.

### Pete-owned, queued

_(none — splites → wells rename DONE 2026-05-13, lume signing cert obtained 2026-05-07, A.3 egress deferred 2026-05-11)_

---

## Blocked

_(no blocked items)_

---

## Done

_Recently shipped (last ~24h). Older items live in git log + `docs/cells-integration.md` Promotions table._

- [x] **2026-05-14** — **1.0-readiness plan cleanup.** Frozen tier (A.2) deferred to 1.x; B.1–B.4 moved out of wells's MVP (cells-repo + cells-acceptance work); MVP-PLAN / ROADMAP / STATUS / BOARD / NEEDS_PETE all updated to reflect wells-side 1.0 scope = done. Remaining path to `v1.0.0` is cells's acceptance run + Pete's tag cut. No code touched.
- [x] **2026-05-14** — **Reboot-survival confirmed + menu bar app + cells-bug fixes.** Verified welld is a `RunAtLoad`+`KeepAlive` LaunchAgent (comes back on login — Pete signed off). Shipped the Wells menu bar app (`136d947`). Fixed the cells-reported `resolveWellIp` bug in `services.ts` (`f7e24b2`), swept the sibling `readDhcpLease` call sites (`fe739ad`), and the stale "no DHCP lease" error wording (`eb586f9`). Suite 990/0.
- [x] **2026-05-14 01:30 UTC** — **Session retrospective doc + BOARD/STATUS refresh.** `docs/findings-piece-2-3-seal-session.md` captures the ~5hr arc end-to-end. Cleaned BLOCKED.md (both entries resolved/deferred — history is in git). state-schema.md + architecture.md + cells-integration.md /healthz block scrubbed of pool refs.
- [x] **2026-05-13 19:45 UTC** — **Both Pi2/Pi3 follow-ups shipped (46d7e5e + doc cleanup 33ebd6a).** (1) `HibernateNotReadyError` on the gate; handler maps `err.code === "well_not_hibernate_ready"` → 409 instead of generic 500 hibernate_failed. (2) `reservedIps` Set in `lib/ipPool.ts` closes the race cells team observed at 19:11Z (5 parallel POSTs → 3 wells, 2 collided on .202). `createWell` try/finally guarantees release on either path. Tests 985 → 987. Bounced welld 4th time to make live; cells's post-bounce reconcile shows zero drift, boundary holds.
- [x] **2026-05-13 19:25 UTC** — **`POST /v1/wells/{name}/seal` shipped (7fa429c) + cells's bake-flow consumer merged.** Post-Pi3 replacement for the deleted createWell warming sequence: halt → restart no cidata → flip hibernate_ready=true. Cells's V1.5/V1.10 re-run post-/seal: sleep 589ms (target 0.6s), wake 380ms (target 1.9s), warm-path alive 69ms (target 3s — 43× under). 315 LoC + 5 handler tests. cells main `04daa03` consumes /seal in bakePoolMember between provision and hibernate.
- [x] **2026-05-13 19:15 UTC** — **W.78 startup-resurrect orphan fast-skip (eb47da3).** Bobby-class ghosts (registry entries whose lume bundles are gone) no longer jam POST /v1/wells for 60s × N during welld startup. Fix: when `lume.info` returns null, skip with "orphan registry entry" reason instead of falling through to startWell's 60s SSH timeout. 32 ghosts: 32min → 320ms.
- [x] **2026-05-13 19:10 UTC** — **Piece 3 + rename stragglers shipped (ff51dd7).** Deleted createWell's warming sequence (cells's pool builder warms via /seal now instead). Operator-created wells stay running with cidata attached as alive_running. Fresh `well create` 6-8s faster on the operator path. Includes 2 splites→wells stragglers cells found during Pi2 verification: well-firstboot.service Documentation URL + dhcp.test.ts fixture. -156 LoC.
- [x] **2026-05-13 19:00 UTC** — **Piece 2 shipped (1ab5160).** Pool moved out of wells: -2301 LoC across 22 files. `poolFill`, `poolFiller`, `poolRegistry`, `adoptFromPool`, `identityReset` modules deleted; `lib/handlers/pool.ts` gone; `well pool` CLI gone; `PoolMember*` schemas gone; `PATHS.pool*` gone. Cells owns `~/.cells/pool.json` going forward; reconcilePool() in cells diffs against welld `GET /v1/wells`. Coordinated end-to-end via `/comms cells` comms channel.
- [x] **2026-05-13 11:00 UTC** — **splites → wells rename (folder + GH repo + tracked files + sweep).** All path references swept: scripts, plist, CLAUDE files, docs. Folder moved `~/Projects/splites/` → `~/Projects/wells/`; worktree moved `splites-stable/` → `wells-stable/`; GH repo renamed `peteknowsai/splites` → `peteknowsai/wells`. Two surprises captured in `feedback_folder_rename_gotchas.md` (gitignored bin/vwell wrappers, worktree-repair limits). Commit `9c7147c`.
