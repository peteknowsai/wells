#!/usr/bin/env bun
// One-shot driver to hatch a single pool member and report its state.
// Used for live-verification of lib/poolFill.ts (A.1.4.b) without
// building the welld background loop yet.
//
// Usage:
//   WELL_STATE_DIR=$HOME/.wells-dev WELL_LUME_PORT=7780 \
//     bun run scripts/exp-pool-fill.ts
//
// Prints timing + final pool registry state. Cleans up on failure.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fillPoolMember } from "../lib/poolFill.ts";
import { listPoolMembers } from "../lib/poolRegistry.ts";
import { detectHostPubkey } from "../lib/createWell.ts";

const stateDir = process.env.WELL_STATE_DIR ?? join(homedir(), ".wells");

async function main(): Promise<void> {
  console.log(`pool-fill driver — state=${stateDir}, lume=${process.env.WELL_LUME_PORT ?? 7777}`);

  const before = await listPoolMembers();
  console.log(`pool depth before: ${before.length} members (${before.filter((m) => m.state === "ready").length} ready)`);

  const hostPubkey = await detectHostPubkey();
  const t0 = Date.now();
  const member = await fillPoolMember({ hostPubkey });
  const dt = Date.now() - t0;

  console.log(`hatched ${member.name} in ${dt}ms`);
  console.log(`  state=${member.state} ready_at=${member.ready_at}`);
  console.log(`  hibernate.bin path=${join(stateDir, "pool", member.name, "hibernate.bin")}`);

  const after = await listPoolMembers();
  console.log(`pool depth after: ${after.length} members (${after.filter((m) => m.state === "ready").length} ready)`);
}

await main();
