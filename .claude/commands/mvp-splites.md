---
name: mvp-splites
description: Make one bounded chunk of progress on the splites phased plan (docs/MVP-PLAN.md). Find the next unchecked checkbox in the first incomplete phase, implement it, test it, commit, update the plan. Drives MVP, Phase A, Phase E, and beyond.
---

# /mvp-splites — make one chunk of progress

You are working on the splites project at `/Users/pete/Projects/splites`. The phased plan lives at `docs/MVP-PLAN.md` (covers MVP and post-MVP phases). Your job, this run: make one bounded chunk of progress.

## Steps

1. **Orient.**
   - `cd /Users/pete/Projects/splites`
   - Read `docs/MVP-PLAN.md` and (if it exists) `docs/BLOCKED.md`.
   - `git status` and `git log --oneline -10` to see what was done.
   - If `BLOCKED.md` has an open blocker that hasn't been resolved by Pete, do not start new work. Re-check whether the blocker is still real (state may have changed). If it is, append a short note to `BLOCKED.md` with today's date, commit, and stop.
   - **Identify the active phase**: the first phase in `MVP-PLAN.md` with unchecked items.
   - **Verify you're on the right branch**: each phase has a feature branch (MVP → `feature/mvp` (merged), Phase A → `feature/phase-a`, Phase E → `feature/phase-e`). If the active phase's branch doesn't exist, create it from `main`. Don't commit to `main` directly — that's reserved for phase squash-merges.

2. **Pick.** Within the active phase, pick the smallest next unchecked checkbox you can complete in roughly one focused chunk.

3. **Implement.**
   - Make the change. Use Bun + TypeScript. Match cells's conventions (`~/Projects/cells/cli/cells.ts` is the style guide).
   - Write tests where it makes sense (`*.test.ts` colocated). Run with `bun test`.
   - Don't introduce abstractions beyond what the checkbox requires. No premature generalization.
   - Don't add error handling for cases that can't happen. Trust internal code.

4. **Commit.**
   - Stage only the files you actually changed (`git add <paths>`, not `git add -A`).
   - Commit message: `phase <letter-or-number>: <one-line description of what was done>` (e.g. `phase A.1: idle watchdog skeleton`).
   - End the commit with the standard trailer:
     ```
     Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
     ```

5. **Update the plan.**
   - In `docs/MVP-PLAN.md`, tick the checkbox(es) you just completed.
   - Commit the doc change in the same commit (preferred) or as a separate `phase <N>: tick checkbox` commit right after.

6. **Phase rollover.** If your work checked the last unchecked box in the active phase:
   - Add `**Done — <yyyy-mm-dd>.**` under the phase title in `docs/MVP-PLAN.md`. Commit.
   - Squash-merge the phase's branch to `main`: `git checkout main && git merge --squash <branch> && git commit && git tag <version>` (Phase A → `v0.2.0`, Phase E → `v0.3.0`).
   - Don't push. Pete pushes when ready.
   - **Stop.** Don't start the next phase in the same loop run.

7. **Otherwise: stop.** Don't try to start the next checkbox in the same run. The next loop run picks it up. Bounded autonomy is the whole point — small, frequent, recoverable progress.

## Hard rules

- **No unilateral scope changes.** If a phase needs revising or a new phase added, write the proposal to `docs/BLOCKED.md` and stop. Pete reviews and decides.
- **Don't commit to `main` directly.** Only phase-end squash-merges land on `main`. All other commits land on the active phase's `feature/phase-<x>` branch.
- **Don't commit secrets.** Tokens, ssh keys, env files — all stay out.
- **Don't commit large binaries or downloaded base images.** They go in `~/.splites/` (already in `.gitignore`) or under `images/` (also gitignored).
- **No destructive git ops.** No `push --force`, no `reset --hard` to remote, no branch deletion you didn't create this run.
- **Don't delete `~/.splites/`** — that's user state. Don't even `rm -rf` parts of it without a checkbox that explicitly calls for it.
- **Don't invoke `/loop` or `/mvp-splites` from within a loop run.** No recursion.
- **Lume vendoring:** if the pinned commit becomes unreachable or the upstream is gone, write to `BLOCKED.md` and stop. Do not silently switch to a different commit.

## Style

Match the global CLAUDE.md vibe (`~/.claude/CLAUDE.md`): opinions over hedging, brevity, no sycophancy. Don't write code comments unless they explain a non-obvious why. Don't write README sections that aren't needed yet. Don't add features beyond the checkbox.
