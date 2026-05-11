# NEEDS_PETE — open decisions

**Mode:** silent (Pete async + opted out of touches). Steward consolidates outstanding Pete decisions here for own-schedule read. Top section is current-open; archaeology preserved below.

---

## Currently open (refreshed by worker 2026-05-11 07:50 UTC, mid-Pete-Loop iter 26)

Three Pete decisions outstanding. None blocks cells team's main flows (P1.3 birth + steady-state + watchdog all work; cells are marching on P1.4-P1.16). All three are forward-looking; nothing burning.

### 1. W.30 — re-bake `ubuntu-25.10-base` + stable promote

W.28 + W.29 dropped bun + pi + grub-dead-code from `templates/cloud-init-base.yaml` (commit history in BOARD Done section). Code is shipped on `feature/phase-a`; the actual on-disk image hasn't changed. To make it take effect: bake a fresh `ubuntu-25.10-base` from the updated template, tag a new `wells-stable-2026-05-XX`, restart stable welld with the new tag.

- **Cells-team impact**: zero functional change (cells's own bake installs bun + pi via their commit `3fde0c8`). The new base is just leaner — saves ~5-10 min per bake and ~200 MB on the disk image.
- **Promotion timing**: cells team is in P1.4-P1.16. Don't mid-sprint-restart-stable. Recommendation: wait for an explicit "cells team paused" or "cells team done with P1.x" beat, then promote.
- **Action**: `bun run scripts/bake-base-image.ts` → `git tag wells-stable-2026-05-XX` → `scripts/run-welld-stable.sh` (or equivalent).

### 2. W.22 — steward-cron starvation (durable-fix call)

Pete Loop's Stop hook re-injects the worker prompt every turn, so the REPL is never idle and CronCreate jobs only fire when idle. The every-3h steward cron didn't fire during the prior 200-iter worker run — MAX_ITER=200 auto-stop opened the idle window, and steward did fire then. Concrete proof the cap-out architecture works.

Three options:
- **(a)** Integrate steward INTO the worker (every Nth fire becomes a steward fire). ~30-60 min of design + plumbing.
- **(b)** Modify the Stop hook to skip re-inject if the next steward fire is within ~5 min. ~30 min.
- **(c)** Accept the cap-out window as the steward cadence (every ~200 fires ≈ ~17 wall-clock-hours, roughly daily). Zero engineering. Predictable.

**Recommendation: (c).** First Pete Loop run proved it works. The 200-fire window is roughly daily for typical pacing.

### 3. W.14 slice 3 — `bin/lume` → `bin/vwell` rename

Slice 1 + slice 2 shipped 2026-05-10. Only the binary rename remains. Forces a stable wrapper update + probably a stable promotion to keep cells team uninterrupted. Low value. Defer until you ask for it.

### 4. A.3 egress enforcement — design decisions

Independent of the loop sprint. Open since 2026-05-06.

`POST /v1/wells/{n}/policy/network` already persists rules. Making `enforced: true` honest needs decisions on (1) privilege model (root vs. helper vs. daemon), (2) DNS strategy (host resolver vs. pf-only), (3) policy expressiveness, (4) UX.

Full proposal: [`docs/proposals/A.3-egress-enforcement.md`](docs/proposals/A.3-egress-enforcement.md). Phase A egress code stays stubbed until your call.

---

## RESOLVED 2026-05-10 — W.27 wake regression

Host reboot at 12:18 UTC cleared it. Wake-stress smoke 30/30 green post-reboot (wake p95 829ms, ssh-after-wake p95 1147ms). Cells team's `auto_sleep_seconds: null` mitigation can be dropped. `docs/cells-integration.md` banner flipped ✅; `docs/findings-wake-regression-permission-denied.md` stamped RESOLVED.

## RESOLVED 2026-05-10 — W.2 R2 round-trip smoke

Bucket-scoped R2 token unblocked the smoke. 41:18 wall-clock end-to-end on a 50GB sparse disk (upload 22:36, sha256 stream, download 17:38, restore <1s); identity hash matched. Three plumbing fixes shipped alongside: r2.ts 16MB partSize, async R2 upload, streaming sha256. MVP-PLAN A.2 § "Smoke: round-trip" ticked.

## RESOLVED 2026-05-10 06:10 UTC — rinse-empty-home claim

Cells team responded after worker flagged the code/claim mismatch. Their fix (not wells's): moved cells DNA out of `/home/well/` to `/cell/` (~2h grep-and-replace on their side). Wells's rinse stays as-is — confirmed identity-only. Their only ask was a doc note explaining exactly what `validate=true` rinses; that's in `docs/cells-integration.md`. This entry kept as audit trail of the misdiagnosis investigation.
