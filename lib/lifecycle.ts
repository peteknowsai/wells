// Well lifecycle primitives — stop/start as library calls so restore +
// daemon can reuse them without going through the CLI's print-and-exit
// shape. The CLI commands wrap these and handle output.

import { spawn } from "bun";

import { LumeClient } from "../engine/lume.ts";
import {
  readDhcpLeaseEntry,
  resolveWellIp,
  waitForNewerLease,
} from "./dhcp.ts";
import { clearPaused, markPaused } from "./paused.ts";
import { findWell } from "./registry.ts";
import { closeSshControl } from "./sshControl.ts";
import { PATHS } from "./state.ts";

export interface StopResult {
  wasRunning: boolean;
  graceful: boolean;
}

export async function stopWell(name: string): Promise<StopResult> {
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "stopped") return { wasRunning: false, graceful: true };

  // Best-effort graceful shutdown so the guest can flush filesystems.
  // Detach via nohup — ssh would otherwise hang on network teardown.
  let graceful = false;
  const ip = await resolveWellIp(name);
  if (ip) {
    const ssh = spawn(
      [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=5",
        "-o", "LogLevel=ERROR",
        "-i", PATHS.vmSshKey(name),
        `ubuntu@${ip}`,
        "sudo nohup shutdown -h now >/dev/null 2>&1 &",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    if ((await ssh.exited) === 0) graceful = true;
    await Bun.sleep(5000);
  }

  // lume.app's CLI subprocess won't notice the guest halt — the API call
  // is what flips status to "stopped" and exits the run subprocess.
  await lume.stop(name).catch(() => {});
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
  return { wasRunning: true, graceful };
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

// stopWell-equivalent for the new sleep model: pause if alive (default
// auto-sleep behavior). Caller can fall back to stopWell for a hard
// shutdown. The watchdog uses this on idle.
export async function sleepWell(name: string): Promise<void> {
  await pauseWell(name);
}
