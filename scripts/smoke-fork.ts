// Fork matrix smoke test. Spawns N wells from a saved image,
// asserts each gets a unique IP + boots, then tears down. Catches
// regressions in the fork path (DHCP, identity, lifecycle) before
// the cells team hits them in birth.
//
// Usage:
//   bun run scripts/smoke-fork.ts <image-name> [--count=5] [--prefix=smoke]
//
// Source image must already exist (run scripts/bake-base-image.ts
// first or save one via `well image save`). Images that fail the
// `createWell` contract gate (rinsed=true, missing version) abort
// the smoke up front.
//
// Cleanup: forks created here are destroyed at the end whether the
// smoke passed or failed. Caller can pass --keep to leave them for
// inspection.

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Args {
  image: string;
  count: number;
  prefix: string;
  keep: boolean;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (k: string) => {
    const long = argv.find((a) => a.startsWith(`--${k}=`));
    if (long) return long.slice(k.length + 3);
    const i = argv.indexOf(`--${k}`);
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      return argv[i + 1]!;
    }
    return undefined;
  };
  const image = positional[0];
  if (!image) {
    console.error(
      "usage: bun run scripts/smoke-fork.ts <image-name> [--count=5] [--prefix=smoke] [--keep]",
    );
    process.exit(2);
  }
  return {
    image,
    count: Number(flag("count") ?? "5"),
    prefix: flag("prefix") ?? "smoke",
    keep: argv.includes("--keep"),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7878",
  };
}

async function readToken(): Promise<string> {
  const path = join(homedir(), ".wells", "token");
  return (await readFile(path, "utf-8")).trim();
}

async function api<T>(
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
  return text ? JSON.parse(text) : (undefined as T);
}

interface ForkResult {
  name: string;
  ip: string | null;
  ok: boolean;
  reason?: string;
  ms: number;
}

async function forkOne(
  args: Args,
  token: string,
  name: string,
): Promise<ForkResult> {
  const t0 = Date.now();
  try {
    const r = await api<{ name: string; ip: string | null }>(
      args.baseUrl,
      token,
      "POST",
      "/v1/wells",
      {
        name,
        cpu: 2,
        memory: "1GB",
        disk: "50GB",
        from_image: args.image,
      },
    );
    return {
      name,
      ip: r.ip,
      ok: r.ip !== null,
      ms: Date.now() - t0,
      ...(r.ip ? {} : { reason: "no IP returned" }),
    };
  } catch (e) {
    return {
      name,
      ip: null,
      ok: false,
      reason: (e as Error).message,
      ms: Date.now() - t0,
    };
  }
}

async function destroyOne(
  args: Args,
  token: string,
  name: string,
): Promise<void> {
  try {
    await api(args.baseUrl, token, "DELETE", `/v1/wells/${name}`);
  } catch (e) {
    console.warn(`  destroy ${name} failed: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await readToken();

  console.log(`smoke: ${args.count} forks from '${args.image}' (prefix=${args.prefix})`);

  // Spawn forks serially. Concurrent creates hit lume's max_vms cap
  // and the DHCP lease file under contention; serial is the
  // realistic cells-team birth pattern anyway.
  const stamp = Date.now().toString(36);
  const results: ForkResult[] = [];
  for (let i = 1; i <= args.count; i++) {
    const name = `${args.prefix}-${stamp}-${i}`;
    process.stdout.write(`  fork ${i}/${args.count} (${name})... `);
    const r = await forkOne(args, token, name);
    if (r.ok) console.log(`ok ${r.ip} (${r.ms}ms)`);
    else console.log(`FAIL ${r.reason} (${r.ms}ms)`);
    results.push(r);
  }

  // Assertions.
  const failures: string[] = [];
  const okResults = results.filter((r) => r.ok);
  if (okResults.length !== args.count) {
    failures.push(
      `${results.length - okResults.length}/${args.count} forks failed`,
    );
  }
  const ips = new Set(okResults.map((r) => r.ip));
  if (ips.size !== okResults.length) {
    failures.push(
      `IP collision: ${okResults.length} successful forks but only ${ips.size} unique IPs`,
    );
  }

  if (!args.keep) {
    console.log(`cleanup: destroying ${results.length} forks`);
    for (const r of results) await destroyOne(args, token, r.name);
  } else {
    console.log(`--keep: leaving ${results.length} forks for inspection`);
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE FAILED:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\nSMOKE PASSED: ${args.count} forks, ${ips.size} unique IPs`);
}

await main();
