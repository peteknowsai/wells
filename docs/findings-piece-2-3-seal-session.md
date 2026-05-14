# Findings — Piece 2 + Piece 3 + /seal session

**Date:** 2026-05-13 (UTC: spanning into 2026-05-14)
**Duration:** ~5 hours
**Outcome:** Boundary cleanup arc closed. Wells main went from `63c3de0` → `33ebd6a` across 8 commits. Cells main moved 7 commits in parallel. Final post-bounce reconcile showed zero drift between the two systems.

## In plain English

Wells (the VM substrate) and cells (the agent platform on top) had grown
entangled in places they shouldn't be — wells held a stash of pre-built
VMs that was really cells's responsibility, and wells had an internal
"warming sequence" baked into create that only existed to serve cells's
hibernate needs. This session moved both out: cells now owns the stash,
and wells exposes a separate `/seal` primitive cells calls explicitly.
Three architectural pieces (Piece 2 / Piece 3 / /seal) shipped clean and
verified, plus four substrate bugs caught and fixed along the way.

The system we built isn't visible to end users — the "click create a
cell, get an alive cell" UX is identical. What changed is that wells
and cells can each move faster on their own surface without the other
breaking. The W.68 incident class (where wells reached into substrate
plumbing to enforce a cells-shaped invariant and broke things) is now
impossible by construction.

## Shipped (in order)

| Commit    | Title                                                       | Net  |
|-----------|-------------------------------------------------------------|------|
| `1ab5160` | Piece 2: delete pool from wells                             | -2301 LoC |
| `4a4b683` | rename sweep: 2 stragglers cells found                      | ±0 |
| `ff51dd7` | Piece 3: delete createWell warming sequence + rename strag  | -156 LoC |
| `eb47da3` | W.78: fast-skip orphan registry entries during startup resurrect | +14 LoC |
| `7fa429c` | add POST /v1/wells/{name}/seal — hibernate-legal warming primitive | +315 LoC |
| `b9040c6` | docs: rewrite cells-pool-builder-primitives.md for post-Pi3 / /seal | +120 LoC |
| `46d7e5e` | two follow-ups from the Pi2/Pi3/seal session (409 + IP race) | +130 LoC |
| `33ebd6a` | docs: drop 409-vs-500 caveat — code matches doc post-bounce | ±0 |

Net code delta: **-1878 LoC**. The boundary cleanup is fundamentally a deletion exercise — Pi2 alone removed 2301 lines of pool code wells had been carrying for cells.

Tests went 980 → 989 across the arc (5 new sealing-handler tests + 4 new ipPool reservation tests + 1 new 409-path hibernation test - 1 incorrect concurrent-allocation assertion).

## Substrate bugs surfaced and fixed

Cells's verification was a stress-test that surfaced wells-side issues nobody had seen in single-create paths:

1. **W.78 resurrect-queue jam** (post-Pi2 bounce, 19:08Z) — 32 pre-bounce ghost wells in registry blocked POST /v1/wells for 20+ minutes. `lume.start` waited behind serial startWell calls that each hit 60s SSH timeouts. Fix: skip when `lume.info` returns null (orphan bundle) instead of falling through to startWell. Per-well cost: 60s → 10ms. Shipped as `eb47da3`.

2. **Splites-path operator-shim** (post-Pi2 bounce, 19:12Z) — `~/.local/bin/well` was hardcoded to the pre-rename `/Users/pete/Projects/splites/cli/well.ts`. Cells's `bakePoolMember → wellExecCapture` calls all returned "Module not found"; `waitForCloudInit`'s retry loop ate the error until its 5min timeout. Cells fixed their copy + flagged the class; I swept wells for stragglers and updated the [folder-rename gotchas memory](../../../.claude/projects/-Users-pete-Projects-wells/memory/feedback_folder_rename_gotchas.md).

3. **Static-IP allocator race** (post-/seal smoke, 19:11Z) — 5 parallel `POST /v1/wells` produced 3 wells; 2 collided on `192.168.64.202`. The `nextStaticIp` mutex serialized the read+pick step but the registry-write happened far later, so concurrent allocators all saw an empty registry. Fix: in-memory `reservedIps` Set. `nextStaticIp` reserves; `currentlyTakenIps` includes reservations; `createWell` `try/finally` releases on success or failure. Shipped as part of `46d7e5e`.

4. **409-vs-500 hibernate refusal** (Pi3 smoke, 19:28Z) — doc said 409 `well_not_hibernate_ready`; code returned 500 `hibernate_failed`. Fix: `HibernateNotReadyError` tagged class on the gate; handler maps `err.code` → 409 instead of generic 500. Shipped as part of `46d7e5e`.

## The /seal architecture

Piece 3 deleted wells's internal warming sequence (which only existed because pre-Pi3 wells had to be "hibernate-ready by default"). That deletion exposed a structural gap: post-Pi3, NOTHING flipped `runtime.hibernate_ready=true`, so `/hibernate` refused every well. Cells's pool builder would have been stuck.

We resolved it with `POST /v1/wells/{name}/seal` — a standalone primitive cells calls AFTER provisioning. It's the same body the warming sequence had (SSH sysrq halt → wait disk released → lume.start no-mount → wait DHCP+SSH → flip runtime), but cells controls when. Architecturally this is **cleaner than pre-Pi3**: the disk-only snapshot captured by hibernate now includes the provisioned cell (DNA, agent stack, env) rather than the bare base image.

Bake flow before/after:

```
PRE-PI3:                       POST-PI3 + /seal:
POST /v1/wells (hibernate_ready=true)    POST /v1/wells (no hibernate_ready)
  └─ create + warm internally              └─ create only
POST /exec (provision)                    POST /exec (provision)
POST /hibernate                           POST /seal  ← new
                                          POST /hibernate
```

Cells's verification numbers post-/seal (V1.5 + V1.10):
- sleep: **589ms** (target 0.6s)
- wake: **380ms** (target 1.9s)
- warm-path alive: **69ms** (target 3s — beat by 43×)

The /seal step itself adds ~6-8s to the bake critical path but that's substrate work the create used to do anyway.

## What worked (coordination patterns)

**Reconcile-before-bounce sequencing.** Cells shipped `reconcilePool()` BEFORE the Pi2 bounce. The reconcile diffs cells's `pool.json` against welld's `GET /v1/wells` and evicts entries welld doesn't have. Without reconcile in flight, the bounce would have produced silent drift (cells thinks pool members exist, welld doesn't). With reconcile, the bounce was non-event: drift was self-healing.

**Separate verification rounds.** Pi2 verified first (V1.5 + V1.10 against Pi2 binary), then Pi3 + /seal verified separately (their own bounce + smoke). Better regression isolation if anything broke we'd know which piece. Took two bounces instead of one but the diagnostic cost is worth it.

**`/comms` slash command for two Claude Code sessions.** Wells's Claude Code (this session) and cells's Claude Code coordinated via `/tmp/claude-comms/cells_wells/` with each side running a Monitor on the peer's outbound log. Manual setup (each side runs `/comms <peer>` once) but persistent across the whole arc. Better than ad-hoc file-tail polling — got immediate notifications on the dozen+ peer messages this session.

**Cells-led coordination.** Pete put cells on coordinator after the initial alignment, and stayed hands-off through the bounces. Cells's plan ("merge → bounce → verify → if green ship Pi3 → bounce again") was the canonical sequence; wells executed, cells verified. Faster than a 3-way back-and-forth.

## The validation moment

After the 4th bounce of the session, cells ran reconcile against the fresh welld:

```
pool_size_before: 12
welld_known:      12
pool_size_after:  12
refill_triggered: false
evicted:          (none — pool is in sync)
```

Zero drift. W.78's fast-skip resurrect held the registry through the bounce; cells's `pool.json` matched welld's `GET /v1/wells` out of the gate. The boundary cleanup arc validated itself: the substrate-drift class that bit us at the start of the session is now an impossibility by construction.

## Open follow-ups

None. Wells queue is empty. Cells queue is empty. Channel stays armed.

The two doc-vs-code mismatches still flagged in `cells-pool-builder-primitives.md` (well_in_transition queues rather than rejects; /seal lock model matches that) are documented honestly and aren't blocking either side. If a future session decides to enforce them as real 409s, that's a small fix.

## Lessons captured in memory

- `feedback_folder_rename_gotchas.md` updated with the `~/.local/bin/well` operator-shim class (gitignored wrappers carrying build-time absolute paths outside the project tree).
- `feedback_push_notify_through_focus.md` created — don't preempt PushNotification's focus suppression based on assumed user attention; let the tool decide.

— wells team · 2026-05-13 / 2026-05-14
