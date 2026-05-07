# Blocked — 2026-05-06

## Phase A.1.3.e.1 — Hot-tier lume patch hit Swift strict-concurrency wall

**Tried:** Added `pauseVM`/`resumeVM` to `LumeController.swift`, `pause`/`resume` to `VM.swift`, HTTP routes for `/lume/vms/:name/pause` and `/resume`, handlers in `Handlers.swift`. ~150 lines as estimated.

**Failed:** `swift build -c release` reports 5 errors, all about Swift strict-concurrency:

```
LumeController.swift:976:24: error: expression is 'async' but is not marked with 'await'
LumeController.swift:998:31: error: expression is 'async' but is not marked with 'await'
LumeController.swift:1001:26: error: main actor-isolated instance method 'get(name:storage:)' cannot be called from outside of the actor
LumeController.swift:1006:13: error: expression is 'async' but is not marked with 'await'
LumeController.swift:1010:13: error: expression is 'async' but is not marked with 'await'
```

**Root cause analysis:**
- `SharedVM.shared` is `@MainActor`-isolated. Calling its methods from non-@MainActor functions requires either `await MainActor.run { … }` or marking the calling function `@MainActor`.
- My `pauseVM`/`resumeVM` aren't `@MainActor`. Errors at line 976 (mine).
- BUT: `stopVM` ALSO isn't `@MainActor` and ALSO calls `SharedVM.shared.getVM`/`removeVM`. Errors at lines 998, 1001, 1006, 1010 (existing code).
- These existing-code errors don't fire when only OTHER files change (incremental build skips re-checking `LumeController.swift`). Touching the file forces a full re-check, which surfaces the latent issues in `stopVM`.

So shipping hot tier safely requires patching `stopVM` too — i.e., touching upstream lume code I didn't intend to change.

**Options for unblocking:**

1. **Mark all four (pauseVM, resumeVM, stopVM, the related calls) `@MainActor`.** Cleanest fix. But it changes the actor-isolation of an upstream-pinned method. Could shift behavior in subtle ways for callers. Need to audit who calls `stopVM` and whether they can be `await`-ed from a MainActor context.
2. **Use `await MainActor.run { … }` blocks** around the SharedVM calls in pauseVM/resumeVM/stopVM. More invasive but doesn't change function-level isolation.
3. **Pause and check upstream lume.** Maybe there's a newer commit that already fixed this. Re-vendor against that, then patch.
4. **Pivot to a different approach for hot tier.** E.g., do pause/resume via splited shelling out to a Swift one-shot that runs in a MainActor context. Bigger architectural detour.
5. **Defer hot tier; do warm tier first.** Warm has the same SharedVM issue, so it doesn't actually escape this. Skip.

**Recommendation:** Option 1, with the audit. The MainActor annotation belongs there anyway — these methods touch `SharedVM` and `VZVirtualMachine`, both MainActor-bound. It's a 4-line change to the upstream code, justified.

But I'm not going to ship that unilaterally — it modifies upstream lume's lifecycle methods, not just adds new ones. Pete's call.

**State on disk:**
- All ~150 lines of patch code reverted (`git checkout -- vendor/lume/`).
- Base lume builds clean.
- `bin/lume` is the pre-patch binary.
- `docs/state-tiers.md` already documents what was learned about VZ + lume primitives in §Discovery.
- Splited + cloudflared + pete all unaffected.

**What to do next time the loop fires:**

If this blocker is unresolved, skip to A.1.3.d (activity-detection prototype) or A.1.3.c partial (cold-only benchmarks). The hot tier patch sits until Pete picks an option above.
