// Admission control for VM-boot operations.
//
// Boot — `lume.start` / `lume.restoreState` followed by the wait-for-SSH
// gate — is a short, CPU-heavy spike with a deadline attached. Running
// too many at once is what timed out the cells pool re-bake on
// 2026-05-14: contended boots crossed wells's SSH-ready deadline before
// their guests had finished coming up. This module paces the *burst*.
//
// It is NOT a job queue (no persistence, no priorities, no retries) and
// NOT a cap on the steady-state fleet — a booted, mostly-idle well costs
// almost nothing. It only governs how many boots may be *in flight* at
// once. See docs/proposals/wells-admission-control-for-dummies.html.
//
// Two gates, two signals:
//   - bootGate paces fresh-boot calls (createWell / startWell → lume.run).
//     Cap: WELL_MAX_CONCURRENT_BOOTS (default 3).
//   - wakeGate paces wakes (wakeWell → lume.restoreState). Cap:
//     WELL_MAX_CONCURRENT_WAKES (default 1). Serialized because
//     concurrent restoreState races on VZ XPC-child attribution —
//     2026-05-15 egg-a5eda3 incident: 3 concurrent wakes landed the
//     same XPC pid across 3 wells; one ended in lume state=error.
//     Sibling primitive: multi-thaw was serialized for the same reason.
//   - Backstop (shared): when committed vCPU already exceeds
//     WELL_BOOT_VCPU_RATIO × host cores, the effective limit collapses
//     to 1 — boot serially until the box catches up. Deliberately
//     conservative: an idle live well's configured vCPU isn't actually
//     *consumed*, so summing it overstates load and this rarely binds.

import { cpus } from "node:os";
import { log } from "./log.ts";
import { listWells, lumeNameOf } from "./registry.ts";
import { LumeClient } from "../engine/vwell.ts";

export const DEFAULT_MAX_CONCURRENT_BOOTS = 3;
export const DEFAULT_MAX_CONCURRENT_WAKES = 1;
export const DEFAULT_BOOT_VCPU_RATIO = 2;

// Read each call so the knobs are live-tunable and test-settable.
export function maxConcurrentBoots(): number {
  const raw = process.env.WELL_MAX_CONCURRENT_BOOTS;
  if (!raw) return DEFAULT_MAX_CONCURRENT_BOOTS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : DEFAULT_MAX_CONCURRENT_BOOTS;
}

export function maxConcurrentWakes(): number {
  const raw = process.env.WELL_MAX_CONCURRENT_WAKES;
  if (!raw) return DEFAULT_MAX_CONCURRENT_WAKES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : DEFAULT_MAX_CONCURRENT_WAKES;
}

export function bootVcpuRatio(): number {
  const raw = process.env.WELL_BOOT_VCPU_RATIO;
  if (!raw) return DEFAULT_BOOT_VCPU_RATIO;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BOOT_VCPU_RATIO;
}

// Injected so tests never touch the registry, lume, or os.
export interface AdmissionDeps {
  // Σ configured vCPU of currently-running wells.
  committedVcpu: () => Promise<number>;
  // Schedulable host cores.
  hostCores: () => number;
}

// Real committed-vCPU: lume reports which VMs are running, the registry
// holds each well's configured cpu. Best-effort — a failed read disables
// the backstop for that cycle rather than blocking boots.
async function realCommittedVcpu(): Promise<number> {
  const lume = new LumeClient();
  const vms = await lume.list().catch(() => []);
  const running = new Set(
    vms.filter((v) => v.status === "running").map((v) => v.name),
  );
  if (running.size === 0) return 0;
  const wells = await listWells().catch(() => []);
  let sum = 0;
  for (const w of wells) {
    if (running.has(lumeNameOf(w))) sum += w.cpu;
  }
  return sum;
}

export const defaultAdmissionDeps: AdmissionDeps = {
  committedVcpu: realCommittedVcpu,
  hostCores: () => cpus().length,
};

export interface BootGateDepth {
  inFlight: number;
  waiting: number;
  limit: number;
}

export class BootGate {
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  // Cached committed-vCPU verdict; refreshed on every acquire entry and
  // after every release, so a waiter is always re-evaluated against a
  // fresh view of host load.
  private vcpuOver = false;

  constructor(
    private deps: AdmissionDeps = defaultAdmissionDeps,
    private staticLimit: () => number = maxConcurrentBoots,
  ) {}

  // Effective concurrency limit: the static cap, collapsed to 1 when the
  // box is already over the vCPU ratio.
  private limit(): number {
    return this.vcpuOver ? 1 : this.staticLimit();
  }

  private async refreshVcpu(): Promise<void> {
    try {
      const committed = await this.deps.committedVcpu();
      const cores = this.deps.hostCores();
      this.vcpuOver = cores > 0 && committed / cores >= bootVcpuRatio();
    } catch (e) {
      // Backstop only — if host load can't be read, don't let that
      // block boots. Fall back to the pure count gate.
      this.vcpuOver = false;
      log.warn("admission: committedVcpu read failed — backstop off this cycle", {
        err: (e as Error).message,
      });
    }
  }

  // Acquire a boot slot. Resolves once it's this caller's turn. The
  // returned function MUST be called (in a `finally`) to release the
  // slot — it is idempotent, so releasing twice is harmless.
  async acquire(label: string): Promise<() => void> {
    await this.refreshVcpu();
    if (this.inFlight >= this.limit()) {
      log.info("admission: boot slot full — waiting", {
        label,
        inFlight: this.inFlight,
        limit: this.limit(),
        waiting: this.waiters.length + 1,
      });
      while (this.inFlight >= this.limit()) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      // Re-read host load before waking the next waiter so it's gated
      // against the post-release state, not the pre-release one.
      void this.refreshVcpu().finally(() => {
        const next = this.waiters.shift();
        if (next) next();
      });
    };
  }

  depth(): BootGateDepth {
    return {
      inFlight: this.inFlight,
      waiting: this.waiters.length,
      limit: this.limit(),
    };
  }
}

// The process-wide gate fresh boots share (createWell / startWell).
export const bootGate = new BootGate(defaultAdmissionDeps, maxConcurrentBoots);

// Separate gate for wakes (lume.restoreState). Default cap is 1 —
// concurrent restoreState races on VZ XPC-child attribution; see
// the header comment for the 2026-05-15 egg-a5eda3 incident.
export const wakeGate = new BootGate(defaultAdmissionDeps, maxConcurrentWakes);

// Public API the boot paths call. `label` is just for the wait log.
export function acquireBootSlot(label: string): Promise<() => void> {
  return bootGate.acquire(label);
}

export function acquireWakeSlot(label: string): Promise<() => void> {
  return wakeGate.acquire(label);
}

// For /healthz + well doctor — lets an operator (and cells) see "wells
// is pacing me right now, that's expected" instead of guessing.
export function bootGateDepth(): BootGateDepth {
  return bootGate.depth();
}

export function wakeGateDepth(): BootGateDepth {
  return wakeGate.depth();
}
