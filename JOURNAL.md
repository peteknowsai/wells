# splites — Journal

Append-only. Each entry: `## YYYY-MM-DD HH:MM UTC — <author> — <task>`. Authors: `pete-session`, `worker`, `steward`.

---

## 2026-05-10 06:00 UTC — worker — W.16 flagged + W.1 closed; W.2 paused mid-orient

**Fire goal:** Started W.2 (R2 round-trip smoke) — checkpoint create → R2 verify → local delete → restore-from-R2 → sha256 match. Got through orientation (welld API surface for create/checkpoint/restore confirmed, wrangler available, dev welld :7879 up) but pivoted before writing the script.

**Pivot trigger:** Pete forwarded a NEEDS_PETE-style draft from the steward channel claiming rinseGuest wipes `/home/well/` and proposing a "narrow rinseGuest to identity-only" fix. Reading `lib/rinseWell.ts:47-58` proved the rinse script is *already* identity-only (machine-id, .well-ready, network state, host SSH keys, .ssh/authorized_keys for both ubuntu and well users). `grep -rn "/home" lib/ daemon/ templates/` returned nothing else wells-side that wipes homes. So the cells-team repro symptom is real (forks come up empty for cells's purposes) but the proposed root cause is wrong; sending the pre-drafted ping would point cells at code that doesn't exist.

Wrote NEEDS_PETE.md with the corrected diagnosis + 4 candidate root causes (well exec user mismatch, cloud-init re-skel on first boot, save-time issue I haven't found, cidata overlay) + an introspection repro Pete or the steward can run on dev. Logged W.16 to BOARD **Blocked** with `cells-team-coordination-needed` + `decision-needed: pete or steward picks up the dev-side repro`.

**Read:** Worker shouldn't send pings on cells's behalf without verifying the technical claim. `RINSE_SCRIPT` is the canonical identity rinse — if forks come up empty, it's not because of rinse.

**Decision:** Worker held W.2 mid-fire to flag the bad-diagnosis loop before it propagated to cells. Per worker rules, that's the right call (cells-team-coordination-needed + decision-needed → Block + pivot). W.2 stays in **In Progress** with a `resume:` note for next fire.

**Next:** Next worker fire resumes W.2 unless Pete redirects. If Pete chooses "yes, run the introspection repro on dev," that's a separate fire (~10 min wall-clock for the repro + report).



## 2026-05-10 04:30 UTC — pete-session — Pete Loop bootstrapped

**What happened:**

- Earlier this session shipped the cells team WS proxy 1011 fix (commits `9c7a34c` → `41d92ab`), promoted to `wells-stable-2026-05-10a`. Cells team unblocked.
- Pete picked the next three priorities in order:
  1. Close out A.2 R2 polish (GC + round-trip smoke).
  2. Image library on R2 (push + pull, design first).
  3. Lume `@MainActor` variance (B.0.9.d.5.b residual — ~20% of smoke cycles bump 15-15.5s).
- Set up Pete Loop infrastructure for splites, modeled on the 3dscan project's setup (`~/Projects/3dscan/.claude/`):
  - `.claude/loops/worker.md` + `.claude/loops/steward.md` — splites-customized prompts (no day/night mode; always on `feature/phase-a`; no sub-branches).
  - `.claude/hooks/pete-loop-stop.sh` — Stop hook that re-injects worker prompt while `.claude/.pete-loop.active` exists. Capped at 200 iterations.
  - `.claude/commands/{start,stop}-pete-loop.md` + `steward.md` — slash commands.
  - `BOARD.md` (new) seeded with the three priorities as `W.1`–`W.7` plus a `W.8` housekeeping item.
  - `JOURNAL.md` (new — this file).
  - `STATUS.md` (new) with current snapshot.
- Setup guide drafted in two locations per Pete's instruction:
  - `~/Desktop/pete-loop-setup-guide.md` (immediate-access copy)
  - `docs/setting-up-pete-loop.md` (version-controlled in repo)

**Read:** Pete Loop is the Kanban + autonomous-fire harness for solo dev work. Splites is now both /mvp-splites (manual one-off via `/loop` or direct invocation) AND Pete Loop (in-session continuous via Stop hook). They're orthogonal — pick whichever fits the moment.

**Decision:** No day/night branch isolation for splites (unlike 3dscan). Splites's branch policy is "everything on `feature/phase-a` until phase rollover" per repo CLAUDE.md, and the cells team coordination model already provides a softer human-in-loop than 3dscan's all-night autonomous mode.

**Next:** Pete kicks off `/start-pete-loop` when ready. Worker picks `W.1` (A.2 R2 GC) first.
