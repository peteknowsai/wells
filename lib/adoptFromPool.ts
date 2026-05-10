// A.1.4.c — pool adoption.
//
// Pop a ready pool member, rename its bundle to the operator's chosen
// name, wake from the captured hibernate.bin, register as a regular
// well. Skips create's warming sequence entirely; target ≤2s.
//
// Identity reset is NOT done here (deferred to A.1.4.c.ii). The adopted
// well keeps the pool member's internal hostname (`pool-XXXXXXXX`),
// machine-id, and SSH host keys. That's invisible to cells callers as
// long as routing is by URL via WELL_PUBLIC_BASE; if cells team needs
// in-guest hostname to match the operator's name (for `well exec`
// prompts, etc), we add a hot-swap step in a follow-up.

import { rename as fsRename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveWellIp } from "./dhcp.ts";
import { wakeWell } from "./lifecycle.ts";
import { log } from "./log.ts";
import {
  removePoolMember,
  reserveReadyMember,
  type PoolMember,
} from "./poolRegistry.ts";
import { addWell, type WellAuth } from "./registry.ts";
import { captureRestoreRecipe } from "./restoreRecipe.ts";
import { PATHS } from "./state.ts";
import { validateWellName } from "./wellPolicy.ts";
import { writeRuntime } from "./wellRuntime.ts";

export interface AdoptFromPoolOptions {
  // The operator's chosen well name. Validated as a regular well name
  // (RFC1123-safe, not reserved, not pool-prefixed).
  name: string;
  // Defaults to "well" (require Bearer token on the public proxy).
  // Cells callers wanting public surface set "public".
  auth?: WellAuth;
}

export interface AdoptResult {
  name: string;
  uuid: string;
  ip: string;
  status: "running";
  pool_member: string;       // The pool name we adopted from (audit trail).
  adoption_ms: number;       // End-to-end timing for sub-2s gate.
}

export class PoolEmptyError extends Error {
  constructor() {
    super("pool empty: no ready members available for adoption");
    this.name = "PoolEmptyError";
  }
}

// Rename a lume bundle on disk. Lume keys bundles by directory name
// only; config.json doesn't carry the name. So `mv` is the canonical
// rename. Pool members are stopped (post-hibernate), so no live VM
// state needs migrating.
//
// Returns the new lume bundle dir for tests/diagnostics.
async function renameLumeBundle(
  oldName: string,
  newName: string,
): Promise<string> {
  const lumeRoot = join(homedir(), ".lume");
  const oldDir = join(lumeRoot, oldName);
  const newDir = join(lumeRoot, newName);
  await fsRename(oldDir, newDir);
  return newDir;
}

export async function adoptFromPool(
  opts: AdoptFromPoolOptions,
): Promise<AdoptResult> {
  validateWellName(opts.name);
  const t0 = Date.now();

  // Atomically reserve a ready member. State transitions to `adopting`
  // so a concurrent adopt request can't double-pop.
  const member = await reserveReadyMember();
  if (!member) {
    throw new PoolEmptyError();
  }
  log.info("adopt: reserved pool member", {
    name: opts.name, pool_member: member.name,
  });

  try {
    // 1. Move bundle dirs. Welld-side first (smaller, fewer FH races),
    //    then lume-side. Pool member is in `state=adopting` for the
    //    duration so the fill loop won't race on it.
    const oldWellDir = PATHS.poolMemberDir(member.name);
    const newWellDir = PATHS.vmDir(opts.name);
    await fsRename(oldWellDir, newWellDir);
    log.info("adopt: moved well bundle", { from: oldWellDir, to: newWellDir });

    await renameLumeBundle(member.name, opts.name);
    log.info("adopt: moved lume bundle", { from: member.name, to: opts.name });

    // 2. Capture restore recipe from the (now-renamed) lume config.
    //    This is the device shape recorded at hibernate-time for the
    //    pool member; renaming doesn't change it.
    const recipe = await captureRestoreRecipe(opts.name);

    // 3. Write runtime.json so wakeWell's recipe validation passes.
    //    Pool members are hatched in the disk-only steady state, so
    //    `hibernate_ready: true`, `steady_state_mount: null`.
    await writeRuntime(opts.name, {
      state: "hibernating",
      last_transition_at: new Date().toISOString(),
      last_error: null,
      hibernate_path: PATHS.vmHibernate(opts.name),
      restore_recipe: recipe,
      hibernate_ready: true,
      birth_media_detached_at: member.ready_at ?? null,
      steady_state_mount: null,
    });

    // 4. Add wells registry entry. Done BEFORE wake so a wake-side
    //    failure leaves a registry entry the operator can see + clean
    //    up via `well destroy`.
    await addWell({
      name: opts.name,
      uuid: member.uuid,
      created_at: new Date().toISOString(),
      cpu: member.cpu,
      memory: member.memory,
      disk_size: member.disk_size,
      auth: opts.auth ?? "well",
    });

    // 5. Wake. Existing wakeWell handles VZ kernel-state reset
    //    (killAndRestartLumeServe) + restore + state transition.
    await wakeWell(opts.name);

    // 6. Resolve the post-wake IP. The pool member's MAC is unchanged
    //    by the rename, and `dhcp-identifier: mac` (from B.0.9.d.5.b)
    //    means vmnet renews the same lease — IP should match what was
    //    in use when we hibernated.
    const ip = await resolveWellIp(opts.name);

    // 7. Remove pool entry only on full success — leaves an audit
    //    trail in the failure path.
    await removePoolMember(member.name);

    const adoptionMs = Date.now() - t0;
    log.info("adopt: ready", { name: opts.name, ip, adoption_ms: adoptionMs });
    return {
      name: opts.name,
      uuid: member.uuid,
      ip: ip ?? "",
      status: "running",
      pool_member: member.name,
      adoption_ms: adoptionMs,
    };
  } catch (e) {
    log.error("adopt failed", {
      name: opts.name,
      pool_member: member.name,
      err: (e as Error).message,
    });
    throw e;
  }
}

// Test helper: exposed so callers (and unit tests) can probe the pool
// without invoking the full adoption flow.
export type AdoptablePoolMember = Pick<
  PoolMember,
  "name" | "uuid" | "cpu" | "memory" | "disk_size" | "ready_at"
>;
