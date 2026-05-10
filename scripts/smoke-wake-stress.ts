#!/usr/bin/env bun
// W.10 — wake reliability stress smoke.
//
// Repeatedly hibernates → wakes a single long-lived well, captures
// per-phase timing distribution (hibernate ms, wake ms, ssh-after-wake
// ms) across N cycles, asserts on p50/p95/p99 thresholds, writes
// results to docs/findings-wake-stress-<date>.md.
//
// Why a separate smoke from smoke-hibernate-wake.ts:
//   - smoke-hibernate-wake exercises CREATE+hibernate+wake, 3 cycles.
//     The create dominates wall clock (~12s) and hides wake variance.
//   - smoke-wake-stress reuses one well and pounds the hibernate↔wake
//     loop, surfacing the long tail of the lume @MainActor variance
//     pattern (W.6 / B.0.9.d.5.b residual). 30+ cycles makes p95/p99
//     meaningful.
//
// Default targets dev welld :7879 (W.18 unblock first; smoke fails
// fast if dev is broken).
//
// Usage:
//   bun run scripts/smoke-wake-stress.ts [--cycles=30] [--name=<n>]
//                                         [--image=<n>] [--keep]
//                                         [--report=<path>]
//                                         [--p95-wake-ms=2000]
//                                         [--p95-ssh-ms=2500]
//
// Targets (per MVP-PLAN B.0.9.d.4.e):
//   p50 hibernate ≤ 200ms
//   p95 hibernate ≤ 250ms
//   p50 wake ≤ 1000ms
//   p95 wake ≤ 2000ms          ← the headline regression detector
//   p95 ssh-after-wake ≤ 2500ms

import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

interface Args {
  cycles: number;
  name: string;
  image: string;
  keep: boolean;
  report: string;
  baseUrl: string;
  p95WakeMs: number;
  p95SshMs: number;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const long = argv.find((a) => a.startsWith(`--${k}=`));
    if (long) return long.slice(k.length + 3);
    return def;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    cycles: Number(flag("cycles", "30")),
    name: flag("name", "wake-stress"),
    image: flag("image", "ubuntu-25.10-base"),
    keep: argv.includes("--keep"),
    report: flag("report", `docs/findings-wake-stress-${today}.md`),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879",
    p95WakeMs: Number(flag("p95-wake-ms", "2000")),
    p95SshMs: Number(flag("p95-ssh-ms", "2500")),
  };
}

async function readToken(baseUrl: string): Promise<string> {
  const stateDir = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  const path = join(homedir(), stateDir, "token");
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
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function sshProbe(name: string, ip: string, baseUrl: string): Promise<boolean> {
  const stateRoot = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  const keyPath = join(homedir(), stateRoot, "vms", name, "ssh_key");
  if (!existsSync(keyPath)) return false;
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=2",
      "-o", "BatchMode=yes",
      "-o", "LogLevel=ERROR",
      "-i", keyPath,
      `well@${ip}`,
      "true",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  const code = await proc.exited;
  return code === 0;
}

async function waitForSsh(
  name: string,
  ip: string,
  timeoutMs: number,
  baseUrl: string,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await sshProbe(name, ip, baseUrl)) return Date.now() - start;
    await Bun.sleep(150);
  }
  throw new Error(`ssh not ready within ${timeoutMs}ms for ${name}@${ip}`);
}

interface CycleStat {
  cycle: number;
  hibernateMs: number;
  wakeMs: number;
  sshMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

interface Distribution {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function dist(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0] ?? 0,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.at(-1) ?? 0,
  };
}

function fmtRow(label: string, d: Distribution): string {
  return `| ${label.padEnd(16)} | ${String(d.min).padStart(6)}ms | ${String(d.p50).padStart(6)}ms | ${String(d.p95).padStart(6)}ms | ${String(d.p99).padStart(6)}ms | ${String(d.max).padStart(6)}ms |`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `smoke-wake-stress: target=${args.baseUrl}, well=${args.name}, cycles=${args.cycles}`,
  );

  const token = await readToken(args.baseUrl);

  // 1. Provision the well once. If the well already exists, reuse it
  // (saves ~12s on retry runs against a half-broken environment).
  let ip: string;
  try {
    const existing = await api<{ ip: string; status: string }>(
      args.baseUrl,
      token,
      "GET",
      `/v1/wells/${args.name}`,
    );
    if (existing.status !== "running") {
      console.log("  existing well not running; starting…");
      await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/start`);
    }
    ip = existing.ip;
    console.log(`  reusing well ${args.name} at ${ip}`);
  } catch {
    console.log(`  creating ${args.name}…`);
    const created = await api<{ ip: string; status: string }>(
      args.baseUrl,
      token,
      "POST",
      "/v1/wells",
      { name: args.name, from_image: args.image },
    );
    ip = created.ip;
    console.log(`  created ${args.name} at ${ip}`);
  }

  // 2. Cycle hibernate → wake → ssh probe N times.
  const stats: CycleStat[] = [];
  const failures: string[] = [];
  for (let i = 1; i <= args.cycles; i++) {
    process.stdout.write(`cycle ${i}/${args.cycles}: `);
    try {
      const t1 = Date.now();
      await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/hibernate`);
      const hibMs = Date.now() - t1;

      const t2 = Date.now();
      await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/wake`);
      const wakeMs = Date.now() - t2;

      const sshMs = await waitForSsh(args.name, ip, 10_000, args.baseUrl);
      console.log(`hib=${hibMs}ms wake=${wakeMs}ms ssh=${sshMs}ms`);
      stats.push({ cycle: i, hibernateMs: hibMs, wakeMs, sshMs });
    } catch (e) {
      console.log(`FAILED — ${(e as Error).message}`);
      failures.push(`cycle ${i}: ${(e as Error).message}`);
    }
  }

  // 3. Compute distributions + assert.
  const hibDist = dist(stats.map((s) => s.hibernateMs));
  const wakeDist = dist(stats.map((s) => s.wakeMs));
  const sshDist = dist(stats.map((s) => s.sshMs));

  console.log("");
  console.log(`| ${'phase'.padEnd(16)} | ${'min'.padStart(8)} | ${'p50'.padStart(8)} | ${'p95'.padStart(8)} | ${'p99'.padStart(8)} | ${'max'.padStart(8)} |`);
  console.log(`| ${'-'.repeat(16)} | ${'-'.repeat(8)} | ${'-'.repeat(8)} | ${'-'.repeat(8)} | ${'-'.repeat(8)} | ${'-'.repeat(8)} |`);
  console.log(fmtRow("hibernate", hibDist));
  console.log(fmtRow("wake", wakeDist));
  console.log(fmtRow("ssh-after-wake", sshDist));
  console.log("");
  console.log(`completed: ${stats.length}/${args.cycles}, failures: ${failures.length}`);

  // 4. Threshold gates.
  const gateFailures: string[] = [];
  if (wakeDist.p95 > args.p95WakeMs) {
    gateFailures.push(`p95 wake ${wakeDist.p95}ms > ${args.p95WakeMs}ms gate`);
  }
  if (sshDist.p95 > args.p95SshMs) {
    gateFailures.push(`p95 ssh-after-wake ${sshDist.p95}ms > ${args.p95SshMs}ms gate`);
  }

  // 5. Write findings doc.
  const reportPath = join(process.cwd(), args.report);
  const reportBody = renderReport({
    args,
    hibDist,
    wakeDist,
    sshDist,
    stats,
    failures,
    gateFailures,
  });
  await writeFile(reportPath, reportBody);
  console.log(`wrote ${args.report}`);

  // 6. Cleanup unless --keep.
  if (!args.keep) {
    console.log("destroy well…");
    try {
      await api(args.baseUrl, token, "DELETE", `/v1/wells/${args.name}`);
    } catch (e) {
      console.warn(`destroy failed: ${(e as Error).message}`);
    }
  } else {
    console.log("(--keep, well left in place)");
  }

  if (failures.length > 0 || gateFailures.length > 0) {
    console.error("");
    console.error("smoke FAILED:");
    for (const f of [...failures, ...gateFailures]) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("✅ wake stress smoke passed all gates");
}

interface ReportArgs {
  args: Args;
  hibDist: Distribution;
  wakeDist: Distribution;
  sshDist: Distribution;
  stats: CycleStat[];
  failures: string[];
  gateFailures: string[];
}

function renderReport(r: ReportArgs): string {
  const ts = new Date().toISOString();
  const verdict =
    r.failures.length === 0 && r.gateFailures.length === 0
      ? "PASS"
      : "FAIL";
  return `# findings — wake stress (W.10)

**Run:** ${ts}
**Verdict:** ${verdict}
**Cycles:** ${r.stats.length} of ${r.args.cycles} completed (${r.failures.length} failures)
**Target welld:** ${r.args.baseUrl}
**Source image:** ${r.args.image}

## Distribution (ms)

| phase            | min      | p50      | p95      | p99      | max      |
| ---------------- | -------- | -------- | -------- | -------- | -------- |
${fmtRow("hibernate", r.hibDist)}
${fmtRow("wake", r.wakeDist)}
${fmtRow("ssh-after-wake", r.sshDist)}

## Gate results

- p95 wake ≤ ${r.args.p95WakeMs}ms — ${r.wakeDist.p95 <= r.args.p95WakeMs ? "PASS" : `FAIL (${r.wakeDist.p95}ms)`}
- p95 ssh-after-wake ≤ ${r.args.p95SshMs}ms — ${r.sshDist.p95 <= r.args.p95SshMs ? "PASS" : `FAIL (${r.sshDist.p95}ms)`}

## Failures (cycle-level)

${r.failures.length === 0 ? "_(none)_" : r.failures.map((f) => `- ${f}`).join("\n")}

## Gate failures

${r.gateFailures.length === 0 ? "_(none)_" : r.gateFailures.map((f) => `- ${f}`).join("\n")}

## Per-cycle raw data

| cycle | hibernate | wake | ssh-after-wake |
| ----- | --------- | ---- | -------------- |
${r.stats.map((s) => `| ${s.cycle} | ${s.hibernateMs}ms | ${s.wakeMs}ms | ${s.sshMs}ms |`).join("\n")}

## How to read this

- **hibernate** is welld's POST /v1/wells/NAME/hibernate round-trip — wraps lume.saveState (RAM → disk).
- **wake** is welld's POST /v1/wells/NAME/wake round-trip — wraps lume.restoreState (disk → RAM, VM resumes).
- **ssh-after-wake** is host-side ssh probe latency from VM resume to the first successful TCP connect + SSH handshake.

Long tails in **wake** typically indicate lume's @MainActor blocking (W.6 / B.0.9.d.5.b residual) — a slow ARP fallback, slow info() poll, or a single-threaded HTTP handler holding the actor while the next request piles up. Long tails in **ssh-after-wake** with normal **wake** typically indicate networkd-wait-online slowness or sshd slow-start in the guest.

If both **wake** and **ssh-after-wake** spike together on the same cycle, the VM is stuck mid-resume (Apple VZ kernel state churn) — those are the worst hangs.
`;
}

main().catch((e) => {
  console.error(`smoke-wake-stress failed: ${(e as Error).message}`);
  process.exit(1);
});
