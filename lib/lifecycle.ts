// Well lifecycle primitives — stop/start as library calls so restore +
// daemon can reuse them without going through the CLI's print-and-exit
// shape. The CLI commands wrap these and handle output.

import { spawn } from "bun";
import { LumeClient, type VMSummary } from "../engine/vwell.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { waitForDhcpLease, waitForSshReady } from "./createWell.ts";
import { acquireBootSlot, acquireWakeSlot } from "./admission.ts";
import {
  dumpDhcpLeases,
  readDhcpLeaseEntry,
  resolveWellIp,
  waitForNewerLease,
} from "./dhcp.ts";
import { waitForDiskReleased } from "./diskReleased.ts";
import { log } from "./log.ts";
import { clearPaused, markPaused } from "./paused.ts";
import { findWell, resolveLumeName } from "./registry.ts";
import {
  captureRestoreRecipe,
  validateRestoreRecipe,
} from "./restoreRecipe.ts";
import { closeSshControl } from "./sshControl.ts";
import { PATHS } from "./state.ts";
import { captureWakeFailDiag } from "./wakeFailDiag.ts";
import { withWellLock } from "./wellLock.ts";
import {
  defaultRuntime,
  readRuntime,
  writeRuntime,
} from "./wellRuntime.ts";
import {
  findVzXpcPids,
  killXpcChild,
  waitForNewXpcChild,
} from "./xpcChild.ts";

// W.73: post-start SSH-readiness verification timeout. Tier-4 cidata-
// mounted wells were observed crashing silently within seconds after
// `lume.start` + `waitForStatus(running)` both returned success — the
// VZ status flips to running before the VM is actually stable, and
// the supervisor sees a now-running VM that crashes shortly after.
// Settle on actual SSH reachability rather than lume's optimistic flip.
// 60s is generous: typical fresh boots take 6-8s, slowest observed
// warming-restart was ~15s; 60s catches genuinely-broken VMs without
// false-failing slow-but-healthy ones.
const START_SSH_READY_TIMEOUT_MS = 60_000;

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

// W.73: optional SSH-ready gate. Default true — every caller wants
// "the VM is actually reachable" semantics. Tests / unusual paths that
// don't have SSH set up (or that genuinely just want the VZ kicked
// without waiting on the guest) can pass `verifySsh: false`.
export interface StartOptions {
  verifySsh?: boolean;
}

export async function startWell(
  name: string,
  opts: StartOptions = {},
): Promise<StartResult> {
  const verifySsh = opts.verifySsh ?? true;
  const lume = new LumeClient();
  const record = await findWell(name);
  const lumeName = record?.lume_name ?? name;
  const info = await lume.info(lumeName).catch(() => null);
  if (info?.status === "running") {
    const ip = (await resolveWellIp(name)) ?? "";
    return { ip, bootMs: 0, alreadyRunning: true };
  }

  // Admission control: a cold start is a boot spike — gate it so a
  // burst of starts paces itself instead of oversubscribing the host.
  // The welld-startup resurrection burst flows through here too, since
  // resurrectAliveWells just calls startWell. Released in the finally.
  const releaseBootSlot = await acquireBootSlot(name);
  try {
    // W.74: snapshot VZ XPC PIDs before lume.start so we can identify
    // the new VirtualMachine.xpc child this well spawns. Tracked in
    // runtime.json so hibernate can SIGKILL only this well's child
    // (rather than killAndRestartLumeServe-ing every running well).
    const xpcBefore = await findVzXpcPids();

    // Pinned wells (Lever 3) bypass DHCP entirely — the IP is fixed,
    // no lease churn to wait through. Just boot and return the pin.
    if (record?.pinned_ip) {
      const t0 = Date.now();
      await lume.start(lumeName, { noDisplay: true });
      await lume.waitForStatus(lumeName, "running", {
        timeoutMs: 60_000,
        intervalMs: 500,
      });
      if (verifySsh) {
        await waitForSshReady(
          record.pinned_ip,
          PATHS.vmSshKey(name),
          START_SSH_READY_TIMEOUT_MS,
        );
      }
      await captureXpcChildIntoRuntime(name, xpcBefore);
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
    if (verifySsh) {
      await waitForSshReady(
        fresh.ip,
        PATHS.vmSshKey(name),
        START_SSH_READY_TIMEOUT_MS,
      );
    }
    await captureXpcChildIntoRuntime(name, xpcBefore);
    return { ip: fresh.ip, bootMs: Date.now() - t0, alreadyRunning: false };
  } finally {
    releaseBootSlot();
  }
}

// W.74: poll for the new VirtualMachine.xpc child and merge it into
// the well's runtime.json. Logs + writes null on timeout — hibernate
// without a tracked PID falls back to the legacy killAndRestart
// behavior (with the documented sibling-kill collateral). Called at
// the tail of every startWell path; reads then writes runtime, no
// lock because lifecycle ops are already serialized per-well upstream.
//
// It also advances `state` to `alive_running`. startWell has no other
// runtime write, so without this a start from a `stopped`/`hibernating`
// record left the state stale behind a genuinely-running VM — the exact
// desync trap in docs/findings-welld-state-desync.md, re-minted on every
// start. The watchdog's repairStaleDownRecords would heal it within 30s,
// but that means every start spuriously logs a "repaired stale down
// record" warning, drowning the signal for genuine desyncs. Persist the
// correct state here, at the source.
export async function captureXpcChildIntoRuntime(
  name: string,
  xpcBefore: readonly number[],
  opts: { xpcTimeoutMs?: number } = {},
): Promise<void> {
  const newPid = await waitForNewXpcChild(xpcBefore, {
    timeoutMs: opts.xpcTimeoutMs ?? 5_000,
  });
  if (newPid == null) {
    log.warn("captureXpcChild: no new XPC appeared (won't track for hibernate)", {
      name,
    });
  } else {
    log.info("captureXpcChild: tracked new VZ XPC", { name, pid: newPid });
  }
  const current = await readRuntime(name);
  if (current) {
    // start always lands the well at alive_running. Keep last_transition_at
    // untouched when the record was already alive_running so a redundant
    // start doesn't churn the timestamp (mirrors reconcileWell's no-op).
    const alreadyRunning = current.state === "alive_running";
    await writeRuntime(name, {
      ...current,
      state: "alive_running",
      last_transition_at: alreadyRunning
        ? current.last_transition_at
        : new Date().toISOString(),
      last_error: null,
      xpc_child_pid: newPid,
    });
  }
  // current === null is a legitimate transient: startWell is sometimes
  // called from a create path that hasn't written runtime.json yet
  // (createWell writes after warming). The create path captures its
  // own XPC PID and writes it. Don't fabricate a runtime here.
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
  // wells. Post-Pi3, /seal is what flips hibernate_ready=true after
  // the caller has provisioned + halted + restarted without cidata.
  // Refusing here protects un-sealed wells from generating broken
  // hibernate.bin files that wake would reject with Apple's
  // "storage device attachment is invalid".
  const pre = await readRuntime(name);
  if (pre && pre.hibernate_ready !== true) {
    throw new HibernateNotReadyError(
      `well '${name}' is not sealed (hibernate_ready=false). ` +
        `Call POST /v1/wells/${name}/seal first to make this well hibernate-legal. ` +
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
  // W.74: release VZ kernel state for THIS well by SIGKILLing its
  // tracked VirtualMachine.xpc child. After saveState the VM is in
  // VZ's `.paused` kernel state; without releasing it, a subsequent
  // wakeWell's restoreState fails with "Transition from state 'paused'
  // to state 'restoring' is invalid". The previous mitigation was a
  // process-wide `killAndRestartLumeServe` in wakeWell — that worked
  // but clipped every sibling well as collateral (cells team report
  // 2026-05-12 22:22:30Z: waking egg-81256d killed 10 just-refilled
  // pool wells). Per-child kill is surgical: only this well's kernel
  // state is released.
  if (current.xpc_child_pid != null) {
    if (Bun.env.WELL_DISABLE_XPC_KILL === "1") {
      log.info("hibernateWell: XPC kill skipped (WELL_DISABLE_XPC_KILL=1)", {
        name,
        pid: current.xpc_child_pid,
      });
    } else {
      const signal =
        Bun.env.WELL_XPC_KILL_SIGNAL === "SIGTERM" ? "SIGTERM" : "SIGKILL";
      const killed = await killXpcChild(current.xpc_child_pid, {
        timeoutMs: 5_000,
        signal,
      });
      if (killed) {
        log.info("hibernateWell: released VZ kernel state via XPC kill", {
          name,
          pid: current.xpc_child_pid,
          signal,
        });
        const settleMs = Number.parseInt(
          Bun.env.WELL_XPC_SETTLE_MS ?? "250",
          10,
        );
        if (settleMs > 0) await Bun.sleep(settleMs);
      } else {
        log.warn("hibernateWell: XPC kill timed out — wake may fail", {
          name,
          pid: current.xpc_child_pid,
          signal,
        });
      }
    }
  } else {
    log.warn(
      "hibernateWell: no tracked xpc_child_pid; legacy well — wake may fail with 'state paused' error",
      { name },
    );
  }
  // Update runtime: mark hibernating + persist recipe for wake-time
  // validation. xpc_child_pid cleared because the child is dead (or
  // we logged that we couldn't track it).
  await writeRuntime(name, {
    ...current,
    state: "hibernating",
    last_transition_at: new Date().toISOString(),
    last_error: null,
    hibernate_path: hibernatePath,
    restore_recipe: recipe,
    // W.68: well no longer holds an active lease.
    ip: null,
    xpc_child_pid: null,
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
  // Admission control: wakes use their own gate (default cap 1).
  // Concurrent lume.restoreState races on VZ XPC-child attribution —
  // 2026-05-15 egg-a5eda3 incident: 3 parallel wakes attributed the
  // same VZ XPC pid to 3 wells; one landed in lume state=error.
  // See lib/admission.ts header.
  const releaseBootSlot = await acquireWakeSlot(name);
  try {
    const lume = new LumeClient();
    // B.0.9.d.4: disk-only restore — no cidata mount. Saved state was
    // taken from a disk-only steady state (createWell's warming
    // sequence detached cidata before any hibernate could fire), so
    // restore must rebuild the same shape.
    // W.74 supersedes B.0.9.d.4.e: instead of `killAndRestartLumeServe`
    // before restore (which clipped every sibling well), hibernateWell
    // now SIGKILLs only THIS well's VirtualMachine.xpc child after
    // saveState. By the time we reach wakeWell, VZ kernel state is
    // already released for this disk path, so a fresh VZVirtualMachine
    // built by restoreState gets a clean kernel namespace. Sibling
    // wells stay alive.
    //
    // Snapshot XPC PIDs before restoreState so we can capture this
    // wake's new XPC child for future hibernate cycles.
    const xpcBefore = await findVzXpcPids();
    // Use runtime.hibernate_path (the literal string lume wrote to at
    // save time) — VZ refuses restore if the path string differs.
    // Adopted wells stick with their pool-XXXX path; fresh wells default
    // to PATHS.vmHibernate(name). See hibernateWell for the why.
    const hibernatePath = runtime?.hibernate_path ?? PATHS.vmHibernate(name);
    try {
      await lume.restoreState(lumeName, hibernatePath);
    } catch (restoreErr) {
      // Wake-failure diagnostic capture (2026-05-23). The cells-zero
      // VZErrorRestore code 12 "permission denied" did not reproduce
      // in dev across Phase 1/2/3 of the leak investigation; production
      // telemetry is the only path to a real root cause. Capture is
      // synchronous + bounded (~10s budget) so the next retry sees
      // stable state. Throws-through the original error verbatim — the
      // caller's contract is unchanged.
      try {
        const tsTag = new Date()
          .toISOString()
          .replace(/[:.]/g, "-");
        const outDir = `${PATHS.root()}/diag/wake-fail-${name}-${tsTag}`;
        const lumeHost = process.env.WELL_LUME_HOST ?? "127.0.0.1";
        const lumePort = process.env.WELL_LUME_PORT ?? "7777";
        const record = await findWell(name).catch(() => null);
        await captureWakeFailDiag({
          outDir,
          name,
          diskPath: bundleDiskPath(lumeName),
          hibernatePath,
          errorString:
            restoreErr instanceof Error
              ? `${restoreErr.message}\n${restoreErr.stack ?? ""}`
              : String(restoreErr),
          lumeBaseUrl: `http://${lumeHost}:${lumePort}`,
          lumeVmName: lumeName,
          registryRecord: record,
          runtimeJson: runtime,
        });
      } catch (diagErr) {
        log.warn("wakeWell: diagnostic capture itself failed", {
          name,
          err: diagErr instanceof Error ? diagErr.message : String(diagErr),
        });
      }
      throw restoreErr;
    }
    // Capture the new XPC child PID so the next hibernate cycle can
    // release VZ kernel state surgically. Log on timeout but don't
    // fail the wake — the well is already running by this point.
    const newXpcPid = await waitForNewXpcChild(xpcBefore, { timeoutMs: 5_000 });
    if (newXpcPid != null) {
      log.info("wakeWell: tracked new VZ XPC", { name, pid: newXpcPid });
    } else {
      log.warn(
        "wakeWell: no new XPC appeared after restoreState (next hibernate may need legacy fallback)",
        { name },
      );
    }
    // Wake succeeded. Update runtime.
    const cur = await readRuntime(name) ?? defaultRuntime();
    await writeRuntime(name, {
      ...cur,
      state: "alive_running",
      last_transition_at: new Date().toISOString(),
      last_error: null,
      // Keep hibernate_path + recipe — useful for re-hibernation,
      // and `destroy` cleans them up regardless.
      // W.68: clear stamped IP — the wake produces a fresh DHCP grant
      // (vmnet usually re-issues the same IP, but not guaranteed). The
      // lease publisher's periodic sweep will read the new lease via
      // resolveWellIp and re-stamp on first observation.
      ip: null,
      xpc_child_pid: newXpcPid,
    });
  } finally {
    releaseBootSlot();
  }
}

// Tagged error for sealWell. Handler maps `.code` to specific HTTP
// status codes — keeps "already sealed" / "not running" out of the
// generic 500 bucket.
export class SealError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SealError";
  }
}

// Tagged error for hibernateWell's hibernate_ready=false refusal. The
// hibernation handler maps this to 409 well_not_hibernate_ready instead
// of the generic 500 hibernate_failed. Documented in
// docs/cells-pool-builder-primitives.md as the right code for "well
// hasn't been sealed yet — call /seal first."
export class HibernateNotReadyError extends Error {
  readonly code = "well_not_hibernate_ready" as const;
  constructor(message: string) {
    super(message);
    this.name = "HibernateNotReadyError";
  }
}

export interface SealResult {
  sealed_at: string;
  elapsed_ms: number;
  ip: string;
}

// Take a running well from "cidata-mounted alive_running" to "disk-only
// hibernate-legal alive_running" by halting the guest, restarting it
// WITHOUT the cidata mount, and flipping hibernate_ready=true in
// runtime.json. This is the post-Pi3 replacement for the warming
// sequence that used to live inside createWell.
//
// Cells's pool builder calls this AFTER provisioning (install agent,
// DNA push, env setup) so the disk-only snapshot captured by /hibernate
// includes the provisioned cell, not just the bare ubuntu-base image.
//
// Refuse cases (SealError):
//   - well_already_sealed: hibernate_ready is already true
//   - well_not_running:    lume reports !running (or has no record)
//
// All other failures throw plain Error → handler maps to 500.
export async function sealWell(name: string): Promise<SealResult> {
  return withWellLock(name, async () => {
    const t0 = Date.now();

    const runtime = await readRuntime(name);
    if (runtime?.hibernate_ready === true) {
      throw new SealError(
        "well_already_sealed",
        `well '${name}' is already sealed (hibernate_ready=true)`,
      );
    }

    const record = await findWell(name);
    if (!record) {
      throw new SealError(
        "well_not_running",
        `well '${name}' not found in registry`,
      );
    }

    const lume = new LumeClient();
    const lumeName = await resolveLumeName(name);
    const info = await lume.info(lumeName).catch(() => null);
    if (!info || info.status !== "running") {
      throw new SealError(
        "well_not_running",
        `well '${name}' status='${info?.status ?? "missing"}' — must be running to seal`,
      );
    }

    const ip = runtime?.ip ?? record.pinned_ip ?? (await resolveWellIp(name));
    if (!ip) {
      throw new Error(`seal: no IP for well '${name}' — cannot SSH-halt`);
    }

    log.info("seal: halt via sysrq", { name, ip });
    // Same fast-halt pattern the deleted warming sequence used: sync +
    // sysrq-s + sysrq-o. Userspace sync drains app dirty pages,
    // sysrq-s flushes everything the kernel sees, sysrq-o halts
    // immediately. Bypasses systemd's poweroff.target for ~3-4s savings.
    const shutdownProc = spawn(
      [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=4",
        "-o", "LogLevel=ERROR",
        "-o", "BatchMode=yes",
        "-i", PATHS.vmSshKey(name),
        `root@${ip}`,
        "sync && echo s > /proc/sysrq-trigger && echo o > /proc/sysrq-trigger",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    await shutdownProc.exited;

    const bundleDisk = bundleDiskPath(lumeName);
    await waitForDiskReleased(bundleDisk, 60_000);

    // Snapshot xpc PIDs before restart so we can capture the new child.
    const xpcBefore = await findVzXpcPids();
    const beforeLeases = await dumpDhcpLeases();

    log.info("seal: restart without mount (disk-only)", { name });
    await lume.start(lumeName, { noDisplay: true });
    await lume.waitForStatus(lumeName, "running", { timeoutMs: 60_000 });

    // W.72: static-IP wells skip DHCP on the second boot — netplan
    // persisted during firstboot so the guest comes up directly on the
    // pinned address. DHCP path: waitForDhcpLease + delta filter against
    // beforeLeases identifies the new grant unambiguously.
    let newIp: string;
    if (record.pinned_ip) {
      newIp = record.pinned_ip;
      await waitForSshReady(newIp, PATHS.vmSshKey(name), 60_000);
    } else {
      newIp = await waitForDhcpLease(name, 60_000, lume, beforeLeases);
      await waitForSshReady(newIp, PATHS.vmSshKey(name), 60_000);
    }

    const newXpcPid = await waitForNewXpcChild(xpcBefore, { timeoutMs: 5_000 });

    const sealed_at = new Date().toISOString();
    await writeRuntime(name, {
      ...(runtime ?? defaultRuntime()),
      state: "alive_running",
      last_transition_at: sealed_at,
      hibernate_ready: true,
      birth_media_detached_at: sealed_at,
      steady_state_mount: null,
      ip: newIp,
      xpc_child_pid: newXpcPid,
    });

    const elapsed_ms = Date.now() - t0;
    log.info("seal: complete", { name, ip: newIp, elapsed_ms });
    return { sealed_at, elapsed_ms, ip: newIp };
  });
}
