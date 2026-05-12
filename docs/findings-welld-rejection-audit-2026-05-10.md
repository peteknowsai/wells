# findings — welld unhandled-rejection / log-error audit (W.12)

**Scope:** walked `~/.wells/welld.log` (stable, 279 KB) and `~/.wells-dev/welld.log` (dev, 184 KB). Classified every entry at `level: error` or `level: warn` over 2026-05-08 → 2026-05-10. Decided whether each pattern is (a) genuinely safe to swallow, (b) should propagate / exit, or (c) is a real bug worth filing.

## Summary

| Pattern | Count | Verdict | Action |
|---|---|---|---|
| `uncaught exception — continuing` ("Failed to start server. Is port in use?") | 7 (6 stable + 1 dev) | **(b) propagate** — should exit, not swallow | Ship fix as **W.19** |
| `watchdog: hibernate failed` (lume 400 / state=error / socket closed) | 4 | **(a) safe-ish** but **(c) noisy** — needs backoff | Ship backoff fix as **W.20** |
| `lume serve unresponsive; respawning` (warn) | 60 over 2 days | **(c) real bug** | Already in scope as **W.6 / W.13 / B.0.11.h** |
| `killAndRestart: no supervised PID, falling back to pkill` (warn) | 1 | **(a) safe** — pre-supervisor-fix code path | No action; supervisor fix `b27ad05` makes this rare |
| `lume serve exited; respawning` (warn) | 1 | **(a) safe** — supervisor caught it | No action |
| `captured pre-respawn stack sample` (warn) | 6 | informational | No action |

No sustained pattern of `cell sleep failed`, ssh hangs, or R2 errors in either log. Watchdog and lume-hang are the two attention areas.

## Pattern A — uncaught port-bind failure ("Failed to start server")

**Sample (stable, 2026-05-10 04:22:30 UTC):**

```json
{
  "ts": "2026-05-10T04:22:30.731Z",
  "level": "error",
  "msg": "uncaught exception — continuing",
  "err": "Failed to start server. Is port 7878 in use?",
  "stack": "Error: Failed to start server. Is port 7878 in use?\n    at serve (unknown)\n    at /Users/pete/Projects/splites/daemon/welld.ts:224:20"
}
```

Five of the six stable hits clustered around manual restart attempts where the operator (Pete or me) launched a new welld while the prior one was still bound. The `uncaughtException` handler at `daemon/welld.ts:150-155` logs "continuing" — which is misleading. Bun's `serve(...)` throws when the port is taken; without a bound socket, welld can't actually do its job. The process just sits there holding the in-memory token, the watchdog timers (which can't reach lume since this welld isn't the lume owner anymore), and the lume supervisor (which fights the other welld's supervisor for control). It's a zombie.

**Verdict:** (b) propagate. The error is fatal in practice; pretending we can keep going wastes operator time chasing why the new welld isn't responding. Exit with code 1 so any supervisor (launchctl, ad-hoc nohup loop, etc.) sees the bind failure.

**Proposed fix:**

```typescript
process.on("uncaughtException", (err: Error) => {
  // Port-bind failure means welld can't serve HTTP — there's no
  // graceful "continue" possible. Exit so the operator (or process
  // supervisor) sees the failure instead of a silent zombie.
  if (/Failed to start server|EADDRINUSE/.test(err.message)) {
    log.error("uncaught exception — fatal port bind, exiting", {
      err: err.message,
    });
    process.exit(1);
  }
  log.error("uncaught exception — continuing", {
    err: err.message,
    stack: err.stack,
  });
});
```

Track as **W.19** in the queue. ~10 min ship.

## Pattern B — watchdog: hibernate failed

**Sample (stable, 2026-05-09 20:55:22 UTC, three entries within 117ms):**

```json
{"ts":"...22.337Z","msg":"watchdog: hibernate failed","err":"lume POST /lume/vms/smoke-moytm4uf-1/save-state → 400: 'Internal Virtualization error. The virtual machine stopped unexpectedly.'"}
{"ts":"...22.454Z","msg":"watchdog: hibernate failed","err":"... 'Invalid virtual machine state transition. Transition from state \"error\" to ...'"}
{"ts":"...22.459Z","msg":"watchdog: hibernate failed","err":"... 'Invalid virtual machine state transition ...'"}
```

Three failures in 117ms is the watchdog hammering a VM that's in the "error" state because the prior hibernate attempt SIGed it. The handler at `daemon/welld.ts:1639-1654` is genuinely best-effort — comment says "next tick retries" — but the watchdog tick runs every 30s, not every 100ms, so three back-to-back hits in 117ms is suspicious. Either the watchdog tick is being called multiple times per scheduled run, OR a single tick walks every running well and hits the same well three times.

Reading `runWatchdogTick`: yes, the for-loop walks `args.records` and calls `args.stopWell` per record. So if three test wells were all in the bad state in the same tick, that's the explanation — not a re-entrancy bug. Each one's failure is independent.

The fourth entry (2026-05-09 22:13:23 UTC) was during a lume respawn — socket closed unexpectedly — also expected.

**Verdict:** (a) safe to swallow per current contract, BUT (c) the noise tells us welld doesn't backoff per-well after consecutive failures. If a well is permanently stuck in `error` state, the watchdog will retry on every tick (30s) forever and grow the log. A simple "this well failed hibernate 3 times in a row, mark it dead-stuck and stop trying" guard would clean this up without changing semantics for the happy path.

**Proposed fix (W.20):** add a per-well consecutive-failure counter to the watchdog state. After N (e.g., 5) consecutive hibernate failures, log once at `warn` level and skip until the well is removed or restarted. ~30 min.

## Pattern C — lume serve unresponsive; respawning

60 occurrences over 2 days, ~3-5 per hour during active welld use:

```
2026-05-08T21  ××
2026-05-08T22  ████████████░
2026-05-08T23  ████
...
2026-05-09T20  ██████████
2026-05-10T06  ███
```

The supervisor's hang detector fires when lume's `/healthz` doesn't respond within the timeout. Each fire SIGKILLs lume and respawns. This is the W.6 (Lume @MainActor variance) territory — a real bug at the lume layer (Swift main-actor blocked on blocking IO, ARP fallback, etc., per the partial fixes already in B.0.11.h). The 6 stack samples at `/tmp/lume-hang-*.txt` are exactly what W.6 needs as input.

**Verdict:** (c) real bug, **already tracked as W.6 + W.13**. No new action from this audit; the lume hangs ARE the work. The audit just confirms they're frequent enough that prioritizing W.6's stress-and-fix cycle is worthwhile when dev welld is unblocked (W.18).

## What worker did

- Walked stable + dev welld logs end-to-end, classified `level: error` and `level: warn` entries.
- No new findings outside the four listed patterns above.
- W.19 (port-bind fatal exit) and W.20 (watchdog backoff) added to BOARD as separate code-fire tasks per W.12's contract ("code changes follow as separate fires").
- Did NOT ship either fix this fire.

## Closes

W.12 — audit deliverable shipped. W.19 + W.20 are follow-ups; whoever picks them up should re-read this doc for the rationale.
