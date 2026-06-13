#!/usr/bin/env bun
// exp-seal-halt-validate.ts — prove the REAL haltGuestForSeal rescues the
// production failure modes on a live well. Unlike exp-seal-halt.ts (which
// compares raw strategies), this exercises the actual production function
// (lib/sealHalt.ts) with injected failures, confirming the disk ends up
// released and the right escalation path is reported.
//
//   Case A — healthy: real sysrqHalt. Expect a fast-path release (or a
//            benign fallback under load), disk free.
//   Case B — ssh never lands (own=true: VM stayed up): sysrqHalt → 255.
//            Expect path=fallback/ssh_failed, disk free via lume.stop.
//   Case C — sysrq delivered but VM doesn't tear down (own=true): a no-op
//            remote that exits 0 but never halts. Expect the fast window to
//            lapse, path=fallback/disk_held, disk free via lume.stop.
//
// Usage: bun scripts/exp-seal-halt-validate.ts <well>

import { spawn } from "bun";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { resolveWellIp } from "../lib/dhcp.ts";
import { resolveLumeName } from "../lib/registry.ts";
import { PATHS } from "../lib/state.ts";
import { stopWell, startWell } from "../lib/lifecycle.ts";
import { isDiskReleased } from "../lib/diskReleased.ts";
import {
  haltGuestForSeal,
  realSealHaltDeps,
  type SealHaltDeps,
} from "../lib/sealHalt.ts";

async function sh(cmd: string[], timeoutMs = 8000): Promise<number> {
  const p = spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const t = setTimeout(() => p.kill(), timeoutMs);
  const code = await p.exited;
  clearTimeout(t);
  return code;
}

async function ensureFreshRunning(name: string): Promise<string> {
  const lume = new LumeClient();
  const lumeName = await resolveLumeName(name);
  const info = await lume.info(lumeName).catch(() => null);
  let ip = await resolveWellIp(name);
  let reachable = false;
  if (info?.status === "running" && ip) {
    reachable =
      (await sh(
        [
          "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "-i", PATHS.vmSshKey(name),
          `root@${ip}`, "true",
        ],
        6000,
      )) === 0;
  }
  if (!reachable) {
    await stopWell(name).catch(() => {});
    const r = await startWell(name, { verifySsh: true });
    ip = r.ip || (await resolveWellIp(name));
  }
  if (!ip) throw new Error(`no IP for ${name}`);
  return ip;
}

async function run() {
  const well = process.argv[2];
  if (!well) {
    console.error("usage: bun scripts/exp-seal-halt-validate.ts <well>");
    process.exit(2);
  }
  const lumeName = await resolveLumeName(well);
  const disk = bundleDiskPath(lumeName);

  // ssh failed to land (connect/auth) → exit non-zero. The VM stays up.
  const failSrq = (_n: string, _ip: string) => Promise.resolve(255);
  // Delivered-but-no-teardown: a REAL ssh `true` so the guest keeps running
  // (faithful own=true reproduction) while the halt command exits 0.
  const noopSrq = (name: string, ip: string): Promise<number> =>
    sh(
      [
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=4", "-o", "BatchMode=yes", "-i", PATHS.vmSshKey(name),
        `root@${ip}`, "true",
      ],
      6000,
    );

  const cases: { id: string; deps: () => SealHaltDeps; expectPath: string }[] = [
    { id: "A-healthy", deps: () => realSealHaltDeps(stopWell), expectPath: "any" },
    {
      id: "B-ssh-failed",
      deps: () => ({ ...realSealHaltDeps(stopWell), sysrqHalt: failSrq }),
      expectPath: "fallback",
    },
    {
      id: "C-delivered-no-teardown",
      deps: () => ({ ...realSealHaltDeps(stopWell), sysrqHalt: noopSrq }),
      expectPath: "fallback",
    },
  ];

  for (const c of cases) {
    const ip = await ensureFreshRunning(well);
    const t0 = Date.now();
    let res;
    try {
      res = await haltGuestForSeal(c.deps(), well, ip, disk);
    } catch (e) {
      console.log(`${c.id}: THREW ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const ms = Date.now() - t0;
    const released = await isDiskReleased(disk);
    const pathOk = c.expectPath === "any" || res.path === c.expectPath;
    console.log(
      `${c.id.padEnd(24)} path=${res.path} reason=${res.fallbackReason ?? "-"} haltCode=${res.haltCode} ms=${ms} diskReleased=${released} ${pathOk && released ? "✓ PASS" : "✗ FAIL"}`,
    );
  }
  await stopWell(well).catch(() => {});
}

await run();
