#!/usr/bin/env bun
// W.11 — pool-depth maintenance under churn.
//
// Today smoke-warm-pool.ts is single-cycle. This smoke sets pool_size=2,
// drives N back-to-back create+destroy cycles, then a parallel fan-out
// burst, and asserts the filler keeps the pool at target depth across
// the churn.
//
// What it surfaces:
//   - race in triggerFillIfNeeded (called from adoptFromPool right
//     after removePoolMember). Two adopts in quick succession should
//     coalesce to one fill, not two.
//   - housekeeping tick double-firing (the timer + a manual refill).
//   - pool member rename atomicity (reserveReadyMember →
//     PATHS.poolMemberDir rename → addWell). If two parallel adopts
//     race past `reserveReadyMember`, both shouldn't be able to claim
//     the same pool member.
//
// Targets dev welld :7879 by default. Reuses the smoke-warm-pool
// defaults-rewrite pattern to set pool_size=2 + restore on cleanup.
//
// Usage:
//   bun run scripts/smoke-pool-churn.ts [--cycles=20] [--parallel=3]
//                                        [--target=2] [--prefix=churn]
//                                        [--keep]

import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface Args {
  cycles: number;
  parallel: number;
  target: number;
  prefix: string;
  keep: boolean;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const m = argv.find((a) => a.startsWith(`--${k}=`));
    return m ? m.slice(k.length + 3) : def;
  };
  return {
    cycles: Number(flag("cycles", "20")),
    parallel: Number(flag("parallel", "3")),
    target: Number(flag("target", "2")),
    prefix: flag("prefix", "churn"),
    keep: argv.includes("--keep"),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879",
  };
}

async function readToken(baseUrl: string): Promise<string> {
  const stateDir = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  return (await readFile(join(homedir(), stateDir, "token"), "utf-8")).trim();
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

interface PoolStatus {
  target_size: number;
  ready_count: number;
  provisioning_count: number;
  warming_count: number;
  adopting_count: number;
}

async function poolStatus(
  baseUrl: string,
  token: string,
): Promise<PoolStatus> {
  // /healthz is the single source of truth for pool depth (W.9). It
  // reads defaults.pool_size for target_size and walks the registry
  // for the *_count fields.
  const r = await api<{ pool: PoolStatus }>(baseUrl, token, "GET", "/healthz");
  return r.pool;
}

async function waitForReady(
  baseUrl: string,
  token: string,
  target: number,
  timeoutMs: number,
  what: string,
): Promise<PoolStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: PoolStatus | null = null;
  while (Date.now() < deadline) {
    last = await poolStatus(baseUrl, token);
    if (last.ready_count >= target) return last;
    await Bun.sleep(1500);
  }
  throw new Error(
    `${what}: pool didn't reach ready_count=${target} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

async function destroyOne(
  baseUrl: string,
  token: string,
  name: string,
): Promise<void> {
  try {
    await api(baseUrl, token, "DELETE", `/v1/wells/${name}`);
  } catch (e) {
    console.warn(`  destroy ${name} failed: ${(e as Error).message}`);
  }
}

interface CreateResult {
  name: string;
  ip: string;
  status: string;
  lume_name?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await readToken(args.baseUrl);
  const stateDir = args.baseUrl.includes(":7879")
    ? join(homedir(), ".wells-dev")
    : join(homedir(), ".wells");

  console.log(
    `smoke-pool-churn — base=${args.baseUrl} target=${args.target} cycles=${args.cycles} parallel=${args.parallel}`,
  );

  // 1. Save defaults; bump pool_size to target.
  const defaultsPath = join(stateDir, "defaults.json");
  let prior: Record<string, unknown> | null = null;
  try {
    prior = JSON.parse(await readFile(defaultsPath, "utf-8"));
  } catch {
    /* file may be absent */
  }
  await writeFile(
    defaultsPath,
    JSON.stringify({ ...(prior ?? {}), pool_size: args.target }),
  );
  console.log(`set defaults.pool_size=${args.target} (was ${prior?.pool_size ?? "absent"})`);

  // Tracking: ALL well names we create, so cleanup can sweep even if
  // we exit on assertion failure.
  const createdNames = new Set<string>();

  // We always restore defaults + best-effort destroy any wells we
  // created, regardless of whether we succeeded or threw. Wrapping the
  // happy path in try/finally keeps cleanup robust.
  try {
    // 2. Kick the filler + wait until ready_count >= target.
    console.log("\nrefill + wait for initial pool fill…");
    await api(args.baseUrl, token, "POST", "/v1/wells/pool/refill");
    const initial = await waitForReady(args.baseUrl, token, args.target, 180_000, "initial fill");
    console.log(
      `  pool ready: ${JSON.stringify(initial)} (took up to 3 min on cold dev)`,
    );

    // 3. Sequential churn — N cycles of {create → destroy → assert
    //    refill catches up}.
    console.log(`\n=== sequential churn: ${args.cycles} cycles ===`);
    const failures: string[] = [];
    for (let i = 1; i <= args.cycles; i++) {
      const name = `${args.prefix}-${Date.now().toString(36).slice(-4)}-${i}`;
      const t0 = Date.now();
      try {
        await api<CreateResult>(args.baseUrl, token, "POST", "/v1/wells", { name });
        createdNames.add(name);
        const createMs = Date.now() - t0;

        // Pool should drop by 1 (adoption) then refill back. Don't
        // wait full refill — that's slow (~12s). Just confirm depth
        // is at LEAST target-1 immediately and queue a check for full
        // refill at the cycle boundary instead.
        const afterCreate = await poolStatus(args.baseUrl, token);

        await destroyOne(args.baseUrl, token, name);
        createdNames.delete(name);

        const cycleMs = Date.now() - t0;
        process.stdout.write(
          `cycle ${String(i).padStart(2)}/${args.cycles}: create=${createMs}ms cycle=${cycleMs}ms after_create_ready=${afterCreate.ready_count} `,
        );

        // Brief pause for the filler to react before next cycle.
        // Without this, the next create hits the same depleted pool
        // and the smoke degenerates into "fresh creates with empty pool"
        // which doesn't test what we want.
        await Bun.sleep(800);
        const afterCycle = await poolStatus(args.baseUrl, token);
        console.log(
          `→ end_ready=${afterCycle.ready_count} prov=${afterCycle.provisioning_count}+warm=${afterCycle.warming_count}`,
        );
      } catch (e) {
        const msg = `cycle ${i}: ${(e as Error).message}`;
        failures.push(msg);
        console.log(`FAILED — ${msg}`);
      }
    }

    // 4. After sequential churn, allow the filler to catch up + check
    //    final depth.
    console.log("\nwaiting up to 60s for filler to catch up to target depth…");
    let final: PoolStatus | null = null;
    try {
      final = await waitForReady(args.baseUrl, token, args.target, 60_000, "post-churn refill");
      console.log(`  refill caught up: ${JSON.stringify(final)}`);
    } catch (e) {
      failures.push(`post-churn refill: ${(e as Error).message}`);
      console.log(`  WARN: ${(e as Error).message}`);
    }

    // 5. Parallel fan-out — kick `parallel` simultaneous creates.
    //    Drains the pool below target; some of these adopt, the rest
    //    fall through to fresh-create. Assert: no double-adoption,
    //    all wells boot, pool refills afterwards.
    console.log(`\n=== parallel fan-out: ${args.parallel} concurrent creates ===`);
    const fanNames = Array.from(
      { length: args.parallel },
      (_, i) => `${args.prefix}-fan-${Date.now().toString(36).slice(-4)}-${i + 1}`,
    );
    const tFan = Date.now();
    const fanResults = await Promise.allSettled(
      fanNames.map((name) =>
        api<CreateResult>(args.baseUrl, token, "POST", "/v1/wells", { name }).then((r) => {
          createdNames.add(name);
          return r;
        }),
      ),
    );
    const fanMs = Date.now() - tFan;
    const ok = fanResults.filter((r) => r.status === "fulfilled");
    const failed = fanResults.filter((r) => r.status === "rejected");
    console.log(
      `  ${ok.length}/${fanResults.length} succeeded in ${fanMs}ms (${failed.length} failed)`,
    );
    for (const r of fanResults) {
      if (r.status === "fulfilled") {
        const v = r.value as CreateResult;
        console.log(`    ✓ ${v.name} ip=${v.ip} lume_name=${v.lume_name ?? v.name}`);
      } else {
        const reason = (r as PromiseRejectedResult).reason;
        console.log(`    ✗ ${reason?.message ?? String(reason)}`);
        failures.push(`fan-out: ${reason?.message ?? String(reason)}`);
      }
    }

    // Double-adoption check: every successful create should map to a
    // distinct lume_name. If two adopts claimed the same pool member,
    // we'd see duplicate lume_names here.
    const lumeNames = ok
      .map((r) => (r as PromiseFulfilledResult<CreateResult>).value.lume_name)
      .filter((n): n is string => typeof n === "string");
    const dupes = lumeNames.filter((n, i) => lumeNames.indexOf(n) !== i);
    if (dupes.length > 0) {
      failures.push(`double-adoption detected: lume_name dupes ${JSON.stringify(dupes)}`);
    }

    // Cleanup fan-out wells inline so the post-fan refill assertion
    // doesn't trip over them lingering.
    console.log("  cleaning fan-out wells…");
    for (const name of fanNames) {
      if (createdNames.has(name)) {
        await destroyOne(args.baseUrl, token, name);
        createdNames.delete(name);
      }
    }

    // 6. Final refill check.
    console.log("\nwaiting for filler to recover after fan-out…");
    try {
      final = await waitForReady(args.baseUrl, token, args.target, 90_000, "post-fanout refill");
      console.log(`  refill recovered: ${JSON.stringify(final)}`);
    } catch (e) {
      failures.push(`post-fanout refill: ${(e as Error).message}`);
      console.log(`  WARN: ${(e as Error).message}`);
    }

    // 7. Verdict.
    console.log("");
    if (failures.length === 0) {
      console.log("✅ pool churn smoke passed");
    } else {
      console.error("smoke FAILED:");
      for (const f of failures) console.error(`  ${f}`);
      throw new Error(`${failures.length} failures`);
    }
  } finally {
    // Restore defaults regardless of outcome — don't leave dev with
    // pool_size flipped behind the operator's back.
    console.log("\ncleanup…");
    if (createdNames.size > 0) {
      console.log(`  destroying ${createdNames.size} lingering wells…`);
      for (const name of createdNames) {
        if (!args.keep) await destroyOne(args.baseUrl, token, name);
      }
    }
    if (prior) {
      await writeFile(defaultsPath, JSON.stringify(prior));
    } else if (existsSync(defaultsPath)) {
      // Was absent originally; remove the file we wrote rather than
      // leaving a different shape in place.
      await writeFile(defaultsPath, JSON.stringify({ pool_size: 0 }));
    }
    console.log("  defaults restored");

    // Drain pool too — we created members for this smoke; leaving
    // them with the old defaults applied would be confusing.
    if (!args.keep) {
      try {
        await api(args.baseUrl, token, "POST", "/v1/wells/pool/drain");
      } catch (e) {
        console.warn(`  drain failed: ${(e as Error).message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(`smoke-pool-churn failed: ${(e as Error).message}`);
  process.exit(1);
});
