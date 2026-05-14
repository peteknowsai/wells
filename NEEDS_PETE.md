# NEEDS_PETE — open decisions

**Mode:** silent (Pete async + opted out of touches). Worker maintains this file directly when blocked or surfacing decisions. Top section is current-open; archaeology preserved below.

---

## Currently open (refreshed by worker 2026-05-14)

**`v1.0.0` tag — ready to cut, awaiting Pete.** Wells-side 1.0 scope is complete as of 2026-05-14: Phase A done, boundary cleanup (Pi 1/2/3) done, splites→wells rename done, Phase B's wells-side (B.0.x) done. Frozen tier (A.2) deferred to 1.x; B.1–B.4 are cells-side and moved out of wells's plan. The one thing between here and `v1.0.0` is the tag cut — Pete's call. Soft context: cells's V1 acceptance run (cells-owned scoring) may produce a sign-off on the substrate, but per Pete (2026-05-14) wells is **not** blocking on it and is **not** pinging the cells team for it (they're mid other work). Cut the tag whenever ready.

---

## RESOLVED 2026-05-11 — A.3 egress enforcement (DEFERRED)

Pete picked the design (1B helper + 2A host resolver) but decided not to ship: no concrete consumer on single-host single-operator setup, cells team never blocked on it, wire contract already returns honest `enforced: false`. Architectural call recorded in `docs/proposals/A.3-egress-enforcement.md` + `docs/BLOCKED.md`. Implementation queue stays empty until a trigger surfaces.

## RESOLVED 2026-05-11 — W.14 slice 3 (`bin/lume` → `bin/vwell` rename, SHIPPED)

Pete picked do-it-now 2026-05-11 ~01:20Z. Wrapper renamed in both worktrees, `LUME_BIN` updated, `build-lume.sh` outputs `bin/vwell`, architecture.md + run-welld-stable.sh comments updated. `.gitignore` updated. The .app bundle (`bin/lume.app`) keeps its upstream name. Code shipped on `feature/phase-a`; deploy needs a welld bootout+kickstart at the next quiet window. Commit `a435937`.

## RESOLVED 2026-05-11 — W.22 steward starvation (KILLED, not fixed)

Pete's call: kill the steward role entirely rather than fix its cron starvation. Worker already self-stewards opportunistically (saw this through the W.28-W.65 sprint — worker maintained BOARD, JOURNAL, STATUS, NEEDS_PETE without a separate steward role firing). `.claude/loops/steward.md` + `.claude/commands/steward.md` deleted. `worker.md` updated: worker writes to NEEDS_PETE directly when blocked. One role is simpler than two.

## RESOLVED 2026-05-10 — W.27 wake regression

Host reboot at 12:18 UTC cleared it. Wake-stress smoke 30/30 green post-reboot (wake p95 829ms, ssh-after-wake p95 1147ms). Cells team's `auto_sleep_seconds: null` mitigation can be dropped. `docs/cells-integration.md` banner flipped ✅; `docs/findings-wake-regression-permission-denied.md` stamped RESOLVED.

## RESOLVED 2026-05-10 — W.2 R2 round-trip smoke

Bucket-scoped R2 token unblocked the smoke. 41:18 wall-clock end-to-end on a 50GB sparse disk (upload 22:36, sha256 stream, download 17:38, restore <1s); identity hash matched. Three plumbing fixes shipped alongside: r2.ts 16MB partSize, async R2 upload, streaming sha256. MVP-PLAN A.2 § "Smoke: round-trip" ticked.

## RESOLVED 2026-05-10 06:10 UTC — rinse-empty-home claim

Cells team responded after worker flagged the code/claim mismatch. Their fix (not wells's): moved cells DNA out of `/home/well/` to `/cell/` (~2h grep-and-replace on their side). Wells's rinse stays as-is — confirmed identity-only. Their only ask was a doc note explaining exactly what `validate=true` rinses; that's in `docs/cells-integration.md`. This entry kept as audit trail of the misdiagnosis investigation.
