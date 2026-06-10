// Reconciliation: compare what the well's runtime.json says with what
// the world (lume, VZ proc table, hibernate file, in-memory pause
// tracker) actually shows. Converge the runtime to match observed
// truth — that's wells's source of truth, not lume.
//
// Pete's B.0.7 directive: lume can report `running` for paused VMs,
// `stopped` for hibernated ones, and `healthy` while a VZ XPC child
// is alive. Wells owns lifecycle truth; reconcile is how we keep
// that truth honest as the underlying actuator drifts.
//
// Two modes:
//   1. `reconcileWell(name)` — single well, used after every
//      lifecycle op to verify the transition landed.
//   2. `reconcileAll()` — every well in the registry, used by the
//      welld 30s tick.
//
// The pure derivation lives in `observeState()` so it's unit-testable
// without lume / fs / processes. Higher-level functions inject the
// real observers.

import { existsSync } from "node:fs";
import { listWells } from "./registry.ts";
import { PATHS } from "./state.ts";
import {
  defaultRuntime,
  readRuntime,
  writeRuntime,
  type WellRuntime,
  type WellState,
} from "./wellRuntime.ts";

export interface Observation {
  // What lume reports for this VM. null if lume doesn't know about
  // the VM at all (it was destroyed, or never existed in lume).
  lumeStatus: "running" | "stopped" | null;
  // True if welld's in-memory pause tracker has this well marked.
  // Lume reports "running" for paused VMs — this disambiguates.
  paused: boolean;
  // True if ~/.wells/vms/<n>/hibernate.bin exists.
  hibernateFileExists: boolean;
  // True if a VirtualMachine.xpc process for this VM is alive on the
  // host. Best-effort — we can't always tell which XPC child belongs
  // to which VM (Apple opaque-launches them via launchd), so callers
  // pass `true` if ANY XPC child is alive when we'd expect none.
  // Used to detect orphans.
  xpcChildAlive: boolean;
  // True if the well's bundle dir on disk is gone.
  bundleMissing: boolean;
}

// Pure: derive observed state from raw inputs. Caller supplies the
// observation; returning undefined means "no obvious answer, leave
// the recorded state alone".
export function observeState(obs: Observation): WellState {
  if (obs.bundleMissing) return "missing";

  // Hibernate file exists → either hibernating or error_orphaned
  // (file present but a VZ child is still alive).
  if (obs.hibernateFileExists) {
    if (obs.xpcChildAlive) return "error_orphaned";
    return "hibernating";
  }

  // No hibernate file. Lume's view + pause tracker disambiguate.
  if (obs.lumeStatus === "running") {
    return obs.paused ? "alive_paused" : "alive_running";
  }
  if (obs.lumeStatus === "stopped") {
    // Lume says stopped but a VZ child is alive → orphan from a
    // crashed/respawned lume that lost its SharedVM cache.
    if (obs.xpcChildAlive) return "error_orphaned";
    return "stopped";
  }

  // Lume doesn't know about it. If a VZ child is alive, that's an
  // orphan; otherwise treat as stopped (registered well with no
  // running VM and no hibernate file is just stopped).
  if (obs.xpcChildAlive) return "error_orphaned";
  return "stopped";
}

export interface Observers {
  lumeStatus: (name: string) => Promise<"running" | "stopped" | null>;
  isPaused: (name: string) => boolean;
  bundleMissing: (name: string) => boolean;
  xpcChildAlive: (name: string) => boolean;
}

// Reconcile a single well: compute observed state via the injected
// observers and update runtime.json if it differs. Returns the
// runtime that's now persisted (whether changed or not).
export async function reconcileWell(
  name: string,
  observers: Observers,
): Promise<WellRuntime> {
  const lumeStatus = await observers.lumeStatus(name);
  const paused = observers.isPaused(name);
  const hibernateFileExists = existsSync(PATHS.vmHibernate(name));
  const xpcChildAlive = observers.xpcChildAlive(name);
  const bundleMissing = observers.bundleMissing(name);

  const observed = observeState({
    lumeStatus,
    paused,
    hibernateFileExists,
    xpcChildAlive,
    bundleMissing,
  });

  const current = (await readRuntime(name)) ?? defaultRuntime();
  if (current.state === observed) return current;

  // State drift detected. Update runtime.
  const next: WellRuntime = {
    ...current,
    state: observed,
    last_transition_at: new Date().toISOString(),
    last_error:
      observed === "error_orphaned"
        ? `reconcile: observed=${observed}, was=${current.state} (lume=${lumeStatus}, paused=${paused}, hibernate_file=${hibernateFileExists}, xpc=${xpcChildAlive})`
        : null,
  };
  await writeRuntime(name, next);
  return next;
}

// Reconcile every registered well. Called by welld's 30s tick.
// Returns the list of names whose state changed in this pass —
// useful for logging without spamming on no-op ticks.
export async function reconcileAll(observers: Observers): Promise<string[]> {
  const records = await listWells();
  const drifted: string[] = [];
  for (const r of records) {
    const before = await readRuntime(r.name);
    const after = await reconcileWell(r.name, observers);
    if (before?.state !== after.state) {
      drifted.push(r.name);
    }
  }
  return drifted;
}

// Pure: is this a stale "down" record — runtime.json frozen at a
// non-alive state while the VM is genuinely running?
//
// Cells finding 2026-05-22 (docs/findings-welld-state-desync.md): a
// well whose runtime.json froze at `stopped`/`hibernating` while lume
// keeps running the VM becomes permanently un-hibernatable. Every
// lifecycle verb trusts the cached "down" state — `transitionWell`
// no-ops `hibernate` because `stopped`+`hibernate` is an idempotent
// identity transition — so the watchdog can never sleep it.
//
// Deliberately narrow. We only claim a record is stale when ALL hold:
//   - lume genuinely runs the VM (status=running AND an IP — the
//     watchdog's "really running" bar, which already rejects lume's
//     sticky-running-after-XPC-death false positive),
//   - no hibernate.bin exists. A hibernate file alongside a live VM
//     is an *orphan*, not this trap — that's `error_orphaned`'s job
//     (see observeState), and repairing it to alive_running would
//     paper over a real teardown failure.
//   - the recorded state is `stopped` or `hibernating` — the two
//     "down" states whose identity-transition for `hibernate` swallows
//     the watchdog's intent. `alive_paused` is excluded: lume can't
//     distinguish paused from running, so a record claiming paused
//     against a running VM is reconcile's harder ambiguous case, not
//     this one.
export function isStaleDownRecord(
  recorded: WellState,
  lumeGenuinelyRunning: boolean,
  hibernateFileExists: boolean,
): boolean {
  if (!lumeGenuinelyRunning) return false;
  if (hibernateFileExists) return false;
  return recorded === "stopped" || recorded === "hibernating";
}

export interface StaleDownRepair {
  name: string;
  from: WellState;
}

// Repair stale "down" records (see isStaleDownRecord) by writing the
// runtime back to `alive_running`. Meant for the welld watchdog tick,
// which already holds lume's list as ground truth — passing that in
// as `lumeGenuinelyRunning` reconciles welld's record against reality
// BEFORE the tick dispatches a hibernate it would otherwise no-op.
//
// Returns the wells whose record it repaired. Wells with no runtime
// file are skipped (no record to repair); a thrown write propagates
// so the caller can log it loudly — the finding's defect #2 was
// silently-lost writes, so we never swallow one here.
//
// `isLocked` (optional): skip wells with an in-flight lifecycle
// transition. This pass writes runtime WITHOUT the well lock — by
// design, it's a cheap tick-time sweep — so a "stopped" record it
// sees may be a lock-holder's intentional intermediate state, not
// staleness. Live-fire 2026-06-10: zombie recovery wrote stopped,
// started the VM, and this pass flipped the record back to
// alive_running mid-boot, which let the autosleep watchdog queue a
// hibernate against the recovery's SSH gate. A locked well is
// skipped, not deferred — if the record is still stale once the
// transition finishes, the next 30s tick repairs it.
export async function repairStaleDownRecords(opts: {
  names: string[];
  lumeGenuinelyRunning: (name: string) => boolean;
  isLocked?: (name: string) => boolean;
}): Promise<StaleDownRepair[]> {
  const repaired: StaleDownRepair[] = [];
  for (const name of opts.names) {
    if (opts.isLocked?.(name)) continue;
    const current = await readRuntime(name);
    if (current === null) continue;
    const hibernateFileExists = existsSync(PATHS.vmHibernate(name));
    if (
      !isStaleDownRecord(
        current.state,
        opts.lumeGenuinelyRunning(name),
        hibernateFileExists,
      )
    ) {
      continue;
    }
    await writeRuntime(name, {
      ...current,
      state: "alive_running",
      last_transition_at: new Date().toISOString(),
      last_error: null,
    });
    repaired.push({ name, from: current.state });
  }
  return repaired;
}
