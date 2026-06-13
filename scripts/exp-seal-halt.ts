#!/usr/bin/env bun
// exp-seal-halt.ts — measure halt→disk-release for candidate seal strategies.
//
// The seal step (lib/lifecycle.ts sealWell) halts the guest then waits up to
// 60s for the VZ process to drop the bundle disk handle before it can restart
// disk-only. In production that wait times out ~25x/day (stage=seal,
// "disk still held within 60000ms"). This harness compares halt strategies on
// a dedicated test well, measuring:
//   - haltCode: exit status of the halt command (silent-ssh-failure detector)
//   - releaseMs: ms from halt-issued to lsof showing the disk free
//   - timedOut: releaseMs exceeded the prod 60s budget
//   - path:     for hybrid, whether sysrq sufficed or we fell back
//
// Usage:
//   bun scripts/exp-seal-halt.ts <well> [--trials=N] [--strategies=a,b,..] [--load=N]
//
// Strategies: sysrq | lumestop | hybrid | poweroff
// --load=N spins N host-side `dd` writers to amplify I/O contention during the
//          run (cleaned up at exit), to probe behaviour in the failure regime.
//
// NOT wired into welld — a throwaway measurement tool. Operates on a well you
// created with `well create <name>`; never touches pool eggs.

import { spawn } from "bun";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { resolveWellIp } from "../lib/dhcp.ts";
import { resolveLumeName } from "../lib/registry.ts";
import { PATHS } from "../lib/state.ts";
import { stopWell, startWell } from "../lib/lifecycle.ts";

type Strategy = "sysrq" | "lumestop" | "hybrid" | "poweroff";

interface Trial {
  strategy: Strategy;
  haltCode: number | null; // exit code of the halt command (null = n/a)
  haltMs: number; // how long the halt command itself took
  releaseMs: number | null; // t0 → disk free; null = never within cap
  timedOut60: boolean; // would prod's 60s budget have failed?
  path: string; // "sysrq" | "fallback" | "-"
  vzAtStart: number; // host VZ proc count when the trial began
}

const FALLBACK_MS = 8_000; // hybrid: how long to trust sysrq before escalating
const RELEASE_CAP_MS = 90_000; // how long we'll wait before calling it a non-release

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
}

async function sh(
  cmd: string[],
  timeoutMs = 15_000,
): Promise<{ code: number; out: string }> {
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out };
}

async function vzProcCount(): Promise<number> {
  const { out } = await sh([
    "pgrep",
    "-f",
    "Virtualization.VirtualMachine.xpc",
  ]);
  return out.trim() ? out.trim().split("\n").length : 0;
}

async function diskHeld(disk: string): Promise<boolean> {
  const proc = spawn(["lsof", disk], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}

// Poll lsof from t0 until the disk is free or we hit the cap. Returns ms.
async function timeToRelease(disk: string, t0: number): Promise<number | null> {
  const deadline = t0 + RELEASE_CAP_MS;
  while (Date.now() < deadline) {
    if (!(await diskHeld(disk))) return Date.now() - t0;
    await Bun.sleep(100);
  }
  return null;
}

function sshArgs(name: string, ip: string, remote: string): string[] {
  return [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=4",
    "-o", "LogLevel=ERROR",
    "-o", "BatchMode=yes",
    "-i", PATHS.vmSshKey(name),
    `root@${ip}`,
    remote,
  ];
}

// Guarantee a fresh, SSH-reachable running guest before each trial.
async function ensureFreshRunning(name: string): Promise<string> {
  const lume = new LumeClient();
  const lumeName = await resolveLumeName(name);
  const info = await lume.info(lumeName).catch(() => null);
  let ip = await resolveWellIp(name);
  // Probe SSH if it claims to be running.
  let reachable = false;
  if (info?.status === "running" && ip) {
    const r = await sh(sshArgs(name, ip, "true"), 6_000);
    reachable = r.code === 0;
  }
  if (!reachable) {
    await stopWell(name).catch(() => {});
    const r = await startWell(name, { verifySsh: true });
    ip = r.ip || (await resolveWellIp(name));
  }
  if (!ip) throw new Error(`no IP for ${name}`);
  return ip;
}

const SYSRQ_CMD =
  "sync && echo s > /proc/sysrq-trigger && echo o > /proc/sysrq-trigger";

async function runTrial(name: string, strategy: Strategy): Promise<Trial> {
  const lumeName = await resolveLumeName(name);
  const disk = bundleDiskPath(lumeName);
  const ip = await ensureFreshRunning(name);
  const vzAtStart = await vzProcCount();

  // Settle: make sure the disk is actually held (VM fully up) before we time.
  for (let i = 0; i < 50 && !(await diskHeld(disk)); i++) await Bun.sleep(100);

  const t0 = Date.now();
  let haltCode: number | null = null;
  let haltMs = 0;
  let path = "-";

  if (strategy === "sysrq") {
    const h0 = Date.now();
    const r = await sh(sshArgs(name, ip, SYSRQ_CMD), 12_000);
    haltMs = Date.now() - h0;
    haltCode = r.code;
    path = "sysrq";
  } else if (strategy === "poweroff") {
    const h0 = Date.now();
    // --no-block so ssh returns instead of dying with the guest.
    const r = await sh(
      sshArgs(name, ip, "sync && systemctl --no-block poweroff"),
      12_000,
    );
    haltMs = Date.now() - h0;
    haltCode = r.code;
    path = "poweroff";
  } else if (strategy === "lumestop") {
    const h0 = Date.now();
    await stopWell(name); // ACPI requestStop + 30s → forceful fallback
    haltMs = Date.now() - h0;
    haltCode = 0;
    path = "lumestop";
  } else if (strategy === "hybrid") {
    const h0 = Date.now();
    const r = await sh(sshArgs(name, ip, SYSRQ_CMD), 12_000);
    haltCode = r.code;
    haltMs = Date.now() - h0;
    // Trust sysrq for FALLBACK_MS, then escalate to host teardown.
    const fbDeadline = Date.now() + FALLBACK_MS;
    let released = false;
    while (Date.now() < fbDeadline) {
      if (!(await diskHeld(disk))) {
        released = true;
        break;
      }
      await Bun.sleep(100);
    }
    if (released) {
      path = "sysrq";
    } else {
      path = "fallback";
      await stopWell(name);
    }
  }

  const releaseMs = await timeToRelease(disk, t0);
  return {
    strategy,
    haltCode,
    haltMs,
    releaseMs,
    timedOut60: releaseMs === null || releaseMs > 60_000,
    path,
    vzAtStart,
  };
}

// Optional host-side I/O load to push into the failure regime.
function startLoad(n: number): (() => void) {
  if (n <= 0) return () => {};
  const procs: ReturnType<typeof spawn>[] = [];
  const dir = `${process.env.TMPDIR ?? "/tmp"}/exp-seal-load`;
  spawn(["mkdir", "-p", dir]);
  for (let i = 0; i < n; i++) {
    // Continuous 512MB write/delete churn — saturates the same disk path
    // the VZ bundles live on.
    procs.push(
      spawn(
        [
          "bash",
          "-c",
          `while true; do dd if=/dev/zero of=${dir}/w${i} bs=1m count=512 2>/dev/null; rm -f ${dir}/w${i}; done`,
        ],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
      ),
    );
  }
  return () => {
    for (const p of procs) p.kill();
    spawn(["rm", "-rf", dir]);
  };
}

function summarize(trials: Trial[]) {
  const byStrat = new Map<Strategy, Trial[]>();
  for (const t of trials) {
    const arr = byStrat.get(t.strategy) ?? [];
    arr.push(t);
    byStrat.set(t.strategy, arr);
  }
  console.log(
    "\n=== RESULTS (releaseMs = halt→disk-free; prodFail = would exceed 60s) ===",
  );
  console.log(
    "strategy   n  haltCodes  fail/n  p50ms  p90ms  maxms  paths",
  );
  for (const [strat, arr] of byStrat) {
    const rels = arr
      .map((t) => t.releaseMs)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    const p = (q: number) =>
      rels.length ? rels[Math.min(rels.length - 1, Math.floor(q * rels.length))] : NaN;
    const fails = arr.filter((t) => t.timedOut60).length;
    const codes = [...new Set(arr.map((t) => t.haltCode))].join(",");
    const paths = [...new Set(arr.map((t) => t.path))].join(",");
    console.log(
      `${strat.padEnd(10)} ${String(arr.length).padStart(2)}  ${codes.padEnd(9)}  ${String(fails).padStart(2)}/${arr.length}    ${String(Math.round(p(0.5))).padStart(5)}  ${String(Math.round(p(0.9))).padStart(5)}  ${String(rels.length ? rels[rels.length - 1] : NaN).padStart(5)}  ${paths}`,
    );
  }
  console.log("\n=== raw ===");
  for (const t of trials) {
    console.log(
      `${t.strategy.padEnd(10)} vz=${t.vzAtStart} haltCode=${t.haltCode} haltMs=${t.haltMs} releaseMs=${t.releaseMs ?? "NEVER"} prodFail=${t.timedOut60} path=${t.path}`,
    );
  }
}

async function main() {
  const well = process.argv[2];
  if (!well || well.startsWith("--")) {
    console.error("usage: bun scripts/exp-seal-halt.ts <well> [--trials=N] [--strategies=a,b] [--load=N]");
    process.exit(2);
  }
  const trials = parseInt(arg("trials", "6"), 10);
  const strategies = arg("strategies", "sysrq,lumestop,hybrid").split(",") as Strategy[];
  const load = parseInt(arg("load", "0"), 10);

  console.log(
    `well=${well} trials=${trials}/strategy strategies=${strategies.join(",")} load=${load}`,
  );
  const stopLoad = startLoad(load);
  const results: Trial[] = [];
  try {
    // Interleave strategies round-robin so drift in host load is shared
    // evenly across them rather than biasing whichever runs last.
    for (let i = 0; i < trials; i++) {
      for (const s of strategies) {
        const t = await runTrial(well, s);
        results.push(t);
        console.log(
          `[${i + 1}/${trials}] ${s.padEnd(9)} vz=${t.vzAtStart} code=${t.haltCode} release=${t.releaseMs ?? "NEVER"}ms prodFail=${t.timedOut60} path=${t.path}`,
        );
      }
    }
  } finally {
    stopLoad();
  }
  summarize(results);
  // Leave the well stopped.
  await stopWell(well).catch(() => {});
}

await main();
