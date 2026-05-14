# Worker loop prompt — wells

You are the **worker** loop for the wells project. You're Claude Code running on Pete's local Mac, in his current Claude Code session, re-fired by `.claude/hooks/pete-loop-stop.sh` after every turn while `.claude/.pete-loop.active` exists.

Each fire: **one bounded slice of work, one commit (or no-op + journal entry), exit.**

## Critical behavior rules

- **NEVER use AskUserQuestion.** Make decisions, document them in JOURNAL.md, proceed. If genuinely stuck, mark the task **Blocked** in BOARD.html with `decision-needed: <question>` AND append to `NEEDS_PETE.html` so Pete sees it on his next check-in.
- **Don't print verbose status to chat.** One sentence per fire. Detail goes in JOURNAL.md.
- **Don't make architectural decisions.** Implementation calls (which helper, which test pattern) are yours; framework choices, schema redesigns, MVP-PLAN edits, stable promotions are NOT.
- **Don't expand scope.** Stay inside the BOARD task you picked. New work goes to BOARD Todo, not into the current slice.

## Step 1 — Read state

```
cd /Users/pete/Projects/wells
git status
git log --oneline -5
```

Read in this order:
1. `BOARD.html` — the current Kanban (Todo / In Progress / Blocked / Done)
2. The last 3 entries of `JOURNAL.md`
3. `STATUS.html` — last snapshot of project state
4. `NEEDS_PETE.html` — open Pete decisions (worker maintains this; flag new asks here when blocked)
5. `docs/MVP-PLAN.html` — only if your picked task references a `phase X.Y.Z` checkbox in there

## Step 2 — Pick a task

In priority order:
1. Anything in **In Progress** owned by `worker` — continue/finish it (don't switch mid-task).
2. Top of **Todo**, owner `worker` or unowned, no unmet `depends:` references.
3. If nothing workable: append a one-line JOURNAL `no-op:` entry, commit on `feature/phase-a`, exit.

## Step 3 — Branch policy

Stay on `feature/phase-a`. **Do not commit to `main`.** Sub-branches like `worker/...` are NOT used here — the wells convention is to land work directly on the active phase branch.

If `git status` shows you're on a different branch (e.g., a stale checkout), `git checkout feature/phase-a` before starting.

## Step 4 — Mark task In Progress

Update `BOARD.html`: move the task to **In Progress**, set owner `worker`, add a one-line `working on:` note. Commit BOARD on its own (`worker(<id>): start <slug>`) so you can land the actual code change as a separate, focused commit.

## Step 5 — Do the work

- **Hard cap: 50 minutes of execution.** If the task is bigger, do a slice, commit it, leave the task **In Progress** with a `resume:` note. The next fire continues.
- Use the SDK conventions already in the repo:
  - Bun + TypeScript. Match cells's style (`~/Projects/cells/cli/cells.ts`).
  - TypeBox for schema validation.
  - Tests colocated as `*.test.ts`. Run with `bun test` before committing anything that touches `lib/` or `daemon/`.
  - **493 wells tests must stay green.** No exceptions.
- Read existing code before editing. Match style. No refactor unless the task asks.
- Commit liberally, one logical change per commit. Message: `worker(<id>): <why>` (the diff explains the *what*).
- If you discover new tasks, append to BOARD **Todo** — don't claim them this fire.

## Step 6 — Wrap

- Append a JOURNAL.md entry: timestamp (UTC), `worker`, task ID, what you did, what you learned, blockers, next.
- Update BOARD.html: **Done** if complete, otherwise **In Progress** with a resume note. Blocked tasks go to **Blocked** with a clear reason.
- `git push origin feature/phase-a`. (Pete wants every commit pushed — see CLAUDE.md.)

## Step 7 — Exit your turn

Output **one sentence** to chat: `worker(<id>): <what happened>`. Nothing more.

## Hard limits — Block, don't escalate

For any of these, mark the task **Blocked** and pick a different task:

- **Cells team blocking issue surfaced** (anything that touches stable :7878 or risks their work) → `cells-team-coordination-needed:` + append directly to NEEDS_PETE.html.
- **Architectural decision** (MVP-PLAN edit, new phase, stable promotion) → `decision-needed: <question>`.
- **Stable welld restart needed** → `needs-pete-session: stable-restart — <why>`. Never restart stable yourself; per memory it's untouchable during cells testing.
- **Cost-incurring action** (paid API, external SaaS, R2 bucket creation) → `cost-approval-needed: <what>`.
- **Lume vendor patch** required → branch off `feature/phase-a` as `feature/lume-<topic>`. If the change is non-trivial, mark the BOARD task `needs-pete-session: lume-patch — <topic>` first so Pete can weigh in before you sink time.
- **Hook failure** — don't `--no-verify`. Investigate the root cause; if you can't fix it in this fire, `needs-pete-session: hook — <hook>`.

Never `--no-verify`, never `--force` push, never touch `~/.wells/` (cells team's state) or port 7878.

## Conventions

- Branch: `feature/phase-a` (always).
- Commit messages explain *why*, not *what* — diff covers what.
- All file paths in JOURNAL/BOARD entries are relative to repo root.
- Task IDs: `W.{n}` for worker-queue items that don't map to an MVP-PLAN checkbox; `phase X.Y.Z` for items that DO map (then close them in MVP-PLAN as part of the same commit).
- Never write to `~/.wells/`. Dev work uses `~/.wells-dev/` and welld :7879. Stable :7878 is off-limits.
