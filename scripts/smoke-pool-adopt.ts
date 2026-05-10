#!/usr/bin/env bun
// A.1.4.e — pool adoption smoke.
//
// Pre-fill the pool with N=2 members (direct in-process via
// fillPoolMember), then drive 3 well-create requests through welld's
// HTTP API. The first 2 should adopt from the pool (sub-2s); the 3rd
// should fall through to fresh-create (≤30s). All against dev welld
// + dev state — never touches stable.
//
// Usage:
//   WELL_BASE_URL=http://127.0.0.1:7879 \
//     WELL_STATE_DIR=$HOME/.wells-dev \
//     WELL_LUME_PORT=7780 \
//     bun run scripts/smoke-pool-adopt.ts [--prefill=2] [--total=3] [--keep]
//
// Targets:
//   - Adopted wells (those with a ready pool member available): ≤2000ms
//   - Cold-fallback (pool empty): ≤30000ms (loose; the real cold-create
//     gate is in B.0.9.d.4.e's smoke-hibernate-wake.ts)

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { detectHostPubkey } from "../lib/createWell.ts";
import { fillPoolMember } from "../lib/poolFill.ts";
import { listPoolMembers } from "../lib/poolRegistry.ts";

interface Args {
  prefill: number;
  total: number;
  keep: boolean;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (k: string, def: string): string => {
    const m = argv.find((a) => a.startsWith(`--${k}=`));
    return m ? m.slice(k.length + 3) : def;
  };
  return {
    prefill: Number(flag("prefill", "2")),
    total: Number(flag("total", "3")),
    keep: argv.includes("--keep"),
    baseUrl: process.env.WELL_BASE_URL ?? "http://127.0.0.1:7879",
  };
}

async function readToken(baseUrl: string): Promise<string> {
  const stateDir = baseUrl.includes(":7879") ? ".wells-dev" : ".wells";
  const path = join(homedir(), stateDir, "token");
  return (await readFile(path, "utf-8")).trim();
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

interface CycleResult {
  name: string;
  ms: number;
  source: "pool" | "fresh";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = await readToken(args.baseUrl);
  const stateDir = process.env.WELL_STATE_DIR ?? join(homedir(), ".wells");
  console.log(`smoke-pool-adopt — base=${args.baseUrl} state=${stateDir} prefill=${args.prefill} total=${args.total}`);

  // 1. Pre-fill. Direct call instead of via API because:
  //    - The pool fill API (A.1.5) doesn't exist yet.
  //    - Pre-fill is setup, not the system-under-test; we only care
  //      about adoption timing.
  if (args.prefill > 0) {
    const hostPubkey = await detectHostPubkey();
    for (let i = 1; i <= args.prefill; i++) {
      const t0 = Date.now();
      console.log(`pre-fill ${i}/${args.prefill}: hatching...`);
      const m = await fillPoolMember({ hostPubkey });
      console.log(`  hatched ${m.name} in ${Date.now() - t0}ms`);
    }
  }
  const readyBefore = (await listPoolMembers()).filter((m) => m.state === "ready").length;
  console.log(`pool ready depth before adoption: ${readyBefore}`);

  // 2. Drive `total` creates through welld's API. Each call hits
  //    createWell → adoptFromPool first (eligible: no env injection),
  //    falls through to fresh-create when the pool drains.
  const created: CycleResult[] = [];
  for (let i = 1; i <= args.total; i++) {
    const name = `pool-smoke-${Date.now().toString(36)}-${i}`;
    const t0 = Date.now();
    console.log(`\ncreate ${i}/${args.total}: name=${name}`);
    await api(args.baseUrl, token, "POST", "/v1/wells", { name });
    const ms = Date.now() - t0;
    // Heuristic for source: <5s = pool, >=5s = fresh. Real signal
    // would be a structured field on the response, but the API
    // doesn't currently expose pool_member. Time-based suffices for
    // smoke gating (huge gap between sub-2s adoption and 16-31s cold).
    const source: "pool" | "fresh" = ms < 5_000 ? "pool" : "fresh";
    created.push({ name, ms, source });
    console.log(`  ${name}: ${ms}ms (${source})`);
  }

  // 3. Cleanup unless --keep. Destroying pool-served wells frees the
  //    bundle dirs so the next run starts clean.
  if (!args.keep) {
    console.log(`\ncleanup: destroying ${created.length} wells`);
    for (const c of created) {
      try {
        await api(args.baseUrl, token, "DELETE", `/v1/wells/${c.name}`);
        console.log(`  ${c.name}: destroyed`);
      } catch (e) {
        console.error(`  ${c.name}: destroy failed: ${(e as Error).message}`);
      }
    }
  }

  // 4. Assertions. Fail loudly so CI / fire-loop wrappers can see.
  let failed = false;
  console.log(`\nresults:`);
  for (let i = 0; i < created.length; i++) {
    const c = created[i]!;
    const expectedSource = i < readyBefore ? "pool" : "fresh";
    const target = expectedSource === "pool" ? 2_000 : 30_000;
    const ok = c.source === expectedSource && c.ms <= target;
    if (!ok) failed = true;
    console.log(
      `  [${ok ? "OK" : "FAIL"}] cycle ${i + 1}: ${c.name} ${c.ms}ms ` +
      `(source=${c.source}, expected=${expectedSource}, target≤${target}ms)`,
    );
  }

  if (failed) {
    console.error(`\nSMOKE FAILED`);
    process.exit(1);
  }
  console.log(`\nSMOKE PASSED`);
}

await main();
