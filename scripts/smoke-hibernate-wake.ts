#!/usr/bin/env bun
// B.0.9.d.4.e: hibernate/wake smoke test.
//
// Creates a fresh well, hibernates, wakes, asserts SSH works post-
// wake, destroys. Cycles N times back-to-back to catch flakiness.
// This is the gate for ticking B.0.9.d.4 — three clean cycles
// against a freshly-baked ubuntu-25.10-base proves the disk-only
// steady-state contract works end-to-end.
//
// Usage:
//   bun run scripts/smoke-hibernate-wake.ts [--cycles=3] [--name=smoke]
//                                            [--keep] [--image=ubuntu-25.10-base]
//
// Targets (from MVP-PLAN B.0.9.d.4.e):
//   - Create + warm: ≤15s
//   - Hibernate:     ≤5s
//   - Wake:          ≤10s, SSH reachable within 5s after
//   - 3 cycles back-to-back, all ≤15s wall-clock per cycle

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

interface Args {
  cycles: number;
  name: string;
  image: string;
  keep: boolean;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const long = argv.find((a) => a.startsWith(`--${k}=`));
    if (long) return long.slice(k.length + 3);
    return def;
  };
  return {
    cycles: Number(flag("cycles", "3")),
    name: flag("name", "smoke"),
    image: flag("image", "ubuntu-25.10-base"),
    keep: argv.includes("--keep"),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7878",
  };
}

async function readToken(baseUrl?: string): Promise<string> {
  // Token path defaults to ~/.wells/token (stable). When pointed at dev
  // (port 7879), read ~/.wells-dev/token instead so smoke runs against
  // either daemon without a manual override.
  const stateDir = baseUrl?.includes(":7879") ? ".wells-dev" : ".wells";
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
      "Authorization": `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function sshProbe(name: string, ip: string): Promise<boolean> {
  const keyPath = join(homedir(), ".wells", "vms", name, "ssh_key");
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=2",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", keyPath,
      `ubuntu@${ip}`,
      "true",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  return (await proc.exited) === 0;
}

async function waitForSsh(
  name: string,
  ip: string,
  deadlineMs: number,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await sshProbe(name, ip)) return Date.now() - start;
    await Bun.sleep(500);
  }
  throw new Error(`${name}: SSH not ready within ${deadlineMs}ms`);
}

interface CreateResult {
  name: string;
  ip: string;
  status: string;
}

async function cycle(
  args: Args,
  token: string,
  cycleName: string,
): Promise<{ create: number; hibernate: number; wake: number; sshAfterWake: number }> {
  // Create
  const t0 = Date.now();
  const created = await api<CreateResult>(
    args.baseUrl,
    token,
    "POST",
    "/v1/wells",
    { name: cycleName, from_image: args.image },
  );
  const createMs = Date.now() - t0;
  if (created.status !== "running") {
    throw new Error(`expected status=running, got ${created.status}`);
  }
  console.log(`  create: ${createMs}ms (ip=${created.ip})`);

  // Hibernate
  const t1 = Date.now();
  await api(
    args.baseUrl,
    token,
    "POST",
    `/v1/wells/${cycleName}/hibernate`,
  );
  const hibMs = Date.now() - t1;
  console.log(`  hibernate: ${hibMs}ms`);

  // Wake
  const t2 = Date.now();
  await api(
    args.baseUrl,
    token,
    "POST",
    `/v1/wells/${cycleName}/wake`,
  );
  const wakeMs = Date.now() - t2;
  console.log(`  wake: ${wakeMs}ms`);

  // Verify SSH reachable after wake
  const sshMs = await waitForSsh(cycleName, created.ip, 15_000);
  console.log(`  ssh-after-wake: ${sshMs}ms`);

  return { create: createMs, hibernate: hibMs, wake: wakeMs, sshAfterWake: sshMs };
}

async function destroyOne(args: Args, token: string, name: string): Promise<void> {
  try {
    await api(args.baseUrl, token, "DELETE", `/v1/wells/${name}`);
  } catch (e) {
    console.warn(`  destroy ${name} failed: ${(e as Error).message}`);
  }
}

interface CycleStat {
  cycle: number;
  create: number;
  hibernate: number;
  wake: number;
  sshAfterWake: number;
}

function checkTarget(
  label: string,
  value: number,
  targetMs: number,
  failures: string[],
): void {
  if (value > targetMs) {
    failures.push(`${label}: ${value}ms exceeds target ${targetMs}ms`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await readToken(args.baseUrl);
  const stamp = Date.now().toString(36);

  console.log(
    `smoke: ${args.cycles} hibernate/wake cycles from '${args.image}'`,
  );

  const results: CycleStat[] = [];
  const created: string[] = [];
  const failures: string[] = [];

  try {
    for (let i = 1; i <= args.cycles; i++) {
      const cycleName = `${args.name}-${stamp}-${i}`;
      console.log(`\ncycle ${i}/${args.cycles} (${cycleName}):`);
      created.push(cycleName);
      const r = await cycle(args, token, cycleName);
      results.push({ cycle: i, ...r });

      // Targets per MVP-PLAN B.0.9.d.4.e.
      checkTarget(`cycle ${i} create`, r.create, 15_000, failures);
      checkTarget(`cycle ${i} hibernate`, r.hibernate, 5_000, failures);
      checkTarget(`cycle ${i} wake`, r.wake, 10_000, failures);
      checkTarget(`cycle ${i} ssh-after-wake`, r.sshAfterWake, 5_000, failures);
    }
  } finally {
    if (!args.keep) {
      console.log("\ncleanup:");
      for (const n of created) await destroyOne(args, token, n);
    }
  }

  // Summary
  console.log("\nsummary:");
  for (const r of results) {
    console.log(
      `  cycle ${r.cycle}: create=${r.create}ms hibernate=${r.hibernate}ms wake=${r.wake}ms ssh-after=${r.sshAfterWake}ms`,
    );
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\nSMOKE PASSED: ${results.length} cycles, all within targets`);
}

await main();
