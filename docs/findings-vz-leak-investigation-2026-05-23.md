# Findings — VZ leak investigation, dev variant matrix

**Date:** 2026-05-23
**Status:** Investigation paused — bug does not reproduce in dev. Stable's intermittent failures remain the only signal.
**Trigger:** Cells team forwarded a zero-team report of 5× failed hibernate-restores on `egg-c5e25a` over a 25–30 hr workload, intermittent, eventually self-healing after 10 min – 2 hr.

## TL;DR

- The XPC kill (W.74) IS the load-bearing intervention for hibernate→wake. Without it, restore fails 100% with `"storage device attachment is invalid"`.
- Signal type (SIGTERM vs SIGKILL) doesn't matter — both work.
- The 250 ms settle delay (W.75) is defensive insurance, not required for correctness in dev tight loops.
- Multi-VM concurrent stress under our wake-gate serialization doesn't reproduce the bug either.
- **The intermittent "permission denied" (VZErrorRestore code 12) that hits stable did not surface in any dev configuration we tried.**
- Strongest remaining hypothesis (carried forward from W.74 commit notes): system-wide pressure — memory, mach ports, or some other VZ-kernel-resident state — that we haven't replicated.

## Background

The bug surfaces as `lume.restoreState` returning HTTP 400 with VZ's `"permission denied"` message. Lume's W.77 NSError logging on stable captures every failure as:

```
domain=VZErrorDomain code=12 (VZErrorRestore)
userInfoKeys=["NSLocalizedFailureReason", "NSLocalizedFailure"]
underlying= (empty)
failureReason="The virtual machine failed to restore with error 'permission denied'."
```

Apple's framework is opaque about the underlying cause. No NSUnderlyingError chain. The "permission denied" string is VZ's, not POSIX `EACCES` from a file operation — disk perms verified fine in W.27.

## Phase 1 — baseline hibernate/wake loop on dev

- 1 well (`dev-restore-probe-01`), ubuntu-25.10-base, sealed.
- 100 cycles back-to-back at ~2 s/cycle wall clock, gap ~100 ms between hibernate and wake.
- **Result: 100/100 ok, 0 failures.** p50 hibernate 195 ms, p50 wake 825 ms.

The bug does not surface in a tight single-VM loop.

## Phase 2 — variant matrix

To find which part of W.74/W.75 is load-bearing, instrumented `lib/lifecycle.ts` and `lib/xpcChild.ts` with three env knobs:

- `WELL_DISABLE_XPC_KILL=1` — skip the per-VM XPC kill entirely.
- `WELL_XPC_KILL_SIGNAL=SIGTERM` — use SIGTERM instead of SIGKILL.
- `WELL_XPC_SETTLE_MS=N` — change the 250 ms settle delay.

Each variant ran on a freshly-bounced dev welld and freshly-sealed probe well.

| Variant | Cycles | Pass | Fail | Failure shape |
| --- | --- | --- | --- | --- |
| baseline (default W.74) | 100 | 100 | 0 | — |
| no-XPC-kill | 11 | 0 | 11 | `"Invalid virtual machine configuration. The storage device attachment is invalid."` (cycle 1, every cycle) |
| SIGTERM kill | 50 | 50 | 0 | — |
| settle=0 ms | 100 | 100 | 0 | — |

**Skip-kill produces a different error than stable's intermittent failure** — `storage device attachment is invalid` vs `permission denied`. Both are "VZ disagrees with the saved-state contract", but Apple emits different strings depending on what specifically lined up wrong. This is consistent with our W.77 commit note: "the string mutates across substrate state (saw 'permission denied' → 'Internal Virtualization error' on re-wake of the same VM)."

**Key takeaway**: the *symptom family* (VZ rejecting restore for state-internal reasons) is reproducible with skip-kill. The *specific symptom* (intermittent permission-denied) is not — which means stable's bug isn't "the kill sometimes fails." Something else periodically prevents restore from succeeding even with a clean XPC kill.

## Phase 3 — multi-VM concurrent stress

3 wells (`dev-multi-1/2/3`), each in its own hibernate/wake loop with randomized jitter, all firing into the same dev welld + lume serve. 80 cycles per well = 240 cycles total. Wake gate cap stays at 1 (admission control serializes restoreState).

**Result: 240/240 ok, 0 failures.**

Cross-VM contention under our existing wake-gate serialization does not trigger the bug.

## What I checked from stable's logs

Cross-referenced stable's `welld.log` + lume's W.77 NSError logs for the 18:13Z and 20:21Z failure clusters on `egg-c5e25a`:

- **Single-VM workload at failure time**: only `egg-c5e25a` was being touched in the 4-minute failure window. No other welds, no concurrent operations against lume serve.
- **Clean prior hibernate**: `hibernateWell: released VZ kernel state via XPC kill name=egg-c5e25a pid=81461` confirmed cleanly. Subsequent wake failed 46s later with VZErrorRestore code 12. No log evidence of XPC kill failing.
- **Self-healing after ~2 hours**: failed at 18:13:53Z, kept failing through 18:16:50Z and 20:21:42Z, then succeeded at 20:28:17Z. **Nothing in welld or lume logs suggests what changed to enable recovery.** No host reboot. No welld bounce. No lume respawn. Just time.
- **No drift**: VZ config snapshot diff (B.0.9.a diagnostic) shows save and restore configs are byte-identical apart from `label` and `timestamp`. The device graph isn't mutating.
- **Same disk path, same hibernate.bin** for both successful and failing restores (file path is the operative input to VZ).

## Hypotheses still open

1. **Memory/mach-port pressure**. From the W.74 commit note: "Memory pressure with 12 VMs on a 48GB machine is the leading hypothesis" for similar intermittent restore errors. Stable currently runs ~10 wells; egg-c5e25a's failure happened during a busy period. Not yet measured precisely.
2. **VZ kernel-resident state with hours-long TTL**. The 2-hour-then-recovery pattern is suspicious. Apple's Virtualization.framework registers per-VM state with the kernel; killing the user-space XPC child may not synchronously release every kext-side allocation. If there's a GC cycle on kext state, we'd see "stuck" → "free" without any user-space event.
3. **Long-running provisioned-VM state**. `egg-c5e25a` had been alive for ~24 hours before the failure cluster, with many hibernate/wake cycles. Our dev probe wells are minutes old. Something accumulates that fresh wells don't have.
4. **Periodic macOS daemon interference**. `mds`/Spotlight indexing, Time Machine snapshots, `fseventsd` watchers — any of these could briefly hold the disk path open. We haven't measured.

## What did NOT cause the bug (eliminated by this investigation)

- W.74's per-VM XPC kill mechanism: confirmed to work cleanly when it runs.
- Signal choice (SIGTERM vs SIGKILL).
- Settle delay length (0 ms works fine in dev, 250 ms is just insurance).
- Multi-VM concurrency under our wake-gate serialization.
- Wake-after-tight-cycle. 100 cycles in <4 min: zero failures.

## Next steps (need Pete's call)

The most useful next probe would instrument stable directly to capture in-flight diagnostic state the instant a real failure happens — because the bug refuses to reproduce in dev no matter how I push it. Specifically:

1. **Add a diagnostic capture hook to the wakeWell error path** that, on `restoreState` failure, snapshots:
   - `lsof` of the well's disk.img path and hibernate.bin path
   - All `VirtualMachine.xpc` PIDs alive (sanity-check the kill worked)
   - `vm_stat` and `sysctl vm.swapusage` (memory snapshot)
   - `log show --predicate 'subsystem == "com.apple.Virtualization"' --last 5m` (best-effort; Apple may restrict this)
   - `dtrace -n 'vminfo:::pgin { @[execname] = count(); }'` for 5 s (process-level paging activity)
   - Dump to `~/.wells/diag/<timestamp>/`.
2. **Stable rollout is the only way to catch it**. Dev never sees the failure; the entire investigation needs to wait for a real production failure with diagnostics armed.
3. **Reproducer requires longer/heavier workload**. Our 4-minute tight loops never fail. A long-running multi-VM run with realistic memory pressure (10+ VMs, 1 GB each, on a 48 GB host) over hours might reproduce — but we can't burn that machine resource on dev.

Both #1 and #2 need Pete's sign-off because they touch stable. #3 needs Pete to decide whether running an extended pressure test is worth the host resource cost.

## In plain English

We tried to break our own wake-from-hibernate flow several different ways to find what causes the random "permission denied" errors that cells team's eggs sometimes hit. We confirmed that the fix we put in (W.74's per-VM XPC kill) IS doing useful work — without it, hibernate→wake fails instantly, 100% of the time. With it, our dev loop never fails, even when we deliberately strip parts of the safety net or run several VMs at once.

So we know our code is doing the right thing in principle. But stable's wells still occasionally fail with "permission denied" — and this investigation didn't reveal why. The strongest clue is that those failures self-heal after about 2 hours without anyone touching the system, suggesting something deep in macOS/Apple's hypervisor framework has stale state that times out on its own.

To find the actual cause we'd need to add diagnostic capture to stable, then wait for the next real failure with logging armed. That's the only path forward — dev can't reproduce the bug no matter what we throw at it.
