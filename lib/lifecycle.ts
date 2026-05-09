// Well lifecycle primitives — stop/start as library calls so restore +
// daemon can reuse them without going through the CLI's print-and-exit
// shape. The CLI commands wrap these and handle output.

import { LumeClient } from "../engine/lume.ts";
import { killAndRestartLumeServe } from "../engine/lumeProcess.ts";
import {
  readDhcpLeaseEntry,
  resolveWellIp,
  waitForNewerLease,
} from "./dhcp.ts";
import { clearPaused, markPaused } from "./paused.ts";
import { findWell } from "./registry.ts";
import {
  captureRestoreRecipe,
  validateRestoreRecipe,
} from "./restoreRecipe.ts";
import { closeSshControl } from "./sshControl.ts";
import { PATHS } from "./state.ts";
import {
  defaultRuntime,
  readRuntime,
  writeRuntime,
} from "./wellRuntime.ts";

export interface StopResult {
  wasRunning: boolean;
  graceful: boolean;
}

export async function stopWell(name: string): Promise<StopResult> {
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "stopped") return { wasRunning: false, graceful: true };

  // SSH-shutdown was REMOVED here (B.0.7). Empirically, sending
  // `shutdown -h now` to the guest before lume.stop() puts the VZ
  // child in a transitional state — Apple's `VZVirtualMachine.stop()`
  // then crashes lume serve when called against a halting VM.
  // Direct lume.stop() handles graceful guest shutdown via VZ's own
  // poweroff signal in ~5s, no SSH dance needed. Keep the IP lookup
  // around for the SSH control-socket cleanup at the end.
  const ip = await resolveWellIp(name);

  await lume.stop(name);
  await lume.waitForStatus(name, "stopped", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });
  // Close any SSH control socket so the next start gets a fresh
  // connection (the cached socket points at a now-dead remote).
  await closeSshControl({
    name,
    ...(ip ? { ip, keyPath: PATHS.vmSshKey(name) } : {}),
  });
  return { wasRunning: true, graceful: true };
}

export interface StartResult {
  ip: string;
  bootMs: number;
  alreadyRunning: boolean;
}

export async function startWell(name: string): Promise<StartResult> {
  const lume = new LumeClient();
  const record = await findWell(name);
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "running") {
    const ip = (await resolveWellIp(name)) ?? "";
    return { ip, bootMs: 0, alreadyRunning: true };
  }

  // Pinned wells (Lever 3) bypass DHCP entirely — the IP is fixed,
  // no lease churn to wait through. Just boot and return the pin.
  if (record?.pinned_ip) {
    const t0 = Date.now();
    await lume.start(name, { noDisplay: true });
    await lume.waitForStatus(name, "running", {
      timeoutMs: 60_000,
      intervalMs: 500,
    });
    return {
      ip: record.pinned_ip,
      bootMs: Date.now() - t0,
      alreadyRunning: false,
    };
  }

  // Legacy DHCP path: capture the previous lease's expiry BEFORE we
  // boot, so we can wait for a strictly newer one after the boot.
  // Without this, vmnet's leases file still shows the pre-stop entry
  // until DHCP completes, and a naive readDhcpLease returns the stale
  // IP — SSH then dials a dead address.
  const priorLease = await readDhcpLeaseEntry(name);
  const priorLeaseValue = priorLease?.lease ?? 0;

  const t0 = Date.now();
  await lume.start(name, { noDisplay: true });

  await lume.waitForStatus(name, "running", {
    timeoutMs: 60_000,
    intervalMs: 500,
  });

  const fresh = await waitForNewerLease(name, priorLeaseValue, 60_000);
  if (!fresh) {
    throw new Error(`well '${name}' running but no fresh DHCP lease within 60s`);
  }
  return { ip: fresh.ip, bootMs: Date.now() - t0, alreadyRunning: false };
}

// Pause/resume an alive well via lume's HTTP API. Works because
// startWell now goes through lume serve's /run endpoint, which puts
// the VM in lume serve's SharedVM cache. Pause is sub-millisecond at
// the VZ level; resume is ~100ms in practice. Agent state is
// preserved exactly — the in-RAM process is just frozen and unfrozen.
// See docs/lifecycle.md.
//
// Welld tracks pause state via lib/paused.ts because lume's status
// field reports "running" for both states.
export async function pauseWell(name: string): Promise<void> {
  const lume = new LumeClient();
  await lume.pause(name);
  markPaused(name);
}

export async function resumeWell(name: string): Promise<void> {
  const lume = new LumeClient();
  await lume.resume(name);
  clearPaused(name);
}

// wells: hibernation — save the running VM's full state to disk so
// welld can free RAM. After this, the VM is `.stopped` from VZ's
// view; `wakeWell` restores from the saved file and resumes
// execution at exactly the saved point. Agent state, in-flight TCP,
// timers — all preserved.
//
// Captures a `RestoreRecipe` (device manifest snapshot) into the
// well's runtime.json before saving. Wake validates the recipe
// against the current bundle and refuses if anything drifted —
// VZ's restoreMachineStateFrom rejects mismatches with cryptic
// errors, so we'd rather fail fast with a readable diagnostic.
//
// Path lives at ~/.wells/vms/<n>/hibernate.bin (PATHS.vmHibernate),
// owned by welld and cleaned by destroy. File size scales with the
// VM's allocated memory (1GB cell → ~1GB hibernate file).
export async function hibernateWell(name: string): Promise<void> {
  // B.0.9.d.4: hibernate operates only on disk-only steady-state
  // wells. createWell's warming sequence detaches cidata after
  // /etc/.well-ready and sets hibernate_ready=true. Refusing here
  // protects pre-B.0.9.d.4 wells from generating broken
  // hibernate.bin files that wake would reject with Apple's
  // "storage device attachment is invalid".
  const pre = await readRuntime(name);
  if (pre && pre.hibernate_ready !== true) {
    throw new Error(
      `hibernate refused: well '${name}' is not sealed (hibernate_ready=false). ` +
        `Pre-B.0.9.d.4 wells need re-creation; new wells seal during create. ` +
        `steady_state_mount=${pre.steady_state_mount ?? "null"}`,
    );
  }
  const recipe = await captureRestoreRecipe(name);
  const lume = new LumeClient();
  await lume.saveState(name, PATHS.vmHibernate(name));
  // Update runtime: mark hibernating + persist recipe for wake-time
  // validation. Read current first so we don't clobber other fields.
  const current = await readRuntime(name) ?? defaultRuntime();
  await writeRuntime(name, {
    ...current,
    state: "hibernating",
    last_transition_at: new Date().toISOString(),
    last_error: null,
    hibernate_path: PATHS.vmHibernate(name),
    restore_recipe: recipe,
  });
  // Lifecycle: VM is no longer running. Close any open SSH control
  // socket — the next wake gets a fresh connection (the cached one
  // points at a now-frozen remote).
  const ip = await resolveWellIp(name);
  await closeSshControl({
    name,
    ...(ip ? { ip, keyPath: PATHS.vmSshKey(name) } : {}),
  });
  // Pause tracker is irrelevant once hibernated — clear if set.
  clearPaused(name);
}

export async function wakeWell(name: string): Promise<void> {
  // Validate recipe before touching VZ. Drift = refuse with clear
  // error rather than letting Apple's framework reject the config
  // with a cryptic message.
  const runtime = await readRuntime(name);
  if (runtime?.restore_recipe) {
    const drift = await validateRestoreRecipe(name, runtime.restore_recipe);
    if (drift) {
      // Mark error_orphaned so reconcile + operator notice. Don't
      // attempt the wake — VZ will fail anyway and may corrupt state.
      await writeRuntime(name, {
        ...runtime,
        state: "error_orphaned",
        last_error: `wake refused: restore recipe drift: ${drift}`,
        last_transition_at: new Date().toISOString(),
      });
      throw new Error(`wake refused: restore recipe drift: ${drift}`);
    }
  }
  const lume = new LumeClient();
  // B.0.9.d.4: disk-only restore — no cidata mount. Saved state was
  // taken from a disk-only steady state (createWell's warming
  // sequence detached cidata before any hibernate could fire), so
  // restore must rebuild the same shape.
  // B.0.9.d.4.e: full lume restart between save and restore. Apple's
  // VZ.framework keeps VM state keyed by disk path at kernel level;
  // dropping lume's swift handle isn't enough, so a fresh
  // VZVirtualMachine inherits the saved `.paused` state and
  // restoreMachineStateFrom errors. Process termination is the only
  // way to fully release. welld's supervisor brings lume back up.
  await killAndRestartLumeServe();
  await lume.restoreState(name, PATHS.vmHibernate(name));
  // Wake succeeded. Update runtime.
  const cur = await readRuntime(name) ?? defaultRuntime();
  await writeRuntime(name, {
    ...cur,
    state: "alive_running",
    last_transition_at: new Date().toISOString(),
    last_error: null,
    // Keep hibernate_path + recipe — useful for re-hibernation,
    // and `destroy` cleans them up regardless.
  });
}
