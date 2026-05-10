# splites — Journal

Append-only. Each entry: `## YYYY-MM-DD HH:MM UTC — <author> — <task>`. Authors: `pete-session`, `worker`, `steward`.

---

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
