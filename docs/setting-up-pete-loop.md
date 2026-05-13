# Setting up the Pete Loop

A complete setup guide for the **Pete Loop** — an in-session, file-based autonomy harness for Claude Code. This is the system Pete runs on his solo dev projects (3dscan, splites/wells, ...) when he wants Claude to keep working between his check-ins without having to manually restart turns or rely on cloud schedules.

This guide shows you how to install it from scratch in any project. It's the canonical write-up — keep it in version control. There's an immediate-access copy at `~/Desktop/pete-loop-setup-guide.md` for projects that don't yet have a repo.

---

## 1 — What you're getting

The Pete Loop is **three cooperating pieces**:

1. **Worker loop** — A prompt at `.claude/loops/worker.md` that defines what Claude does on each fire: read state, pick a task, do a bounded slice, commit, exit. Designed to be run repeatedly without human intervention. Worker also self-stewards opportunistically when it has slack — keeps BOARD prioritized, journal entries cohesive, STATUS fresh.
2. **Stop hook** — A shell script at `.claude/hooks/pete-loop-stop.sh` that fires when Claude Code's turn ends. If a flag file exists, it re-injects the worker prompt to start the next iteration. Capped at 200 fires per `/start-pete-loop` invocation so a runaway loop can't go forever.
3. **Backlog files** — Three plain-Markdown files at the repo root (`BOARD.md`, `JOURNAL.md`, `STATUS.md`) plus `NEEDS_PETE.md` for Pete-decision escalation. These are the worker's memory across fires.

**How they cooperate:**

```
Pete types /start-pete-loop
      ↓
worker fire 1 → reads BOARD, picks task, commits, writes JOURNAL
      ↓
turn ends → Stop hook sees .pete-loop.active → re-injects worker prompt
      ↓
worker fire 2 → reads BOARD (may be different now), picks task, commits, writes JOURNAL
      ↓
... continues until /stop-pete-loop, MAX_ITER (200), or worker hits a hard block

When worker can't make progress (Pete-decision needed, cells-team block,
architectural call), it appends to NEEDS_PETE.md and picks a different
task. Pete reads NEEDS_PETE on next check-in.
```

The worker is the **doer + light organizer**. The backlog files are the **shared memory**. The Stop hook is the **engine** that keeps the worker firing. (An earlier design had a separate "steward" role for backlog triage; killed 2026-05-11 — one role is simpler and worker covers it opportunistically.)

**What it is NOT:**

- Not a cron job. Pete's session has to be open. (For cron-style autonomy, use `/schedule` — completely separate system, runs in Anthropic's cloud.)
- Not a multi-agent framework. Single Claude Code session, one fire at a time.
- Not a CI replacement. The worker doesn't run merge gates or block deploys.
- Not a substitute for design review. Architectural calls escalate to Pete; the worker only ships implementation slices.

---

## 2 — Architecture in 60 seconds

```
<project-root>/
├── BOARD.md                    ← Kanban (Todo / In Progress / Blocked / Done)
├── JOURNAL.md                  ← Append-only fire log; every worker fire writes here
├── STATUS.md                   ← Worker refreshes with current snapshot when it has slack
├── NEEDS_PETE.md               ← Open Pete-decision queue; worker appends when blocked, Pete clears on read
├── docs/
│   └── setting-up-pete-loop.md ← This file
└── .claude/
    ├── .pete-loop.active       ← Flag file — presence=loop is on, contents=current iteration count
    │                             (gitignored)
    ├── loops/
    │   └── worker.md           ← Worker prompt (read every fire by Claude)
    ├── hooks/
    │   └── pete-loop-stop.sh   ← The engine — re-injects worker after each turn while flag exists
    ├── commands/
    │   ├── start-pete-loop.md  ← /start-pete-loop slash command
    │   └── stop-pete-loop.md   ← /stop-pete-loop slash command
    └── settings.local.json     ← Wires the Stop hook into Claude Code (gitignored)
```

**Path conventions:**

- All paths in the Stop hook + slash commands must be **absolute**. Hooks run with no guaranteed `$PWD`. Relative paths break the loop silently.
- All paths inside `.md` files (BOARD entries, JOURNAL refs) are **relative to repo root**.
- The flag file `.pete-loop.active` lives **inside `.claude/`**, not at repo root. Keeps Claude-related state co-located.

---

## 3 — Step-by-step setup (7 steps, copy-pasteable)

The templates below assume your project is at `<PROJECT_ROOT>` and the project's working branch is `<BRANCH>`. For wells, those are `/Users/pete/Projects/wells` and `feature/phase-a`. Substitute your own.

### Step 1 — Decide scope and cadence

Before writing files, answer three questions for yourself:

- **What's the project's "branch policy" for the worker?** Most projects: stay on a single feature branch and never touch main. Some (3dscan): worker squash-merges to main during day mode, isolates to a `night/<date>` branch overnight. The worker prompt has to enforce whatever you pick.
- **What's the existing source of truth for the roadmap?** If you have a `docs/PLAN.md` or `docs/MVP-PLAN.md`, the BOARD references it (worker tasks close specific checkboxes). If not, BOARD itself is the plan.
- **How permissive is the worker?** Default: never `AskUserQuestion`, never touch secrets, never `--no-verify`, never write to "stable" production state. Customize based on what Pete wants the worker to be allowed to do unsupervised.

These choices shape the worker prompt. Don't skip this step — a worker prompt without a clear scope drifts within ~5 fires.

### Step 2 — Create the file tree

```bash
cd <PROJECT_ROOT>
mkdir -p .claude/loops .claude/hooks .claude/commands
```

That's it for filesystem scaffolding.

### Step 3 — Write the worker prompt

`.claude/loops/worker.md`. This is the **most important file** in the system. It's read in full on every fire. Copy this as a starting point and customize the marked spots:

```markdown
# Worker loop prompt — <PROJECT_NAME>

You are the **worker** loop for the <PROJECT_NAME> project. You're Claude Code running on Pete's local Mac, in his current Claude Code session, re-fired by `.claude/hooks/pete-loop-stop.sh` after every turn while `.claude/.pete-loop.active` exists.

Each fire: **one bounded slice of work, one commit (or no-op + journal entry), exit.**

## Critical behavior rules

- **NEVER use AskUserQuestion.** Make decisions, document them in JOURNAL.md, proceed. If genuinely stuck, mark the task **Blocked** in BOARD.md with `decision-needed: <question>` AND append to `NEEDS_PETE.md` so Pete sees it on his next check-in.
- **Don't print verbose status to chat.** One sentence per fire. Detail goes in JOURNAL.md.
- **Don't make architectural decisions.** Implementation calls (which helper, which test pattern) are yours; framework choices, schema redesigns, scope changes are NOT.
- **Don't expand scope.** Stay inside the BOARD task you picked. New work goes to BOARD Todo, not into the current slice.

## Step 1 — Read state

cd <PROJECT_ROOT>
git status
git log --oneline -5

Read in this order:
1. `BOARD.md` — the current Kanban
2. The last 3 entries of `JOURNAL.md`
3. `STATUS.md` — last snapshot of project state
4. `NEEDS_PETE.md` — open Pete decisions (worker maintains this; flag new asks here when blocked)

## Step 2 — Pick a task

In priority order:
1. Anything in **In Progress** owned by `worker` — continue/finish it.
2. Top of **Todo**, owner `worker` or unowned, no unmet `depends:` references.
3. If nothing workable: append a one-line JOURNAL `no-op:` entry, commit, exit.

## Step 3 — Branch policy

<CUSTOMIZE: e.g., "Stay on `feature/phase-a`. Do not commit to `main`." OR "If day mode and new task, create `worker/<id>-<slug>` off main. If night mode, work on `night/<YYYY-MM-DD>`.">

## Step 4 — Mark task In Progress

Update `BOARD.md`: move task to **In Progress**, set owner `worker`, add a one-line `working on:` note. Commit BOARD on its own.

## Step 5 — Do the work

- **Hard cap: 50 minutes of execution.** If task is bigger, do a slice, commit it, leave In Progress with a `resume:` note.
- <CUSTOMIZE: language/test/style conventions for this project>
- Read existing code before editing. Match style.
- Commit liberally, one logical change per commit. Message: `worker(<id>): <why>`.

## Step 6 — Wrap

- Append a JOURNAL.md entry: timestamp (UTC), `worker`, task ID, what you did, what you learned, blockers, next.
- Update BOARD.md: **Done** or **In Progress** with resume note. Blockers go to **Blocked**.
- `git push origin <BRANCH>`.

## Step 7 — Exit your turn

Output **one sentence** to chat: `worker(<id>): <what happened>`. Nothing more.

## Hard limits — Block, don't escalate

For any of these, mark the task **Blocked** and pick a different task:

- **Architectural decision** → `decision-needed: <question>`
- **Cost-incurring action** (paid API, SaaS signup, domain) → `cost-approval-needed: <what>`
- **<CUSTOMIZE: project-specific hard limits, e.g., "Stable production restart needed">**
- **Hook failure** — investigate root cause; if can't fix, `needs-pete-session: hook — <hook>`

Never `--no-verify`, never `--force` push.
```

The exact splites version of this is at `.claude/loops/worker.md` — read it as a worked example.

### Step 4 — Write the Stop hook

`.claude/hooks/pete-loop-stop.sh`. **The single most footgun-prone file** — get the absolute paths exactly right.

```bash
#!/bin/bash
# Pete Loop — Stop hook for <PROJECT_NAME>.

set -e

PROJECT_ROOT="<ABSOLUTE_PATH_TO_PROJECT>"   # ← MUST be absolute. No $HOME, no ~.
FLAG_FILE="$PROJECT_ROOT/.claude/.pete-loop.active"
MAX_ITER=200

# Loop not active — let the stop proceed normally.
if [ ! -f "$FLAG_FILE" ]; then
  exit 0
fi

# Read and increment iteration count.
COUNT=$(head -1 "$FLAG_FILE" 2>/dev/null)
COUNT=${COUNT:-0}
COUNT=$((COUNT + 1))

# Hit max iterations — clear the flag and let stop proceed with a notice.
if [ "$COUNT" -gt "$MAX_ITER" ]; then
  rm -f "$FLAG_FILE"
  jq -n --arg msg "Pete Loop hit max iterations ($MAX_ITER). Stopped. Run /start-pete-loop to resume." \
    '{systemMessage: $msg}'
  exit 0
fi

# Save updated count and re-inject the worker prompt.
echo "$COUNT" > "$FLAG_FILE"

REASON="Pete Loop iteration $COUNT/$MAX_ITER. Execute the worker loop: read $PROJECT_ROOT/.claude/loops/worker.md and follow it precisely. Do NOT use AskUserQuestion under any circumstances. Output ≤1 sentence to chat about what you did this fire."

jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
```

Then make it executable:

```bash
chmod +x <PROJECT_ROOT>/.claude/hooks/pete-loop-stop.sh
```

**The hook's contract with Claude Code:**

- Stdout JSON `{"decision": "block", "reason": "<text>"}` → Claude Code rejects the stop and **re-injects the reason as the next user prompt**. That's how iteration N+1 begins.
- Stdout JSON `{"systemMessage": "<text>"}` → Claude Code shows a transient message to the user but allows the stop to proceed normally.
- Empty stdout / exit 0 → stop proceeds normally with no message.

`jq -n` is the safest way to emit valid JSON from shell. Don't try to printf the JSON — escaping breaks horribly with multi-line content.

### Step 5 — Write the slash commands

Three files in `.claude/commands/`. Each is an instruction Claude follows when Pete types the slash.

`.claude/commands/start-pete-loop.md`:
```markdown
---
description: Start Pete Loop — runs /worker continuously after each turn until /stop-pete-loop or 200 iterations
---

Start Pete Loop.

1. Run: `echo "0" > <PROJECT_ROOT>/.claude/.pete-loop.active`
2. Confirm to chat (one sentence): `Pete Loop started. Worker fires after every turn. /stop-pete-loop to halt; otherwise auto-stops at 200 iterations.`
3. Then immediately execute the worker loop: read `<PROJECT_ROOT>/.claude/loops/worker.md` and follow it precisely. Do NOT use AskUserQuestion. Output ≤1 sentence to chat.
```

`.claude/commands/stop-pete-loop.md`:
```markdown
---
description: Stop Pete Loop — removes the flag file
---

Stop Pete Loop:

1. Read iteration count: `cat <PROJECT_ROOT>/.claude/.pete-loop.active 2>/dev/null` (note the number).
2. Run: `rm -f <PROJECT_ROOT>/.claude/.pete-loop.active`
3. Confirm to chat (one sentence): `Pete Loop stopped at iteration <N>.`
4. Don't execute another worker iteration.
```

### Step 6 — Seed the state files

`BOARD.md`:
```markdown
# <PROJECT_NAME> — Board

Convention: tasks have IDs `<PREFIX>.{n}` (e.g., `W.1`, `P1.2`). Owner: `worker` or `pete`. Tags: `code`, `docs`, `decision-needed`, `cost-approval-needed`, `needs-pete-session`.

> **State as of <DATE>:** <one-line current status>

---

## In Progress

_(empty)_

---

## Todo (priority order)

- [ ] **W.1 — <Task title>.** <Description. What "done" looks like. Closes: <roadmap ref if any>.> Owner: `worker`. Tags: `code`.

- [ ] **W.2 — <Task title>.** ... **Depends on:** W.1.

---

## Blocked

_(empty)_

---

## Done

_(empty)_
```

`JOURNAL.md`:
```markdown
# <PROJECT_NAME> — Journal

Append-only. Each entry: `## YYYY-MM-DD HH:MM UTC — <author> — <task>`. Authors: `pete-session`, `worker`, `steward`.

---

## <YYYY-MM-DD HH:MM> UTC — pete-session — Bootstrap

**What happened:**
- <bootstrap notes>

**Read:** <takeaway>

**Next:** Pete kicks off `/start-pete-loop`. Worker picks `W.1` first.
```

`STATUS.md`:
```markdown
# <PROJECT_NAME> — Current Status

**Updated:** <timestamp> by `pete-session` (initial seed; subsequent updates by `steward`)
**Phase:** <phase>
**Health:** 🟢

## TL;DR
<2 sentences>

## What changed since last steward fire
(Initial state — first steward fire happens after the worker has accumulated entries.)

## What's stuck
| Item | Why | Who unsticks |
|------|-----|--------------|
| _(none)_ |  |  |

## Pete needs to decide
_(none right now)_

## Next planned cycle
Worker picks `W.1` (<title>).
```

Update `.gitignore`:
```
# Pete Loop runtime state
.claude/.pete-loop.active
.claude/settings.local.json
```

### Step 7 — Wire the Stop hook into settings

Create `.claude/settings.local.json`. **This is the file Claude Code reads to discover the hook.** Without it, the Stop hook script exists but never fires.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "<ABSOLUTE_PATH_TO_PROJECT>/.claude/hooks/pete-loop-stop.sh",
            "timeout": 10,
            "statusMessage": "Pete Loop check"
          }
        ]
      }
    ]
  }
}
```

**Why `settings.local.json` and not `settings.json`:** `settings.json` is committed; `settings.local.json` is per-machine. The Stop hook command has an absolute path that's specific to your machine — putting it in committed settings would break for any collaborator who clones to a different path.

**Verify the hook fires:**

```
/start-pete-loop
```

Expected: Claude confirms the loop started, runs the first worker fire (one sentence to chat), then your turn ends. The Stop hook fires, you see another worker fire begin (next iteration in chat). If you see the start confirmation but the worker doesn't auto-fire, the hook isn't wired — see "Common pitfalls" below.

To stop:
```
/stop-pete-loop
```

---

## 4 — Per-project customization checklist

When porting this to a new project, change these:

| File | What changes | What stays |
|------|-------------|-----------|
| `.claude/loops/worker.md` | `<PROJECT_NAME>`, `<PROJECT_ROOT>`, branch policy (Step 3), language/test conventions (Step 5), project-specific hard limits | Critical behavior rules, Step structure (1–7), the "no AskUserQuestion" rule, the 50-min cap |
| `.claude/loops/steward.md` | `<PROJECT_NAME>`, `<PROJECT_ROOT>`, branch ref, project-specific touch criteria (Step 6), roadmap doc reference (Step 4) | AskUserQuestion rules, 3/24h cap, Step structure |
| `.claude/hooks/pete-loop-stop.sh` | `PROJECT_ROOT` (must be absolute) | MAX_ITER (200 is right for most projects), JSON shape, the `jq` invocations |
| `.claude/commands/*.md` | `<PROJECT_ROOT>` in command bodies | description frontmatter, step structure |
| `.claude/settings.local.json` | The absolute `command` path | matcher="", timeout, statusMessage |
| `BOARD.md` | Tasks, ID prefix (`W.`, `P1.`, etc), description of state | Column structure (Todo / In Progress / Blocked / Done), task format |
| `JOURNAL.md` | Initial bootstrap entry | Header convention, append-only rule |
| `STATUS.md` | Initial content | Section structure, who-overwrites-it rule |
| `.gitignore` | Already-existing patterns | Add `.claude/.pete-loop.active` and `.claude/settings.local.json` |

**What if my project already has different conventions?**

- **Existing roadmap doc** (`PLAN.md`, `MVP-PLAN.md`, `ROADMAP.md`) — keep it. Reference it from BOARD entries (`Closes: <doc> § <section>`). Worker and steward both read it as the source of truth.
- **Existing journal/changelog** — JOURNAL.md is the loop's append-only fire log; it's separate from a project changelog. They don't conflict. Don't try to make CHANGELOG.md serve as JOURNAL.
- **Existing branch policy** — if your project doesn't allow direct commits to a main branch, customize the worker's Step 3 to enforce that. Splites uses `feature/phase-a`; 3dscan uses `main` (day) + `night/<date>` (night).
- **Existing slash commands** — if `/worker` or similar is taken, rename. The slash command names aren't load-bearing; the file paths in the prompts are.

---

## 5 — Common pitfalls

**1. Hook script paths must be absolute.** `~/.claude/...` won't work — `~` doesn't expand inside `settings.local.json` strings. Use `/Users/pete/...`. Same for `PROJECT_ROOT` inside the hook script. (Don't use `$HOME` either; the hook may run with a stripped environment.)

**2. The `jq` dependency is implicit.** The Stop hook uses `jq` to emit valid JSON. If `jq` isn't on the `PATH` of whatever shell the hook runs under, the hook silently fails and the loop never re-injects. Test by running the hook directly: `<PROJECT_ROOT>/.claude/hooks/pete-loop-stop.sh` should print one of: nothing (flag missing), `{"decision": "block", ...}` (loop active), or `{"systemMessage": ...}` (max iter hit). If it errors, install `jq` (`brew install jq`).

**3. The file-vs-flag thing.** `.pete-loop.active` is BOTH a flag (presence = loop is on) AND a state holder (contents = current iteration count). Don't `touch` it (creates an empty file → reads as 0 → next iteration becomes 1, which works) but don't `> file` either (clobbers the count). Use `echo "0" > file` to start (intentionally resets), and let the hook do the increments.

**4. The hook fires for EVERY turn, including failed ones.** If Claude errors out mid-fire, the Stop hook still fires — you'll get a re-injection of the worker prompt for "iteration 2" even though iteration 1 didn't really happen. The worker's "read state first" pattern handles this gracefully (it just picks up where it would have anyway), but be aware.

**5. The hook can't see what happened in the turn.** It only knows the turn ended. If the worker hit a real failure and journaled `no-op: <reason>`, the loop keeps going. To break the loop on a hard failure, the worker must `rm -f <flag-file>` itself before exiting, OR Pete must `/stop-pete-loop`.

**6. JOURNAL.md gets long.** Every fire writes an entry. After 50 fires, it's hundreds of lines. The steward's compaction step is what keeps this manageable — without periodic `/steward` invocations, the worker's "read last 3 entries" becomes worse than nothing. Run `/steward` at least every 10-20 worker fires.

**7. Tasks without `Closes:` references rot.** A `W.N` task that doesn't tie back to a roadmap checkbox is fine for ad-hoc work but tends to drift. When you add a worker task, ask "what does this close in MVP-PLAN / PLAN / wherever?" and include the reference. Steward catches drift via the Step 4 reconcile.

**8. Don't share `settings.local.json` between projects.** Each project's Stop hook has a different absolute path. If you copy the file across projects, the hook fires the WRONG project's worker. Always recreate per-project.

**9. The worker's "no AskUserQuestion" rule is load-bearing.** If a worker fire ever calls AskUserQuestion, it pops an iOS alert on Pete's phone — likely while he's at dinner. Hard rule. The Block-don't-escalate pattern handles uncertainty without alerting.

**10. Pete's session has to be open.** Pete Loop is in-session. If Pete closes Claude Code (the app, not just a tab), the loop ends — there's no daemon. For cross-session autonomy, use `/schedule` (cloud-hosted, separate system).

---

## 6 — Mental model — when the loop is the right tool

**Use the Pete Loop when:**

- You have a backlog of bounded, mostly-mechanical work (close N checkboxes; refactor N call sites; write N tests).
- You're going to be away from the terminal for hours but want progress to keep happening.
- Each task fits in ≤50 minutes of execution and produces a coherent commit.
- You're OK with the worker making implementation calls without asking — and you'll review the diff later.
- You want a visible record (BOARD + JOURNAL) of what happened while you weren't watching.

**Don't use the Pete Loop when:**

- The work needs ongoing human steering (UX iteration, design exploration, anything where every commit needs a thumbs-up).
- The next task isn't clear without thinking — the worker will pick something cosmetic and burn fires.
- You're debugging something interactive (you need to be at the keyboard reading errors anyway).
- The cost of a bad commit is high (production-affecting changes, security-sensitive code, anything that touches stable infrastructure).
- You want the autonomy to survive your laptop going to sleep — that's `/schedule`, not Pete Loop.

**Steward is the right tool when:**

- You've had ~10+ worker fires and want a clean reorder + STATUS snapshot.
- You think Pete might need to make a decision and you want the worker to surface accumulated `decision-needed:` items.
- The worker has been in a no-op stretch for a while — steward can either resurface a Blocked task or write NEEDS_PETE to ask Pete what to do next.

**The pairing's superpower:** the worker can be aggressive (50 fires in a row, no questions, just shipping) because the steward is a release valve. Without the steward, the worker either asks too often (kills autonomy) or never asks (drifts into useless work). With the steward, the worker stays heads-down and the steward routes any real human-decision moments to Pete on a sane cadence.

**The pairing's failure mode:** if you never run the steward, accumulated `decision-needed:` tasks pile up in BOARD Blocked, the worker runs out of unblocked Todo, and you get a stretch of `no-op:` JOURNAL entries that look like the worker is broken (it isn't — it's correctly waiting). Run `/steward` periodically.

---

## Quick-reference cheat sheet

| Command | What it does |
|---------|-------------|
| `/start-pete-loop` | Activates the loop. Worker fires after every turn until stopped or MAX_ITER. |
| `/stop-pete-loop` | Removes the flag. Loop stops at end of current turn. |
| `/steward` | One-shot triage + compaction + optional Pete-touch. Out-of-band. |
| `cat <PROJECT_ROOT>/.claude/.pete-loop.active` | Current iteration count (or "no such file" = loop is off). |
| `tail -50 <PROJECT_ROOT>/JOURNAL.md` | What the worker has been up to. |
| `cat <PROJECT_ROOT>/STATUS.md` | Steward's last snapshot. |
| `ls <PROJECT_ROOT>/NEEDS_PETE.md` | If exists → Pete needs to decide something. |
| `head -50 <PROJECT_ROOT>/BOARD.md` | Current Kanban. |

That's the whole system. The rest is cadence — match `/steward` invocations to your actual check-in rhythm and let the worker run between.
