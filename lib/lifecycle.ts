// Well lifecycle primitives — stop/start as library calls so restore +
// daemon can reuse them without going through the CLI's print-and-exit
// shape. The CLI commands wrap these and handle output.

import { LumeClient, type VMSummary } from "../engine/vwell.ts";
import { killAndRestartLumeServe } from "../engine/lumeProcess.ts";
import {
  readDhcpLeaseEntry,
  resolveWellIp,
  waitForNewerLease,
} from "./dhcp.ts";
import { clearPaused, markPaused } from "./paused.ts";
import { findWell, resolveLumeName } from "./registry.ts";
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

// Pure pre-flight check used before we let `lume.saveState` land on a
// VM that might have transitioned to a non-running state. Throws a
// readable error if hibernate isn't safe; returns void if it is.
//
// Called from hibernateWell. Extracted as a module-level helper so it
// can be unit-tested without mocking LumeClient.
//
//   1. status: must be "running". Caught by the obvious case where the
//      VM has already transitioned out (e.g. lume saw VZ stop it).
//   2. ipAddress: when non-null, lume agrees the VM has DHCP — proceed.
//      When null, lume's view is ambiguous: either VZ crashed (must
//      refuse — save-state would crash lume serve) or lume just hasn't
//      caught up to a fresh boot (proceed; freshly-created wells legit-
//      imately show ipAddress=null for ~13s after lease assignment).
//      Caller resolves the ambiguity by passing `substrateAlive`:
//        true  → welld confirmed the VM is reachable independently
//                (lease file + TCP probe). Proceed.
//        false → welld confirmed the VM is unreachable. Refuse.
//        null  → caller didn't check. Refuse conservatively, since
//                save-state on a crashed VM has historically crashed
//                lume serve (cells team flap 2026-05-09 21:07 UTC).
export function assertHibernatable(
  name: string,
  info: VMSummary | null,
  substrateAlive: boolean | null = null,
): void {
  if (!info) {
    throw new Error(`hibernate refused: lume has no record of '${name}'`);
  }
  if (info.status !== "running") {
    throw new Error(
      `hibernate refused: lume reports '${name}' status='${info.status}' ` +
        `(expected 'running'). Likely VZ-side error or already stopped — ` +
        `caller should reconcile FSM rather than retry.`,
    );
  }
  if (info.ipAddress != null) return;
  if (substrateAlive === true) return;
  if (substrateAlive === false) {
    throw new Error(
      `hibernate refused: lume reports '${name}' status='running' but ` +
        `ipAddress=null AND substrate probe (lease file + TCP) failed — ` +
        `VZ has crashed the VM and lume's status is stale. Save-state on ` +
        `this combination has crashed lume serve.`,
    );
  }
  throw new Error(
    `hibernate refused: lume reports '${name}' status='running' but ` +
      `ipAddress=null and caller did not provide substrate confirmation. ` +
      `Save-state on a crashed VM has crashed lume serve in the past.`,
  );
}

// Substrate-truth liveness probe for cases where lume.info's ipAddress
// is unreliable (sticky-stale on fresh boot, sticky-stale after VZ
// crash). Reads the actual IP from vmnet's lease file and TCP-probes
// port 22. Returns true if reachable, false if not, null if we can't
// even find an IP.
export async function probeSubstrateAlive(
  name: string,
): Promise<boolean | null> {
  const ip = await resolveWellIp(name);
  if (!ip) return null;
  return await tcpProbe(ip, 22, 1000);
}

async function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const { Socket } = await import("node:net");
  return new Promise((resolve) => {
    const socket = new Socket();
    const settle = (ok: boolean) => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(port, host);
  });
}

export interface StopResult {
  wasRunning: boolean;
  graceful: boolean;
}

export async function stopWell(name: string): Promise<StopResult> {
  const lume = new LumeClient();
  const lumeName = await resolveLumeName(name);
  const info = await lume.info(lumeName).catch(() => null);
  if (info?.status === "stopped") return { wasRunning: false, graceful: true };

  // lume.stop() now drives a graceful shutdown via Apple's
  // `requestStop()` (ACPI shutdown to the guest) with a 30s timeout
  // before falling back to forceful — see
  // engine/vwell-src/src/Virtualization/VMVirtualizationService.swift.
  // Prior B.0.7 comment claimed lume.stop() was already graceful;
  // empirically (cells team 2026-05-10) it was a forceful "pull the
  // cord" stop that dropped post-boot writes. Fixed in
  // wells-stable-2026-05-10c. Keep the IP lookup around for the SSH
  // control-socket cleanup at the end.
  const ip = await resolveWellIp(name);

  await lume.stop(lumeName);
  await lume.waitForStatus(lumeName, "stopped", {
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
  const lumeName = record?.lume_name ?? name;
  const info = await lume.info(lumeName).catch(() => null);
  if (info?.status === "running") {
    const ip = (await resolveWellIp(name)) ?? "";
    return { ip, bootMs: 0, alreadyRunning: true };
  }

  // Pinned wells (Lever 3) bypass DHCP entirely — the IP is fixed,
  // no lease churn to wait through. Just boot and return the pin.
  if (record?.pinned_ip) {
    const t0 = Date.now();
    await lume.start(lumeName, { noDisplay: true });
    await lume.waitForStatus(lumeName, "running", {
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
  await lume.start(lumeName, { noDisplay: true });

  await lume.waitForStatus(lumeName, "running", {
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
  await lume.pause(await resolveLumeName(name));
  markPaused(name);
}

export async function resumeWell(name: string): Promise<void> {
  const lume = new LumeClient();
  await lume.resume(await resolveLumeName(name));
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
  const lumeName = await resolveLumeName(name);
  const recipe = await captureRestoreRecipe(lumeName);
  const lume = new LumeClient();
  // Pre-flight: confirm the VM is actually in `running` state before
  // calling save-state. The watchdog's lume.list snapshot can be stale
  // by the time we get here — if VZ has internally errored the VM in
  // the interim, save-state fails AND historically crashed lume serve
  // (cells team's flap report 2026-05-09 21:07 UTC: 13 lume respawns/hr
  // on stable from this loop). Skip with a clear error rather than
  // letting the bad call land.
  const info = await lume.info(lumeName).catch(() => null);
  // When lume reports ipAddress=null on a status=running VM, the cause
  // is ambiguous: fresh-boot lag (lume's internal lease watcher hasn't
  // caught up — typical 13s window post-create) vs. VZ-crashed (sticky
  // status). Probe the substrate ourselves to disambiguate before
  // committing to save-state. If we already have an IP from lume, skip
  // the probe (no need to spend a TCP roundtrip).
  let substrateAlive: boolean | null = null;
  if (info?.status === "running" && info.ipAddress == null) {
    substrateAlive = await probeSubstrateAlive(name);
  }
  assertHibernatable(name, info, substrateAlive);
  // Honor an existing hibernate_path on runtime.json (set during
  // adoption from pool — A.1.4.c.iv). VZ's saveStateTo writes the
  // file's absolute path string into restore-time metadata, and
  // restore later requires the EXACT same string — moving the file
  // even on the same disk causes Apple to reject the restore with
  // "permission denied". So adopted wells stick with the pool path
  // string for both save and restore. Fresh-create wells default to
  // PATHS.vmHibernate(name).
  const current = await readRuntime(name) ?? defaultRuntime();
  const hibernatePath = current.hibernate_path ?? PATHS.vmHibernate(name);
  // Apple's saveStateTo refuses to overwrite — unlink any prior file
  // so re-hibernation (idle → wake → idle) works without operator
  // cleanup. Caller's job to do this before re-hibernate.
  await Bun.file(hibernatePath).delete().catch(() => {});
  await lume.saveState(lumeName, hibernatePath);
  // Update runtime: mark hibernating + persist recipe for wake-time
  // validation.
  await writeRuntime(name, {
    ...current,
    state: "hibernating",
    last_transition_at: new Date().toISOString(),
    last_error: null,
    hibernate_path: hibernatePath,
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
  const lumeName = await resolveLumeName(name);
  if (runtime?.restore_recipe) {
    const drift = await validateRestoreRecipe(lumeName, runtime.restore_recipe);
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
  // Use runtime.hibernate_path (the literal string lume wrote to at
  // save time) — VZ refuses restore if the path string differs.
  // Adopted wells stick with their pool-XXXX path; fresh wells default
  // to PATHS.vmHibernate(name). See hibernateWell for the why.
  const hibernatePath = runtime?.hibernate_path ?? PATHS.vmHibernate(name);
  await lume.restoreState(lumeName, hibernatePath);
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
