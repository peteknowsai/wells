# Findings: the narrator-signature zombie + auto-recovery (W: cells ask #3)

**Date:** 2026-06-10 · **Incident:** cells-mother unreachable 23:25→00:01 UTC (36 min) · **Fix:** zombie detector + auto-recovery in the watchdog tick (`lib/zombie.ts`)

## In plain English

The bookkeeping layer that manages VMs (lume) sometimes "forgets" a VM
that is actually still running. Wells then has two contradictory notes:
its own notebook says "this VM is up", lume's notebook says "this VM is
stopped". Every attempt to reach the VM consults lume first, tries to
start a second copy, and fails — so the VM becomes unreachable through
wells even though the machine itself may be perfectly healthy. Our old
detector only checked whether the VM answered network connections (it
did!), so nothing flagged the problem for 36 minutes. The fix: wells now
notices when its two notebooks disagree for ~a minute, cleans up the
forgotten VM process, and restarts it — about two minutes of downtime
instead of thirty-six.

## The signature

```
lume.info(name).status == "stopped"   (or VM missing from lume entirely)
runtime.json state    == "alive_running"
VZ XPC child          == alive, holding the bundle disk
```

cells calls this "the narrator signature" — their dashboard's check that
caught the mother incident when welld's wedge field stayed `ok`.

## Why the banner probe couldn't see it

`probeSshBanner` tests host→guest TCP on port 22. In this failure mode
the guest is often *healthy* — sshd answers, banner reads fine, wedge
stays `ok`. What's broken is **lume's view**:

1. lume serve crashes/respawns (or otherwise loses its SharedVM cache);
   the VZ XPC child survives, still running the guest and holding the
   bundle disk via the kernel.
2. `ensureRunning` (every proxy/exec/services wake path) checks
   runtime.json — `alive_running`, not hibernating — then asks lume:
   `stopped`. So it tries `startWell`.
3. The fresh start can't proceed — the orphan child still holds the
   disk — so every API-driven touch of the well fails. The well is
   unreachable *through welld* while the guest itself hums along.
4. `stopWell` no-ops on `lume.info == stopped` (line ~145), so even a
   manual stop+start doesn't clear the orphan; you get the
   "disk still held within 60000ms" seal-fail instead.

`reconcile.ts` (`observeState`) classifies exactly this as
`error_orphaned` — but `reconcileAll` was never wired into the welld
tick, so nothing ever ran it. (Deliberately NOT blanket-wiring it now;
the zombie path below is targeted and lock-safe, the general reconciler
can still mis-flip mid-transition states.)

## The fix (shipped this commit)

**Detection** — in `watchdogTick`, which already holds both views:
`runtime == alive_running && !lumeGenuinelyRunning`, debounced
`ZOMBIE_CONFIRM_TICKS = 2` consecutive ticks (~60-90s) so the
stop-drain window (up to 60s) can't false-positive.

**Recovery** — `recoverZombieWell` (lib/zombie.ts), default ON:

1. take `withWellLock(name)` — serializes against in-flight transitions
2. re-verify the signature inside the lock (a queued stop/start may
   have resolved it; lume saying "running" again aborts — never
   auto-kill what lume claims is alive)
3. SIGKILL the tracked `runtime.xpc_child_pid` (same surgical path
   hibernate uses; W.74)
4. `waitForDiskReleased` on the bundle disk — this is what prevents
   the "disk still held" seal-fail
5. write runtime `stopped` (honest state, preserves all other fields)
6. `dedupedStart(startWell)` — collapses with any wake-on-demand start

Policy mirrors `resurrect.ts`: runtime.json wins; the operator wanted
this well running, converge the world to that.

**Recovery timeline:** detect ≤90s + kill/disk-wait ~1-10s + boot
~10-20s ≈ **2 minutes**, vs 36 minutes observed.

## Bounce-interaction hardening (same day, f1444b1)

Two guards added after pre-deploy review, both about welld bounces:

- **Stale-PID kill guard**: `xpc_child_pid` survives bounces/reboots;
  PID reuse would aim the recovery's SIGKILL at an arbitrary process.
  The pid is verified against `findVzXpcPids()` membership first —
  stale pids skip the kill and fall through to the disk-release wait.
- **Startup grace (10 min)**: post-bounce, every pre-bounce
  `alive_running` well wears the zombie signature until `resurrect.ts`
  drains its serial SSH-gated restart queue. The scan stays silent for
  the first 10 minutes of welld uptime; resurrection owns the
  post-bounce story, the zombie scan only patrols steady state.

## Live-fire postmortem (deploy night, 2026-06-10 ~05:00Z)

Staging the proof crashed lume serve for real (direct engine stop on a
dead-child VM), killing every VZ child — an accidental full-fidelity
test of the whole recovery stack. What we learned:

- **The layered story works.** Wells WITH traffic never needed the
  detector: cells's normal polling wake-on-demand'ed mother/pulse back
  ~3 min after the crash (autosleep corrected the dead record, the next
  inbound touch booted it). The traffic-LESS scratch well was caught by
  the zombie detector exactly on schedule — detection, debounce, and
  the stale-PID guard all behaved verbatim.
- **Bug found: unlocked repair vs locked recovery.**
  `repairStaleDownRecords` (tick-time sweep, writes runtime without the
  well lock) saw the recovery's intentional `stopped` intermediate
  state mid-boot and flipped it back to `alive_running`, which let the
  autosleep watchdog queue a hibernate against the recovery's SSH gate;
  the recovery failed loudly ("ssh not ready within 60000ms") and the
  well parked safe. Fixed same night: the repair pass now skips wells
  whose lock is held (`isWellLocked`), and a successful recovery
  touches the idle clock so traffic-less wells get one full idle window
  before autosleep reconsiders.
- lume serve's supervisor health-poll is patient by design (lume blocks
  its HTTP actor during long ops) — expect ~30-90s of lume downtime
  before respawn after a crash. welld stays up throughout.

## The stop-unstick bug + the live-orphan gate (same night, ~05:30Z)

Cells's co-verification found the detector's worst failure mode within
40 minutes of deploy: **`well stop` un-stuck itself** — three clean
stops of cells-mother each reverted to running within ~90s, rebooted
by zombie "recovery."

Root cause is a semantic mismatch the detector shipped with:
**`runtime.state` is intent, not observation.** `stopWell` never
writes runtime.json — deliberately, since resurrect-across-bounces
keys on the stale `alive_running` to revive warm wells after a welld
restart. So "runtime=alive_running + lume=stopped" doesn't just
describe lume losing a VM; it describes **every deliberately stopped
well on the host**. The detector recovered them all.

Fix: the signature now **requires a live orphan VZ child**
(`xpc_child_pid` present in `findVzXpcPids()`), checked at detection
AND re-verified under the lock in recovery (`aborted_no_orphan`).
That's the actual wedge from mother's incident — a child lume lost
but which still holds the bundle disk, blocking every wake. Without a
live orphan there is nothing a wake-on-traffic can't fix, and acting
on the record alone un-stops wells.

Consequence worth knowing: the lume-serve-crash variant (children die
with the crash) is now *out of the detector's scope* — wake-on-demand
covers every traffic-bearing well there (proven, ~3 min), and
traffic-less wells stay down-until-touched like any stopped well.
The detector exclusively handles the held-disk wedge.

Longer-term flag: the intent/observation duality of `runtime.state`
is the root tension here (stop leaves a lie behind for resurrect's
benefit). If it bites a third consumer, split the field
(`desired_state` vs observed) rather than adding more gates.

## Ops notes

- Kill switch: `WELLD_ZOMBIE_RECOVER=false` (detection still logs
  `zombie: confirmed but auto-recovery disabled`).
- Grep keys: `zombie: CONFIRMED`, `zombie: recovered`,
  `zombie: recovery FAILED`.
- Failed recoveries reset the debounce → automatic retry every ~2
  ticks, loudly logged each time.
- The generic banner-wedge auto-cycle (`WELLD_AUTO_CYCLE_ON_WEDGE`)
  stays opt-in/off — that signature is heuristic; this one is a
  deterministic state mismatch.
- cells-side visible behavior: a zombied well now flaps
  (brief `stopped` → `running`) within ~2 min instead of sitting
  unreachable; `last_error` carries the zombie note until the next
  clean transition.
