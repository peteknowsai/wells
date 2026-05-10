#!/usr/bin/env bun
// A.1.6 — full pool-driven lifecycle smoke.
//
// Drives the whole A.1 stack end-to-end through welld's HTTP API:
//
//   1. Refill pool to depth=1 (sets defaults.pool_size=1, kicks the
//      filler, polls until ready).
//   2. Pool-adopt create — measures wall time, asserts ≤2s.
//   3. PATCH auto_sleep_seconds=5 on the well, then idle past it.
//      Polls runtime.json until state=hibernating (watchdog fires
//      every 30s, so ≤40s wall worst case).
//   4. Wake via POST /v1/wells/<n>/wake — measures, asserts ≤2s
//      (matches the headline-but-relaxed wake target; A.1.4.c.iv
//      adoption was sub-1s, post-hibernate wake is the same shape).
//   5. SSH-probe the well to confirm reachable post-wake. Asserts
//      ≤5s.
//   6. Cleanup: destroy the well + restore defaults.pool_size.
//
// Usage:
//   WELL_BASE_URL=http://127.0.0.1:7879 \
//     WELL_STATE_DIR=$HOME/.wells-dev \
//     WELL_LUME_PORT=7780 \
//     bun run scripts/smoke-warm-pool.ts [--keep] [--name=warm]
//
// Targets (per A.1.6):
//   - Create (pool-adopted):   ≤2000ms
//   - Wake (post-hibernate):   ≤2000ms
//   - SSH after wake:          ≤5000ms

import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

interface Args {
  keep: boolean;
  name: string;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const m = argv.find((a) => a.startsWith(`--${k}=`));
    return m ? m.slice(k.length + 3) : def;
  };
  return {
    keep: argv.includes("--keep"),
    name: flag("name", `warm-${Date.now().toString(36)}`),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879",
  };
}

async function readToken(baseUrl: string): Promise<string> {
  const stateDir = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  return (await readFile(join(homedir(), stateDir, "token"), "utf-8")).trim();
}

async function api<T = unknown>(
  baseUrl: string, token: string,
  method: string, path: string, body?: unknown,
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

async function sshProbe(name: string, ip: string, stateDir: string): Promise<boolean> {
  const keyPath = join(stateDir, "vms", name, "ssh_key");
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=2",
      "-o", "BatchMode=yes",
      "-o", "LogLevel=ERROR",
      "-i", keyPath,
      `ubuntu@${ip}`,
      "true",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  return (await proc.exited) === 0;
}

async function check(label: string, ms: number, target: number): Promise<boolean> {
  const ok = ms <= target;
  console.log(`  [${ok ? "OK" : "FAIL"}] ${label}: ${ms}ms (target ≤${target}ms)`);
  return ok;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await readToken(args.baseUrl);
  const stateDir = process.env.WELL_STATE_DIR ?? join(homedir(), ".wells");
  console.log(`smoke-warm-pool — base=${args.baseUrl} state=${stateDir} name=${args.name}`);

  // 1. Save current defaults so we can restore on cleanup.
  const defaultsPath = join(stateDir, "defaults.json");
  let priorDefaults: Record<string, unknown> | null = null;
  try { priorDefaults = JSON.parse(await readFile(defaultsPath, "utf-8")); } catch {}
  const targetDefaults = { ...(priorDefaults ?? {}), pool_size: 1 };
  await writeFile(defaultsPath, JSON.stringify(targetDefaults));
  console.log(`set defaults.pool_size=1 (was ${priorDefaults?.pool_size ?? "absent"})`);

  // 2. Refill + wait for ready.
  console.log("refill + wait for pool depth=1...");
  await api(args.baseUrl, token, "POST", "/v1/wells/pool/refill");
  const fillDeadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < fillDeadline) {
    const r = await api<{ ready_count: number }>(args.baseUrl, token, "GET", "/v1/wells/pool");
    if (r.ready_count >= 1) { ready = true; break; }
    await Bun.sleep(2_000);
  }
  if (!ready) throw new Error("pool didn't reach depth=1 within 60s");
  console.log("  pool ready");

  // 3. Pool-adopt create.
  console.log(`\ncreate ${args.name} (should pool-adopt)...`);
  const t0 = Date.now();
  await api(args.baseUrl, token, "POST", "/v1/wells", { name: args.name });
  const createMs = Date.now() - t0;

  // 4. Set short auto-sleep, idle, wait for watchdog.
  console.log(`\nset auto_sleep_seconds=5, wait for watchdog hibernate...`);
  await api(args.baseUrl, token, "PATCH", `/v1/wells/${args.name}`,
    { auto_sleep_seconds: 5 });
  const runtimePath = join(stateDir, "vms", args.name, "runtime.json");
  // Watchdog ticks every 30s. From the moment auto_sleep elapses, worst-
  // case wait is the next tick boundary. Cap at 60s.
  const hibDeadline = Date.now() + 60_000;
  let hibernated = false;
  while (Date.now() < hibDeadline) {
    try {
      const r = JSON.parse(await readFile(runtimePath, "utf-8"));
      if (r.state === "hibernating") { hibernated = true; break; }
    } catch {}
    await Bun.sleep(2_000);
  }
  if (!hibernated) throw new Error("well didn't hibernate within 60s after auto-sleep");
  console.log("  hibernated");

  // 5. Wake.
  console.log("\nwake...");
  const tWake = Date.now();
  await api(args.baseUrl, token, "POST", `/v1/wells/${args.name}/wake`);
  const wakeMs = Date.now() - tWake;

  // 6. Resolve IP, SSH-probe.
  console.log("\nresolve IP + ssh probe...");
  const tSsh = Date.now();
  let ip: string | null = null;
  let sshOk = false;
  while (Date.now() - tSsh < 5_000) {
    const w = await api<{ ip: string | null }>(args.baseUrl, token, "GET", `/v1/wells/${args.name}`);
    if (w.ip) {
      ip = w.ip;
      if (await sshProbe(args.name, ip, stateDir)) { sshOk = true; break; }
    }
    await Bun.sleep(500);
  }
  const sshMs = Date.now() - tSsh;
  if (!sshOk) console.log(`  WARN: ssh probe failed (ip=${ip ?? "unknown"})`);

  // 7. Cleanup.
  if (!args.keep) {
    console.log("\ncleanup...");
    try {
      await api(args.baseUrl, token, "DELETE", `/v1/wells/${args.name}`);
    } catch (e) { console.error(`  destroy: ${(e as Error).message}`); }
  }
  // Restore defaults regardless of --keep — we don't want to leave the
  // dev default flipped.
  if (priorDefaults) {
    await writeFile(defaultsPath, JSON.stringify(priorDefaults));
  } else {
    await writeFile(defaultsPath, JSON.stringify({ pool_size: 0 }));
  }
  console.log("  defaults restored");

  // 8. Assertions.
  console.log("\nresults:");
  let failed = false;
  if (!(await check("create (pool-adopted)", createMs, 2000))) failed = true;
  if (!(await check("wake (post-hibernate)", wakeMs, 2000))) failed = true;
  if (!(await check("ssh after wake", sshMs, 5000))) failed = true;
  if (!sshOk) failed = true;

  if (failed) {
    console.error("\nSMOKE FAILED");
    process.exit(1);
  }
  console.log("\nSMOKE PASSED");
}

await main();
