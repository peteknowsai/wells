#!/usr/bin/env bun
// Press-release verification. Reproduces every concrete on/off claim
// from the wells press release with empirical numbers — runs N
// hibernate/wake cycles against a single well, captures the distribution,
// and asserts the press-release thresholds.
//
// Usage:
//   bun run scripts/verify-press-release.ts [--cycles=10] [--name=verify]
//
// Claims verified:
//   1. Hibernate to disk in under 200ms (per-cycle, p50)
//   2. Wake in under one second (per-cycle, p50)
//   3. SSH reachable after wake
//   4. Backgrounded process survives hibernate→wake (proves agent
//      context + process state preserved)
//
// Not verified here (harder, separate scripts):
//   - Inter-cell sub-ms RTT (needs two cells)
//   - RAM fully reclaimed during hibernate (would need vm_stat
//     baselining; flaky on a busy host)

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

interface Args {
  cycles: number;
  name: string;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const long = argv.find((a) => a.startsWith(`--${k}=`));
    if (long) return long.slice(k.length + 3);
    return def;
  };
  return {
    cycles: Number(flag("cycles", "10")),
    name: flag("name", "verify"),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7878",
  };
}

async function readToken(): Promise<string> {
  const path = join(homedir(), ".wells", "token");
  return (await readFile(path, "utf-8")).trim();
}

async function api<T = unknown>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

interface SshResult {
  ok: boolean;
  stdout: string;
}

async function sshExec(name: string, ip: string, cmd: string): Promise<SshResult> {
  const keyPath = join(homedir(), ".wells", "vms", name, "ssh_key");
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", keyPath,
      `ubuntu@${ip}`,
      cmd,
    ],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { ok: code === 0, stdout: stdout.trim() };
}

async function waitForSsh(name: string, ip: string, deadlineMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = await sshExec(name, ip, "true");
    if (r.ok) return Date.now() - start;
    await Bun.sleep(200);
  }
  throw new Error(`${name}: SSH not reachable within ${deadlineMs}ms`);
}

interface CycleStat {
  cycle: number;
  hibernateMs: number;
  wakeMs: number;
  sshAfterWakeMs: number;
  bgProcessSurvived: boolean;
  bgProcessPid: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * (p / 100)));
  return sorted[idx]!;
}

function summarize(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const max = sorted[sorted.length - 1] ?? 0;
  const min = sorted[0] ?? 0;
  return `${label.padEnd(18)} min=${min}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${max}ms`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await readToken();
  const stamp = Date.now().toString(36);
  const wellName = `${args.name}-${stamp}`;

  console.log(`Press-release verification: ${args.cycles} hibernate/wake cycles on '${wellName}'`);
  console.log();

  console.log("Creating well...");
  const t0 = Date.now();
  const created = await api<{ ip: string }>(
    args.baseUrl,
    token,
    "POST",
    "/v1/wells",
    { name: wellName },
  );
  const createMs = Date.now() - t0;
  const ip = created.ip;
  console.log(`  created in ${createMs}ms, ip=${ip}`);

  // Start a long-running background process inside the well. Pid is the
  // canary: if it survives hibernate→wake, the agent's process context
  // is genuinely preserved (not just rebooted from disk).
  console.log("\nStarting canary background process...");
  const startCanary = await sshExec(
    wellName,
    ip,
    "nohup sleep 99999 > /tmp/canary.log 2>&1 & echo $!",
  );
  if (!startCanary.ok) throw new Error(`failed to start canary: ${startCanary.stdout}`);
  const canaryPid = Number(startCanary.stdout);
  console.log(`  canary pid=${canaryPid}`);

  const results: CycleStat[] = [];
  try {
    for (let i = 1; i <= args.cycles; i++) {
      console.log(`\nCycle ${i}/${args.cycles}:`);

      // Hibernate
      const t1 = Date.now();
      await api(args.baseUrl, token, "POST", `/v1/wells/${wellName}/hibernate`);
      const hibernateMs = Date.now() - t1;
      console.log(`  hibernate: ${hibernateMs}ms`);

      // Wake
      const t2 = Date.now();
      await api(args.baseUrl, token, "POST", `/v1/wells/${wellName}/wake`);
      const wakeMs = Date.now() - t2;
      console.log(`  wake: ${wakeMs}ms`);

      // SSH-after-wake (proves cell is reachable)
      const sshAfterWakeMs = await waitForSsh(wellName, ip, 15_000);
      console.log(`  ssh-after-wake: ${sshAfterWakeMs}ms`);

      // Canary check (proves process state survived)
      const check = await sshExec(wellName, ip, `kill -0 ${canaryPid} 2>&1 && echo alive || echo dead`);
      const survived = check.ok && check.stdout.trim() === "alive";
      console.log(`  canary survived: ${survived}`);

      results.push({
        cycle: i,
        hibernateMs,
        wakeMs,
        sshAfterWakeMs,
        bgProcessSurvived: survived,
        bgProcessPid: canaryPid,
      });
    }
  } finally {
    console.log("\nCleanup...");
    try {
      await api(args.baseUrl, token, "DELETE", `/v1/wells/${wellName}`);
    } catch (e) {
      console.warn(`  destroy failed: ${(e as Error).message}`);
    }
  }

  console.log("\n========== Press-release verification ==========\n");

  const hibernates = results.map((r) => r.hibernateMs);
  const wakes = results.map((r) => r.wakeMs);
  const sshAfters = results.map((r) => r.sshAfterWakeMs);
  const survivors = results.filter((r) => r.bgProcessSurvived).length;

  console.log("Distribution:");
  console.log(`  ${summarize("hibernate", hibernates)}`);
  console.log(`  ${summarize("wake", wakes)}`);
  console.log(`  ${summarize("ssh-after-wake", sshAfters)}`);

  console.log("\nClaim checks:");
  const hibernateP50 = percentile([...hibernates].sort((a, b) => a - b), 50);
  const wakeP50 = percentile([...wakes].sort((a, b) => a - b), 50);

  type ClaimResult = { claim: string; pass: boolean; detail: string };
  const claims: ClaimResult[] = [
    {
      claim: "Hibernate to disk in under 200ms (p50)",
      pass: hibernateP50 < 200,
      detail: `p50 = ${hibernateP50}ms`,
    },
    {
      claim: "Wake in under one second (p50)",
      pass: wakeP50 < 1000,
      detail: `p50 = ${wakeP50}ms`,
    },
    {
      claim: "SSH reachable after wake (every cycle)",
      pass: results.every((r) => r.sshAfterWakeMs < 15_000),
      detail: `${results.length}/${results.length} cycles ssh ready`,
    },
    {
      claim: "Backgrounded process survives hibernate→wake (every cycle)",
      pass: survivors === results.length,
      detail: `${survivors}/${results.length} cycles canary survived`,
    },
  ];

  for (const c of claims) {
    const mark = c.pass ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${c.claim} — ${c.detail}`);
  }

  const allPass = claims.every((c) => c.pass);
  console.log();
  console.log(allPass ? "ALL CLAIMS VERIFIED" : "SOME CLAIMS FAILED — update the press release or fix the runtime");
  if (!allPass) process.exit(1);
}

await main();
