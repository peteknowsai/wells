# Finding — welld state desync: a stale `runtime.json` makes a well un-hibernatable forever

**Filed by:** cells team · 2026-05-22
**Severity:** high — defeats autosleep, the core "pack more cells per box" lever
**Scope:** wells substrate (`welld`). Not a cells bug. Not caused by the recent cells bridge-direction-flip (verified — see below).

## Symptom

`egg-0f7d66` (cell `nfv-market-cc`) has been idle ~25+ min with a correct
`auto_sleep_seconds: 60`, and the watchdog **will not** hibernate it. Every
30s tick:

```
{"msg":"watchdog: hibernating idle well","name":"egg-0f7d66"}
{"msg":"transitionWell: noop","name":"egg-0f7d66","verb":"hibernate","state":"stopped"}
{"msg":"watchdog: tick hibernated wells","hibernated":["egg-0f7d66"]}
```

The watchdog decides correctly. `transitionWell` then **no-ops** because it
believes the well is already `stopped`. The watchdog logs it as "hibernated"
and moves on. The VM runs forever.

## Evidence — welld's record is a lie

`~/.wells/vms/egg-0f7d66/runtime.json`:

```json
{ "state": "stopped", "last_transition_at": "2026-05-20T00:22:18.492Z", ... }
```

But:
- `well list` → `egg-0f7d66  running  192.168.64.232`
- `lume` reports it `running`; `xpc_child_pid` is live; the cell is SSH-responsive.
- `welld.log` transition history shows it woke to `alive_running` at
  **2026-05-20T00:23:43** — i.e. *after* the `runtime.json` timestamp.

So `runtime.json` froze at `stopped` / `00:22:18` and was never re-persisted
through the subsequent transitions.

## Root cause — two defects, stacked

**1. `transitionWell` (and the `start` path) trust cached state and never reconcile against lume.**
`transitionWell` short-circuits to `noop` when its tracked `state` already
equals the target — without ever checking lume's *actual* status. `well start`
on this well also no-ops: it detects `alreadyRunning: true` (`lib/lifecycle.ts:196`),
returns `running`, and **still does not write the record back to `alive_running`**.
Every actuator trusts a record that reality has diverged from. There is no path
that repairs a desynced record.

**2. `runtime.json` stopped being persisted mid-transition.**
The `welld.log` history for `egg-0f7d66` around 2026-05-20 00:22–00:23 shows a
storm of ~10 `wake`/`hibernate`/`stop` transitions in 90s — and *every* `wake`
logged `from:"hibernating"`, even back-to-back wakes. welld never durably held
`alive_running`: transitions were logged and applied in-memory but `runtime.json`
was last written at 00:22:18 and never again. Whatever serializes `runtime.json`
dropped writes (or threw silently) during that storm.

The startup policy compounds it: `daemon/welld.ts:256-264` — *"runtime.json
wins on startup; hibernating + stopped stay untouched."* So once `runtime.json`
is wrongly `stopped`, a welld restart **preserves the lie** (and the defensive
resume at `:230-246` only `lume.resume`s VMs lume already reports `running` —
it does not reconcile welld's own `state` record against that list).

## Why the cells bridge-flip is *not* the cause

Initial suspicion was the cells bridge-direction-flip (cell now holds a
persistent outbound WS). Ruled out by evidence:
- `lsof -nP -iTCP@192.168.64.232 -sTCP:ESTABLISHED` on the host → **zero**
  connections. The bridge WS dials VM→Cloudflare directly; it never crosses
  the host, so it is invisible to `lib/activity.ts`'s probe. The activity
  probe is *not* implicated.
- The desync timestamp (2026-05-20 00:22) **predates the flip by two days**.

## Impact

- The watchdog is the *only* mechanism that sleeps an idle cell that never ran
  a turn (the cooperative `POST /sleep` only fires after an `agent_end`). A
  desynced well is invisible to it permanently.
- `POST /sleep` would not save a desynced well either — it routes through the
  same `transitionWell`, which no-ops.
- Currently 1 well affected (`egg-0f7d66`), but the defect is latent
  fleet-wide: any transition storm can re-trigger it.

## Proposed fix (wells side)

1. **Reconcile against lume before trusting cached state.** The watchdog
   already calls `lume.list()` every tick (`daemon/welld.ts:1345`) — it has
   ground truth in hand. When welld's `state` says `stopped`/`hibernating`
   but lume says `running`, repair the record to `alive_running` and proceed
   with the intended transition, rather than no-opping.
2. **Persist `runtime.json` on every transition**, and fail loudly if the
   write throws — the 00:22 storm shows writes were silently lost.
3. **Reconcile on startup**, not just `lume.resume`: cross-check each well's
   `runtime.json.state` against `lume.list()` and correct mismatches before
   the resurrection pass acts on them.

## Operational recovery needed now

`egg-0f7d66`'s record must be corrected so `nfv-market-cc` can finally sleep.
A plain welld restart will *not* do it (startup policy keeps the stale
`stopped`). Suggested: with welld stopped, hand-edit
`~/.wells/vms/egg-0f7d66/runtime.json` `state` → `"alive_running"`, then start
welld so the resurrection pass adopts it as a running well. (Wells team's call
on the exact procedure — flagging rather than doing it, since it's substrate
state.)

---

## Resolution (wells team · 2026-05-22)

Fixed on branch `fix/welld-state-desync`. Confirmed the diagnosis, and found
the *deeper* cause behind defect #1: `lib/reconcile.ts` already shipped the
reconciliation machinery (`reconcileWell` / `reconcileAll` / `observeState`,
B.0.7.d) — **but it was never wired into the daemon.** Dead code. Every
actuator trusted the cache because nothing ever corrected it.

**The fix — reconcile against lume inside the watchdog tick:**
`lib/reconcile.ts` gains `isStaleDownRecord()` (pure) + `repairStaleDownRecords()`.
The watchdog (`daemon/welld.ts`) already calls `lume.list()` every 30s and
builds `runningLumeNames` (its existing "really running" set — status=running
*and* an IP, which already rejects lume's sticky-running-after-XPC-death false
positive). We now reconcile against that set **before** `runWatchdogTick`
dispatches: any well whose `runtime.json` reads `stopped`/`hibernating` while
lume genuinely runs it (and no `hibernate.bin` exists) is repaired to
`alive_running`. The hibernate then dispatches for real instead of no-opping.

Deliberately narrow vs. your proposal #1 — we repair *only* the
(recorded-down, lume-running, no-hibernate-file) class:
- A `hibernate.bin` next to a live VM is an **orphan**, not this trap — that
  stays `error_orphaned`'s job. Repairing it would mask a failed teardown.
- `alive_paused` is excluded: lume can't distinguish paused from running, so a
  paused-vs-running record is reconcile's genuinely-ambiguous case. Not this one.

**Defect #2 (silently-lost runtime writes):** we couldn't reproduce the
00:22 storm's dropped writes — `writeRuntime` is atomic (tmp + rename) and
throws on failure. Rather than chase that ghost, the watchdog repair makes the
system **self-healing**: even if a write is lost again, the next 30s tick
repairs the record. `repairStaleDownRecords` never swallows a write error —
it propagates so the watchdog logs it loud (`watchdog: stale-record repair
failed`, error level).

**Proposal #3 (reconcile on startup):** intentionally *not* done as stated —
it's unsafe. On a welld restart lume reports the just-clipped VMs as `stopped`
(the XPC-children cycle, see `welld.ts:256`), so a startup reconcile would
"correct" `alive_running` → `stopped` and defeat resurrection. The watchdog
runs its first tick within 30s of startup, after VMs settle — that covers the
post-restart desync case without the footgun.

**egg-0f7d66 recovery:** no hand-edit needed. Once welld is bounced onto this
branch, the first watchdog tick sees lume running it + no `hibernate.bin` +
record `stopped` → repairs to `alive_running` → hibernates it on the same
tick. The fix *is* the recovery.

Tests: `lib/reconcile.test.ts` +14 (pure matrix for `isStaleDownRecord`, IO
for `repairStaleDownRecords` incl. the exact egg-0f7d66 shape). Full suite green.
