// Splite lifecycle primitives — stop/start as library calls so restore +
// daemon can reuse them without going through the CLI's print-and-exit
// shape. The CLI commands wrap these and handle output.

import { openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

import { LumeClient } from "../engine/lume.ts";
import { readDhcpLease } from "./dhcp.ts";
import { PATHS } from "./state.ts";

export interface StopResult {
  wasRunning: boolean;
  graceful: boolean;
}

export async function stopSplite(name: string): Promise<StopResult> {
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "stopped") return { wasRunning: false, graceful: true };

  // Best-effort graceful shutdown so the guest can flush filesystems.
  // Detach via nohup — ssh would otherwise hang on network teardown.
  let graceful = false;
  const ip = await readDhcpLease(name);
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
  return { wasRunning: true, graceful };
}

export interface StartResult {
  ip: string;
  bootMs: number;
  alreadyRunning: boolean;
}

export async function startSplite(name: string): Promise<StartResult> {
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "running") {
    const ip = (await readDhcpLease(name)) ?? "";
    return { ip, bootMs: 0, alreadyRunning: true };
  }

  // Uses `lume run` as a subprocess. The shell `lume` resolves to
  // upstream's notarized lume.app bundle, which has the
  // `com.apple.security.virtualization` entitlement; that's why VM
  // start works through this path. Our hot-built `bin/lume` is
  // adhoc-signed and lacks the entitlement, so lume serve's HTTP /run
  // returns 202 then the VM never actually starts. Hot tier
  // (pause/resume via SharedVM) is blocked on getting `bin/lume`
  // properly signed — see docs/BLOCKED.md.
  const logPath = join(PATHS.vmDir(name), "lume-run.log");
  const logFd = openSync(logPath, "a");
  const t0 = Date.now();
  const proc = spawn(
    ["lume", "run", name, "--no-display"],
    { stdout: logFd, stderr: logFd, stdin: "ignore" },
  );
  proc.unref();

  await lume.waitForStatus(name, "running", {
    timeoutMs: 60_000,
    intervalMs: 500,
  });

  const deadline = Date.now() + 60_000;
  let ip: string | null = null;
  while (Date.now() < deadline) {
    ip = await readDhcpLease(name);
    if (ip) break;
    await Bun.sleep(1000);
  }
  if (!ip) {
    throw new Error(`splite '${name}' running but no DHCP lease within 60s`);
  }
  return { ip, bootMs: Date.now() - t0, alreadyRunning: false };
}

// Hot tier — pause/resume a running splite via the patched lume HTTP
// API. Two-part block: (1) splites started via startSplite live
// outside lume serve's SharedVM cache, (2) lume serve's own /run
// can't start them because our hot-built `bin/lume` lacks the
// virtualization entitlement. Both are unblocked once `bin/lume`
// is Developer-ID-signed with `lume.entitlements` + a provisioning
// profile — see docs/BLOCKED.md.
export async function pauseSplite(name: string): Promise<void> {
  const lume = new LumeClient();
  await lume.pause(name);
}

export async function resumeSplite(name: string): Promise<void> {
  const lume = new LumeClient();
  await lume.resume(name);
}
