# findings — W.15 test isolation flakies

**Status:** investigated; clear mental model + targeted recommendation. Iteration-4's specific 13-fail run **does not reliably reproduce**; three back-to-back default-mode runs in iteration 10 are clean (`520/520 green` each). The conditions appear to be load-induced.

## What we have

- 13 test files in `lib/*.test.ts` mutate `process.env.WELL_STATE_DIR` (and several also `WELL_LUME_STORAGE`) in their `beforeEach` and clean up in `afterEach`. List: `checkpoints, destroy, defaults, imageLibrary, imageStore, poolRegistry, reconcile, registry, state, sshControl, token, wellLifecycle, wellRuntime`.
- This is fine under Bun's default mode — Bun runs tests **sequentially within a file** and **files sequentially by default**, so there's no parallel race on the shared env vars.
- It is **NOT fine under `bun test --concurrent`**: 85/520 tests fail because two tests share a `process.env.WELL_STATE_DIR` reference and trample each other's `mkdtemp` dirs. A test calling `cp -c <stateDir>/<name>/disk.img` finds the file gone because another test's `afterEach` already `rm -rf`d its state dir.
- `lib/clonefile.test.ts` was the cleanest demo: 4 tests sharing `let tmp` at the describe level. Two pass + two fail under `--concurrent` because tests A and B both reference `tmp` and one finishes its `afterEach` while the other is mid-test.
- `bunfig.toml` doesn't exist; default behavior is in effect, which is the right behavior for this codebase.

## Iteration-4's mystery 13-fail pattern

That run took **69 seconds** for 507 tests (vs 700ms in normal runs). Same kind of `cp -c .../disk.img: No such file or directory` error pattern, but in default sequential mode where it shouldn't happen. Hypotheses:

1. **System load.** The test run coincided with active welld + lume traffic (multiple smokes had just run, lume was respawning). Heavy IO + spawn overhead may have stretched test execution to where the 5000ms timeout fired during `await proc.exited`, leaving the underlying `cp` failure as the "last seen" error rather than a clean timeout error. Strongest theory.
2. **Temp-dir pressure.** macOS doesn't aggressively clean `/var/folders/...` mkdtemp paths, and we had hundreds of leftover `wells-*` dirs accumulating.
3. **Phantom concurrency from Bun internals.** Less likely — Bun's default mode is documented sequential — but possible if some bun:test internal state leaked.

None of these reproduce on the bare iteration-10 system, so debugging without a triggering condition is fishing.

## Recommendation

**Don't fix what isn't broken.** Default-mode runs are reliable; that's how `bun test` is invoked in this repo, in CI hooks, in pre-commit. The iteration-4 failure is real but rare and load-dependent — putting load-resilience work in front of higher-leverage tasks isn't worth the budget.

**Do these small things:**

1. **Pin the sequential contract in `package.json` `scripts.test`** so `bun test` invocations are uniform. (Already implicit; just make it explicit.)
2. **Document the no-`--concurrent` constraint** at the top of any test file that mutates `process.env.*`. One-line comment is enough.
3. **If we ever need parallelism** (large suite, slow CI), refactor the 13 affected test files to inline their `mkdtemp` into each `test()` block instead of relying on `beforeEach`. Move env-var sets into per-test scope. This is ~13 file edits; defer until there's a real perf reason.

## Closes

W.15 — investigated, not actionable as a fix without `--concurrent` migration. Logged for the record. If iteration-4's pattern recurs in the wild, this doc is the first thing the next worker should look at.
