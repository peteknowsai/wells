// Two-stage guest halt for the seal step.
//
// Background: sealWell halts the guest so the VZ process drops the bundle
// disk handle, then restarts disk-only. The original halt was a single
// fire-and-forget `ssh … sysrq` with the exit code ignored and an
// unbounded wait, followed by a flat 60s `waitForDiskReleased`. Under host
// I/O contention that wait timed out ~25x/day (stage=seal, "disk still
// held within 60000ms"): forensics showed the egg's own VZ process still
// holding disk.img with the VM still `running` — the guest-cooperative
// sysrq poweroff never tore the VM down (or the SSH never landed).
//
// Strategy:
//   1. Fast path — sysrq sync+halt over SSH (now bounded by a timeout).
//      When it lands and the host isn't saturated it drops the disk in
//      <1s. A *successful* sysrq returns ssh exit 0: the write to
//      /proc/sysrq-trigger returns before the async poweroff completes,
//      so exit 0 means "halt delivered", and a non-zero exit means the
//      SSH never landed (connect/auth failure) — the exact `own=true`
//      prod failure where the VM stayed up.
//   2. Fallback — if the SSH exits non-zero (escalate at once) or the disk
//      isn't free within FAST_WAIT_MS (sysrq landed but didn't tear down),
//      call stopWell(): a host-controlled ACPI shutdown with a 30s→forceful
//      backstop. lume owns the VM handle, so this reliably kills the
//      process regardless of guest state. Costs ~10s, but only on the tail.
//
// Both paths flush before teardown — the fast path's `sync`, the fallback's
// systemd shutdown — so the sealed disk stays consistent either way.

import { spawn } from "bun";
import { PATHS } from "./state.ts";
import {
  diskReleasedWithin as realDiskReleasedWithin,
  waitForDiskReleased as realWaitForDiskReleased,
} from "./diskReleased.ts";
import { log as defaultLog } from "./log.ts";

export const SEAL_HALT = {
  // Bound the SSH so a stalled guest `sync` can't block the seal forever
  // (the original had no overall timeout — an unbounded `await exited`).
  SSH_TIMEOUT_MS: 12_000,
  // Trust a delivered sysrq this long before escalating. Sized above the
  // observed loaded-happy-path tail (sysrq released in 0.5–6s at vz=8 under
  // synthetic I/O load) so we don't escalate on a merely-slow release.
  FAST_WAIT_MS: 8_000,
  // Backstop wait after the host-controlled stop. stopWell already drove
  // teardown (ACPI → forceful), so the disk is released near-immediately;
  // this is slack for VZ to drop the handle.
  FALLBACK_RELEASE_MS: 30_000,
} as const;

const SYSRQ_REMOTE =
  "sync && echo s > /proc/sysrq-trigger && echo o > /proc/sysrq-trigger";

// Fire the sysrq sync+halt over SSH, bounded by SSH_TIMEOUT_MS. Returns the
// ssh exit code (124 if we had to kill it on timeout). Output is discarded —
// the exit code is the only signal we use.
export async function sysrqHalt(name: string, ip: string): Promise<number> {
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=4",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", PATHS.vmSshKey(name),
      `root@${ip}`,
      SYSRQ_REMOTE,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SEAL_HALT.SSH_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  return timedOut ? 124 : code;
}

export interface SealHaltDeps {
  sysrqHalt: (name: string, ip: string) => Promise<number>;
  diskReleasedWithin: (disk: string, ms: number) => Promise<boolean>;
  stopWell: (name: string) => Promise<unknown>;
  waitForDiskReleased: (disk: string, ms: number) => Promise<void>;
  log?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export interface SealHaltResult {
  path: "sysrq" | "fallback";
  haltCode: number;
  fallbackReason?: "ssh_failed" | "disk_held";
}

// Orchestrate the two-stage halt. Pure control flow over injected effects so
// the escalation logic is unit-tested without VMs. waitForDiskReleased on the
// fallback path still throws if even a forceful stop fails to release — that
// is a genuine substrate fault and should surface as a seal failure.
export async function haltGuestForSeal(
  deps: SealHaltDeps,
  name: string,
  ip: string,
  bundleDisk: string,
): Promise<SealHaltResult> {
  const log = deps.log ?? defaultLog;
  const haltCode = await deps.sysrqHalt(name, ip);

  if (haltCode === 0) {
    if (await deps.diskReleasedWithin(bundleDisk, SEAL_HALT.FAST_WAIT_MS)) {
      return { path: "sysrq", haltCode };
    }
    // Delivered but the VM didn't tear down in the fast window.
    log.warn("seal: sysrq delivered but disk still held — escalating to lume.stop", {
      name,
      waited_ms: SEAL_HALT.FAST_WAIT_MS,
    });
    await deps.stopWell(name);
    await deps.waitForDiskReleased(bundleDisk, SEAL_HALT.FALLBACK_RELEASE_MS);
    return { path: "fallback", haltCode, fallbackReason: "disk_held" };
  }

  // SSH never landed → the guest isn't halting. Escalate at once.
  log.warn("seal: sysrq ssh exited non-zero — escalating to lume.stop", {
    name,
    haltCode,
  });
  await deps.stopWell(name);
  await deps.waitForDiskReleased(bundleDisk, SEAL_HALT.FALLBACK_RELEASE_MS);
  return { path: "fallback", haltCode, fallbackReason: "ssh_failed" };
}

// Production dep set: real sysrq + real disk-release. stopWell is injected by
// the caller (lifecycle.ts) to avoid an import cycle.
export function realSealHaltDeps(
  stopWell: (name: string) => Promise<unknown>,
): SealHaltDeps {
  return {
    sysrqHalt,
    diskReleasedWithin: realDiskReleasedWithin,
    stopWell,
    waitForDiskReleased: realWaitForDiskReleased,
    log: defaultLog,
  };
}
