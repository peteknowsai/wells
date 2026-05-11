# NEEDS_PETE — open decisions

**Mode:** silent (Pete async + opted out of touches). Worker maintains this file directly when blocked or surfacing decisions. Top section is current-open; archaeology preserved below.

---

## Currently open (refreshed by worker 2026-05-11 ~07:15 UTC)

_(none — Pete's three pending decisions resolved in the 07:13Z session: W.22 killed, W.14 slice 3 + A.3 in flight per Pete's picks)_

---

## RESOLVED 2026-05-11 — W.22 steward starvation (KILLED, not fixed)

Pete's call: kill the steward role entirely rather than fix its cron starvation. Worker already self-stewards opportunistically (saw this through the W.28-W.65 sprint — worker maintained BOARD, JOURNAL, STATUS, NEEDS_PETE without a separate steward role firing). `.claude/loops/steward.md` + `.claude/commands/steward.md` deleted. `worker.md` updated: worker writes to NEEDS_PETE directly when blocked. One role is simpler than two.

## RESOLVED 2026-05-10 — W.27 wake regression

Host reboot at 12:18 UTC cleared it. Wake-stress smoke 30/30 green post-reboot (wake p95 829ms, ssh-after-wake p95 1147ms). Cells team's `auto_sleep_seconds: null` mitigation can be dropped. `docs/cells-integration.md` banner flipped ✅; `docs/findings-wake-regression-permission-denied.md` stamped RESOLVED.

## RESOLVED 2026-05-10 — W.2 R2 round-trip smoke

Bucket-scoped R2 token unblocked the smoke. 41:18 wall-clock end-to-end on a 50GB sparse disk (upload 22:36, sha256 stream, download 17:38, restore <1s); identity hash matched. Three plumbing fixes shipped alongside: r2.ts 16MB partSize, async R2 upload, streaming sha256. MVP-PLAN A.2 § "Smoke: round-trip" ticked.

## RESOLVED 2026-05-10 06:10 UTC — rinse-empty-home claim

Cells team responded after worker flagged the code/claim mismatch. Their fix (not wells's): moved cells DNA out of `/home/well/` to `/cell/` (~2h grep-and-replace on their side). Wells's rinse stays as-is — confirmed identity-only. Their only ask was a doc note explaining exactly what `validate=true` rinses; that's in `docs/cells-integration.md`. This entry kept as audit trail of the misdiagnosis investigation.
