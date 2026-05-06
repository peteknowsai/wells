# Blockers

Open questions / decisions needed from Pete. Loop runs read this file first and skip new work while there's an open blocker.

When resolving: edit/remove the relevant entry, commit, and the next loop run picks back up.

---

## 2026-05-06 — Phase 1 final smoke test: lume isn't a "fresh install"

**Context.** The last unchecked Phase 1 box reads:

> Smoke test: daemon-side `engine.list()` returns `[]` against a fresh install

Verification on Pete's machine:

- `engine.list()` returns a typed array — wrapper is correct.
- But the array has 1 entry: a stopped macOS VM named `test-cell` (cpuCount: 4, memorySize: 8 GiB, diskSize allocated: ~31 GiB / total: 64 GiB, locationName: "home"). Likely a leftover from cua experimentation predating splites.
- Lume reports `vm_count: 0` in `/lume/host/status` (probably because `test-cell` is stopped, not running) — but `/lume/vms` returns it regardless.

So the box can't be ticked as literally specified. Three ways forward:

**(a) Soften the spec.** Change the box text to "engine.list() returns successfully (empty or otherwise)". This honors the actual contract — the wrapper round-trips a real call to lume — and tolerates pre-existing VMs.

**(b) Clean up first.** Delete `test-cell` (it's almost certainly old test-bench output): `lume delete test-cell`. Then `engine.list()` returns `[]` and the box passes literally.

**(c) Add a setup step.** Add a sub-checkbox to the box: "first, ensure no pre-existing VMs in the local lume cache". This codifies the cleanup as part of the smoke test.

**Recommendation: (a).** "Wrapper round-trips a successful call" is the actual signal we care about. `[]` was a thinko — it implies a clean baseline that we don't actually need. Forcing the user to nuke their existing lume state to satisfy a smoke test is hostile.

**To resolve:** Pick (a), (b), or (c). If (a), edit the box text in `MVP-PLAN.md`. If (b), say the word and I'll `lume delete test-cell`. If (c), I'll add the sub-checkbox.
