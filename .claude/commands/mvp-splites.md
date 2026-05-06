---
name: mvp-splites
description: Make one bounded chunk of progress on the splites MVP plan. Read docs/MVP-PLAN.md, find the next unchecked task in the next un-completed phase, implement it, test it, commit, update the plan.
---

# /mvp-splites — make one chunk of progress on the MVP

You are working on the splites project at `/Users/pete/Projects/splites`. The phased MVP plan lives at `docs/MVP-PLAN.md`. Your job, this run: make one bounded chunk of progress.

## Steps

1. **Orient.**
   - `cd /Users/pete/Projects/splites`
   - Read `docs/MVP-PLAN.md` and (if it exists) `docs/BLOCKED.md`.
   - `git status` and `git log --oneline -10` to see what was done.
   - If `BLOCKED.md` has an open blocker that hasn't been resolved by Pete, do not start new work. Re-check whether the blocker is still real (state may have changed). If it is, append a short note to `BLOCKED.md` with today's date, commit, and stop.
   - Verify you're on `feature/mvp`. If not, `git checkout feature/mvp` (or `git checkout -b feature/mvp` if it doesn't exist yet).

2. **Pick.** Find the first phase in `MVP-PLAN.md` with unchecked items. Within that phase, pick the smallest next checkbox you can complete in roughly one focused chunk.

3. **Implement.**
   - Make the change. Use Bun + TypeScript. Match cells's conventions (`~/Projects/cells/cli/cells.ts` is the style guide).
   - Write tests where it makes sense (`*.test.ts` colocated). Run with `bun test`.
   - Don't introduce abstractions beyond what the checkbox requires. No premature generalization.
   - Don't add error handling for cases that can't happen. Trust internal code.

4. **Commit.**
   - Stage only the files you actually changed (`git add <paths>`, not `git add -A`).
   - Commit message: `phase <N>: <one-line description of what was done>`.
   - End the commit with the standard trailer:
     ```
     Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
     ```

5. **Update the plan.**
   - In `docs/MVP-PLAN.md`, tick the checkbox(es) you just completed.
   - If you completed an entire phase, add `**Done — <yyyy-mm-dd>.**` under the phase title.
   - Commit the doc change in the same commit (preferred) or as a separate `phase <N>: tick checkbox` commit right after.

6. **Stop.** Don't try to start the next checkbox. The next loop run picks it up. Bounded autonomy is the whole point — small, frequent, recoverable progress.

## When the MVP is complete

When every checkbox in `MVP-PLAN.md` is checked:

- Add `**MVP complete on <yyyy-mm-dd>.**` at the top of `MVP-PLAN.md`.
- Commit.
- Stop. Pete will decide whether to squash to main, tag a version, or move to the next roadmap phase.

## Hard rules

- **No unilateral scope changes.** If a phase needs revising or a new phase added, write the proposal to `docs/BLOCKED.md` and stop. Pete reviews and decides.
- **Don't commit secrets.** Tokens, ssh keys, env files — all stay out.
- **Don't commit large binaries or downloaded base images.** They go in `~/.splites/` (already in `.gitignore`) or under `images/` (also gitignored).
- **No destructive git ops.** No `push --force`, no `reset --hard` to remote, no branch deletion you didn't create this run.
- **Don't delete `~/.splites/`** — that's user state. Don't even `rm -rf` parts of it without a checkbox that explicitly calls for it.
- **Don't invoke `/loop` or `/mvp-splites` from within a loop run.** No recursion.
- **Lume vendoring:** if the pinned commit becomes unreachable or the upstream is gone, write to `BLOCKED.md` and stop. Do not silently switch to a different commit.
- **Phase 10 touches `~/Projects/cells`.** Treat that repo with the same branch discipline — work on a feature branch in cells, don't commit to its main.

## Style

Match the global CLAUDE.md vibe (`~/.claude/CLAUDE.md`): opinions over hedging, brevity, no sycophancy. Don't write code comments unless they explain a non-obvious why. Don't write README sections that aren't needed yet. Don't add features beyond the checkbox.
