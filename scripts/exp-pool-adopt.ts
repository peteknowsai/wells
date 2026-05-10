#!/usr/bin/env bun
// One-shot driver: hatch a pool member, then adopt it. Measures the
// adoption phase end-to-end. Used to live-verify lib/adoptFromPool.ts
// (A.1.4.c) without the welld background fill loop yet.
//
// Usage:
//   WELL_STATE_DIR=$HOME/.wells-dev WELL_LUME_PORT=7780 \
//     bun run scripts/exp-pool-adopt.ts <adopted-name>

import { join } from "node:path";
import { homedir } from "node:os";
import { adoptFromPool } from "../lib/adoptFromPool.ts";
import { detectHostPubkey } from "../lib/createWell.ts";
import { fillPoolMember } from "../lib/poolFill.ts";
import { listPoolMembers } from "../lib/poolRegistry.ts";
import { listWells } from "../lib/registry.ts";

const stateDir = process.env.WELL_STATE_DIR ?? join(homedir(), ".wells");
const adoptedName = process.argv[2];
if (!adoptedName) {
  console.error("usage: exp-pool-adopt.ts <adopted-name>");
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`pool-adopt driver — state=${stateDir}`);

  const ready = (await listPoolMembers()).filter((m) => m.state === "ready");
  if (ready.length === 0) {
    console.log("no ready members; hatching one...");
    const t0 = Date.now();
    const m = await fillPoolMember({ hostPubkey: await detectHostPubkey() });
    console.log(`  hatched ${m.name} in ${Date.now() - t0}ms`);
  } else {
    console.log(`${ready.length} ready member(s) already present`);
  }

  console.log(`\nadopting as '${adoptedName}'...`);
  const t0 = Date.now();
  const result = await adoptFromPool({ name: adoptedName });
  const wallMs = Date.now() - t0;

  console.log(`\nADOPTION RESULT`);
  console.log(`  name=${result.name} ip=${result.ip}`);
  console.log(`  pool_member=${result.pool_member}`);
  console.log(`  adoption_ms=${result.adoption_ms}`);
  console.log(`  wall_ms=${wallMs}`);

  const wells = await listWells();
  console.log(`\nwells registered: ${wells.length}`);
  console.log(`pool members remaining: ${(await listPoolMembers()).length}`);
}

await main();
