// Wells's lifecycle source of truth. Persists per-well runtime state
// at `~/.wells/vms/<name>/runtime.json` independently of lume. Pete's
// directive (B.0.7): "lume is the actuator, not the source of truth.
// Wells should own the lifecycle truth and treat lume/VZ/processes as
// observed inputs that can lie, lag, or crash."
//
// The 7 states form a state machine. Transitions are validated by
// `validTransitions` — anything not in the table is rejected by the
// dispatcher (B.0.7.g). The reconciliation loop (B.0.7.d) compares
// the persisted record to observed truth (lume, VZ procs, DHCP, SSH)
// and converges; mismatches land in `error_orphaned` for operator
// inspection.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./state.ts";

export type WellState =
  // VM is alive, CPU executing instructions, in lume's SharedVM cache.
  | "alive_running"
  // VM is alive, CPU halted, RAM still resident, in SharedVM cache.
  | "alive_paused"
  // VM RAM dumped to hibernate.bin. No VZ XPC child exists. Wake
  // restores from the file.
  | "hibernating"
  // Clean state. No hibernate file required, no VZ XPC child. Disk
  // bundle exists; can be brought to alive_running via start.
  | "stopped"
  // Wake in progress (reading hibernate.bin into a fresh VZ instance).
  // Brief transient — reconcile loop should never see this for long.
  | "restoring"
  // Observed state contradicts the record in a way reconcile couldn't
  // resolve safely (e.g. XPC alive but lume says stopped, or
  // hibernate.bin missing for a well marked hibernating). Operator
  // inspection required.
  | "error_orphaned"
  // Registry has a record but the on-disk bundle is gone. Cleanup
  // candidate.
  | "missing";

// What a hibernate.bin needs to be safely restored. Captured at
// hibernate time and re-checked at wake time. Drift = refuse with
// error_orphaned, don't try VZ.restoreMachineStateFrom — the
// framework rejects mismatches with cryptic errors.
//
// B.0.9.d.4: hibernation only operates on disk-only steady-state VMs
// (cidata is birth-only, detached after createWell's warming). The
// recipe encodes that contract — `mount_path` must be null at
// hibernate time, and `storage_device_count` should be 1 (root disk).
// If either drifts, refuse the wake.
export interface RestoreRecipe {
  // Steady-state mount path. null = disk-only (the only hibernate-
  // legal shape). If non-null, hibernation was attempted on a
  // non-sealed well — refuse wake and surface the bug.
  mount_path: string | null;
  // Expected storage device count at restore time. Disk-only = 1.
  storage_device_count: number;
  cpu_count: number;
  memory_bytes: number;
  display: string;
  mac_address: string;
  // Hash of the steady-state bundle config at save time. Mismatch on
  // wake means someone changed the bundle (disk resize, network
  // mode, etc.) — VZ will reject.
  config_hash: string;
}

export interface WellRuntime {
  state: WellState;
  // ISO8601 timestamp of the last successful state change.
  last_transition_at: string;
  // Set when state is `error_orphaned` or after a failed transition.
  // Cleared on next successful transition.
  last_error: string | null;
  // Path to the hibernate.bin file, set when state == "hibernating".
  // Always equals PATHS.vmHibernate(name) in practice; persisted so
  // operators can inspect runtime.json without consulting code.
  hibernate_path: string | null;
  // Snapshot of the device shape at the last successful hibernate.
  // Used by wake to refuse if the bundle has drifted.
  restore_recipe: RestoreRecipe | null;
  // B.0.9.d.4: true once createWell's warming sequence has detached
  // cidata and verified disk-only SSH. Hibernate refuses on `false`
  // because a still-mounted cidata at save time makes Apple's
  // restoreMachineStateFrom error "storage device attachment is
  // invalid" on every wake. createWell is the only path that flips
  // this true.
  hibernate_ready: boolean;
  // ISO8601 timestamp of when cidata was last detached (createWell's
  // warming-stop). null until first warming succeeds.
  birth_media_detached_at: string | null;
  // The mount attached in the steady-state VZ config. null for disk-
  // only wells (the hibernate-legal shape). Operators can inspect
  // without re-deriving from VZ snapshots.
  steady_state_mount: string | null;
  // W.68: the dotted-quad IPv4 lease assigned by vmnet at this well's
  // most recent boot/wake. Welld OWNS this value — it's stamped at
  // create+wake time and used by the lease publisher to re-write the
  // entry in `/var/db/dhcpd_leases` when external mutations remove it.
  // null means we haven't observed a lease yet (pre-create or
  // hibernating); the publisher skips entries with null IP.
  ip: string | null;
}

// Valid (from, verb) → to transitions. Verbs are the high-level
// operations callers request; the state machine maps them to the
// resulting state. Anything not listed is rejected by the dispatcher.
//
// Idempotent transitions (B.0.7.e): hibernate-on-hibernating returns
// hibernating; start-on-alive_running returns alive_running; etc.
// They appear here as identity entries so the dispatcher accepts them
// as no-ops without erroring.
//
// `restoring` only exists as a brief transient inside `wake`; we
// don't accept verbs FROM restoring (the dispatcher serializes on
// the per-well lock — only one transition at a time).
export type LifecycleVerb =
  | "start"
  | "stop"
  | "pause"
  | "resume"
  | "hibernate"
  | "wake"
  | "destroy";

export const validTransitions: Record<
  WellState,
  Partial<Record<LifecycleVerb, WellState>>
> = {
  alive_running: {
    start: "alive_running",
    stop: "stopped",
    pause: "alive_paused",
    // resume/wake on an already-running well are idempotent no-ops:
    // the verb's intent ("be alive_running") is already satisfied.
    // Letting them succeed quietly means callers (e.g. ensureRunning)
    // don't have to branch on current state before issuing a verb.
    resume: "alive_running",
    wake: "alive_running",
    hibernate: "hibernating",
    destroy: "missing",
  },
  alive_paused: {
    resume: "alive_running",
    pause: "alive_paused",
    stop: "stopped",
    hibernate: "hibernating",
    destroy: "missing",
  },
  hibernating: {
    wake: "alive_running",
    hibernate: "hibernating",
    stop: "stopped",
    destroy: "missing",
  },
  stopped: {
    start: "alive_running",
    stop: "stopped",
    // hibernate-on-stopped: idempotent no-op. The verb's intent
    // ("release this well's RAM") is already satisfied — a stopped
    // well consumes no RAM. Cells team explicitly asked us to make
    // this idempotent (2026-05-09): they hit it when calling /sleep
    // → /hibernate on a well that was already cold-stopped.
    hibernate: "stopped",
    destroy: "missing",
  },
  restoring: {},
  error_orphaned: {
    // Recovery only via stop or destroy — caller has to acknowledge
    // the orphan state explicitly.
    stop: "stopped",
    destroy: "missing",
  },
  missing: {
    destroy: "missing",
  },
};

// Pure: returns the destination state for a (current, verb) pair, or
// undefined if the transition isn't allowed. Caller decides whether
// to throw or report an error_orphaned.
export function nextState(
  current: WellState,
  verb: LifecycleVerb,
): WellState | undefined {
  return validTransitions[current][verb];
}

// File path for a well's runtime.json. Same dir as the bundle, so
// destroy cleanup gets it for free.
export function runtimePath(name: string): string {
  // Re-uses the well's vmDir; mirrors PATHS layout in state.ts.
  return `${PATHS.vmDir(name)}/runtime.json`;
}

// Read runtime state for a well. Returns null if the file doesn't
// exist (treated as "no runtime persisted yet", caller decides
// whether to default to `stopped` or run reconcile to find out).
export async function readRuntime(name: string): Promise<WellRuntime | null> {
  const p = runtimePath(name);
  if (!existsSync(p)) return null;
  try {
    const text = await readFile(p, "utf-8");
    return JSON.parse(text) as WellRuntime;
  } catch {
    return null;
  }
}

// Atomic write: tmp file + rename. Survives crashes mid-write.
// Tmp filename includes pid + random suffix so concurrent writers
// from different lifecycle ops don't clobber each other's tmp file.
// (In practice the per-well lock serializes writes, but defense in
// depth is cheap — just a unique suffix.)
export async function writeRuntime(
  name: string,
  runtime: WellRuntime,
): Promise<void> {
  const p = runtimePath(name);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${p}.${suffix}.tmp`;
  await writeFile(tmp, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  await rename(tmp, p);
}

// Build a default runtime record for a freshly-created well. Caller
// (createWell) writes this at the end of create, after lume.start
// confirms the VM is up.
export function defaultRuntime(): WellRuntime {
  return {
    state: "alive_running",
    last_transition_at: new Date().toISOString(),
    last_error: null,
    hibernate_path: null,
    restore_recipe: null,
    hibernate_ready: false,
    birth_media_detached_at: null,
    steady_state_mount: null,
    ip: null,
  };
}
