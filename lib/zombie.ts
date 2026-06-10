// Zombie detection + recovery for the "narrator signature": lume lost
// the VM (status=stopped or unknown) while runtime.json still says
// alive_running. The VZ XPC child is typically alive and holding the
// bundle disk, so every proxy/exec wake attempt tries to start a VM
// lume can't see and fails — the well is unreachable through welld
// even when the guest itself is healthy.
//
// cells-mother sat in this state 23:25→00:01 UTC (2026-06-09, 36 min)
// before cells's dashboard caught it; welld's banner-probe couldn't —
// sshd kept answering, the breakage was in lume's view, not the
// guest's network. Cells production-readiness ask #3.
//
// Detection lives in welld's watchdog tick (which already holds both
// views); this module owns the pure debounce + the locked recovery.
//
// Recovery policy mirrors resurrect.ts: runtime.json wins — the
// operator wanted this well running, so converge the world to that.
// Kill the orphan XPC child (same surgical path hibernate uses), wait
// for the disk lock to drop (else the restart dies with "disk still
// held"), mark runtime stopped-with-reason, fresh start.

import { log } from "./log.ts";

// Two consecutive watchdog ticks (~60-90s at the 30s cadence). One
// tick would false-positive on the stop window — runtime stays
// alive_running for up to ~60s while lume.stop drains. The in-lock
// re-check below is the real guard; the debounce just keeps recovery
// (and its error-level logging) off the floor for transients.
export const ZOMBIE_CONFIRM_TICKS = 2;

// Pure debounce. `prev` is the consecutive-mismatch count before this
// tick (undefined = clean). Confirmed fires exactly once, on the tick
// the count crosses the threshold; callers clear state on !mismatch.
export function stepZombieState(
  prev: number | undefined,
  mismatch: boolean,
): { next: number; confirmed: boolean } {
  if (!mismatch) return { next: 0, confirmed: false };
  const next = (prev ?? 0) + 1;
  return { next, confirmed: next === ZOMBIE_CONFIRM_TICKS };
}

// The full runtime record, structurally. Deps MUST return the complete
// runtime.json contents — recovery spreads it into the "stopped" write,
// so a subset here would silently clobber fields like hibernate_ready.
export interface ZombieWellRuntime {
  state: string;
  xpc_child_pid: number | null;
  [key: string]: unknown;
}

export interface ZombieRecoverDeps {
  readRuntime(name: string): Promise<ZombieWellRuntime | null>;
  writeRuntime(name: string, rt: ZombieWellRuntime): Promise<unknown>;
  // Fresh lume view, read inside the lock — the queued recovery may
  // have waited behind a transition that already fixed things.
  lumeStatus(name: string): Promise<"running" | "stopped" | null>;
  // True only when `pid` is currently a VZ XPC child. Guards the kill
  // against PID reuse: runtime.json's xpc_child_pid can be hours stale
  // (welld bounce, host reboot) and a recycled PID would mean SIGKILL
  // on an arbitrary process.
  isVzXpcPid(pid: number): Promise<boolean>;
  killXpcChild(pid: number): Promise<boolean>;
  waitForDiskReleased(name: string, timeoutMs: number): Promise<void>;
  startWell(name: string): Promise<unknown>;
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export type ZombieRecoverResult =
  | { kind: "recovered" }
  // Runtime no longer says alive_running once we held the lock — a
  // queued stop/hibernate/destroy resolved the mismatch first.
  | { kind: "aborted_state_changed"; state: string | null }
  // Lume says running again — sticky-running shape or a racing start.
  // Never auto-kill what lume claims is alive.
  | { kind: "aborted_lume_running" }
  | { kind: "failed"; error: string };

export const ZOMBIE_DISK_RELEASE_TIMEOUT_MS = 60_000;

export async function recoverZombieWell(
  name: string,
  deps: ZombieRecoverDeps,
): Promise<ZombieRecoverResult> {
  try {
    return await deps.withLock(name, async () => {
      // Re-verify the signature now that we hold the lock.
      const rt = await deps.readRuntime(name);
      if (rt?.state !== "alive_running") {
        return {
          kind: "aborted_state_changed",
          state: rt?.state ?? null,
        } as const;
      }
      const lume = await deps.lumeStatus(name);
      if (lume === "running") {
        return { kind: "aborted_lume_running" } as const;
      }

      // Kill the orphan VZ child so it releases the bundle disk. No
      // tracked pid (legacy well) → rely on the disk-release wait to
      // tell us whether anything is actually holding it. A tracked pid
      // that is no longer a VZ XPC child is treated the same as
      // untracked — it's stale (PID reuse after a bounce/reboot), and
      // killing it would hit an unrelated process.
      if (rt.xpc_child_pid != null) {
        if (await deps.isVzXpcPid(rt.xpc_child_pid)) {
          const killed = await deps.killXpcChild(rt.xpc_child_pid);
          if (!killed) {
            return {
              kind: "failed",
              error: `xpc child ${rt.xpc_child_pid} did not die`,
            } as const;
          }
        } else {
          log.warn(
            "zombie: tracked xpc_child_pid is not a VZ child (stale/reused) — skipping kill",
            { name, pid: rt.xpc_child_pid },
          );
        }
      } else {
        log.warn("zombie: no tracked xpc_child_pid — relying on disk-release wait", {
          name,
        });
      }
      await deps.waitForDiskReleased(name, ZOMBIE_DISK_RELEASE_TIMEOUT_MS);

      // Record truth before restarting: the VM is down, the child is
      // gone. startWell rewrites runtime on success; if it throws we
      // are left with an honest "stopped" instead of the zombie lie.
      await deps.writeRuntime(name, {
        ...rt,
        state: "stopped",
        xpc_child_pid: null,
        last_transition_at: new Date().toISOString(),
        last_error:
          "zombie: lume lost the VM while runtime said alive_running — auto-recovering",
      });

      await deps.startWell(name);
      return { kind: "recovered" } as const;
    });
  } catch (e) {
    return { kind: "failed", error: (e as Error).message };
  }
}
