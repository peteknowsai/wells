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

import { symlink } from "node:fs/promises";

import { readLumeMac } from "./createWell.ts";
import { resolveWellIp } from "./dhcp.ts";
import { resetWellIdentity } from "./identityReset.ts";
import { wakeWell } from "./lifecycle.ts";
import { log } from "./log.ts";
import { triggerFillIfNeeded } from "./poolFiller.ts";
import {
  removePoolMember,
  reserveReadyMember,
  type PoolMember,
  type PoolMemberCriteria,
} from "./poolRegistry.ts";
import { addWell, type R2Config, type WellAuth } from "./registry.ts";
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
  // Optional shape gate. If present, the pool member's source image +
  // sizing must all match or PoolEmptyError is thrown. createWell uses
  // this so a non-default sizing/image request doesn't silently get
  // a pool member baked for the default profile.
  criteria?: PoolMemberCriteria;
  // R2 / S3 credentials to record on the well's registry entry. Pool
  // members don't carry R2 — it's pure registry metadata, applied at
  // adoption time so cells can mint per-well scoped keys.
  r2?: R2Config;
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

export async function adoptFromPool(
  opts: AdoptFromPoolOptions,
): Promise<AdoptResult> {
  validateWellName(opts.name);
  const t0 = Date.now();

  // Atomically reserve a ready member matching the caller's shape
  // gate (sizing + source image). State transitions to `adopting`
  // so a concurrent adopt request can't double-pop. PoolEmptyError
  // covers both empty pool AND no-matching-member — caller treats
  // both as "fall through to fresh-create".
  const member = await reserveReadyMember(opts.criteria);
  if (!member) {
    throw new PoolEmptyError();
  }
  log.info("adopt: reserved pool member", {
    name: opts.name, pool_member: member.name,
  });

  try {
    // 1. Symlink the welld bundle dir into the operator-named slot.
    //    DON'T move the files — VZ's `saveMachineStateTo` records the
    //    absolute path of `hibernate.bin` in some internal cookie,
    //    and `restoreMachineStateFrom` rejects with "permission
    //    denied" if the file shows up at a different absolute path.
    //    The lume bundle (`~/.lume/<member.name>/`) likewise can't
    //    move because nvram.bin + disk.img absolute paths are encoded
    //    in the saved state's VZVirtualMachineConfiguration. So both
    //    bundles stay put; we just add a symlink so code that reads
    //    via PATHS.vmDir(opts.name) can follow it. The lume_name on
    //    the registry record routes lume API calls to pool-XXXX.
    //    See docs/findings-pool-adopt-bundle-rename.md.
    const realWellDir = PATHS.poolMemberDir(member.name);
    const linkPath = PATHS.vmDir(opts.name);
    await symlink(realWellDir, linkPath, "dir");
    log.info("adopt: symlinked well dir", { link: linkPath, target: realWellDir });

    // 2. Capture restore recipe from the LUME bundle (member.name).
    //    The recipe records device shape (cpu, memory, mac, etc.) —
    //    stable across symlink.
    const recipe = await captureRestoreRecipe(member.name);

    // 3. Write runtime.json. Reads via PATHS.vmRuntime → vms/op-name/
    //    runtime.json → symlink → pool/member.name/runtime.json.
    //    `hibernate_path` records the LITERAL pool path (where lume
    //    actually wrote the file at saveState time) so wakeWell hands
    //    that exact string to lume.restoreState. PATHS.vmHibernate
    //    via the symlink would produce ~/.wells-dev/vms/<op-name>/
    //    hibernate.bin — same bytes, different path string, and VZ
    //    refuses (proven by live test on 2026-05-09).
    await writeRuntime(opts.name, {
      state: "hibernating",
      last_transition_at: new Date().toISOString(),
      last_error: null,
      hibernate_path: PATHS.poolMemberHibernate(member.name),
      restore_recipe: recipe,
      hibernate_ready: true,
      birth_media_detached_at: member.ready_at ?? null,
      steady_state_mount: null,
      // Hibernated — no active lease. Wake will stamp ip after DHCP.
      ip: null,
      // W.74: pool member's warming-restart XPC child was killed at
      // pool-fill time. wakeWell (called below at step 5) spawns a
      // fresh XPC and stamps the new PID here.
      xpc_child_pid: null,
    });

    // 4. Add wells registry entry. Done BEFORE wake so a wake-side
    //    failure leaves a registry entry the operator can see + clean
    //    up via `well destroy`. `lume_name` carries the pool-XXXX
    //    identity that all subsequent lume calls must use.
    //    `mac_address` from the lume bundle's config.json so
    //    resolveWellIp can find the lease via MAC — adopted wells
    //    keep the pool member's in-guest hostname (pool-XXXX) until
    //    A.1.4.c.ii's identity reset, so hostname-based DHCP lookup
    //    against the operator name returns null. MAC bypasses that.
    const mac = await readLumeMac(member.name);
    await addWell({
      name: opts.name,
      uuid: member.uuid,
      created_at: new Date().toISOString(),
      cpu: member.cpu,
      memory: member.memory,
      disk_size: member.disk_size,
      auth: opts.auth ?? "well",
      lume_name: member.name,
      ...(mac ? { mac_address: mac } : {}),
      // W.72: propagate the pool member's static IP allocation to the
      // adopted well so resolveWellIp returns the same address before
      // and after adoption.
      ...(member.pinned_ip ? { pinned_ip: member.pinned_ip } : {}),
      ...(opts.r2 ? { r2: opts.r2 } : {}),
    });

    // 5. Wake. wakeWell calls lume.restoreState directly — VZ kernel
    //    state was already released at pool-fill time (W.74: per-VM
    //    SIGKILL of the warming-restart VirtualMachine.xpc child
    //    happens right after saveState in poolFill, so the pool's
    //    hibernate.bin is restorable without sibling collateral).
    //    wakeWell captures the new XPC child PID into runtime.json
    //    for the next hibernate cycle.
    await wakeWell(opts.name);

    // 6. Resolve the post-wake IP. The pool member's MAC is unchanged
    //    by the rename, and `dhcp-identifier: mac` (from B.0.9.d.5.b)
    //    means vmnet renews the same lease — IP should match what was
    //    in use when we hibernated.
    const ip = await resolveWellIp(opts.name);

    // 7. A.1.4.c.ii — in-guest identity reset. Pool member's hostname,
    //    machine-id, and SSH host keys all carry the pool-XXXX values
    //    after wake. Hot-swap them to the operator's name. Sync (in
    //    the adoption critical path) because cells team's UX expects
    //    the well to be coherent immediately on return; async would
    //    require state tracking + race-handling that's not worth the
    //    sub-second savings.
    if (ip) {
      const reset = await resetWellIdentity({
        name: opts.name,
        ip,
        sshKeyPath: PATHS.vmSshKey(opts.name),
      });
      log.info("adopt: identity reset", { name: opts.name, ms: reset.ms });
    } else {
      log.warn("adopt: skipping identity reset — no IP resolved", {
        name: opts.name,
      });
    }

    // 8. Remove pool entry only on full success — leaves an audit
    //    trail in the failure path.
    await removePoolMember(member.name);

    // 9. Kick the background filler so the next adoption isn't a
    //    cache miss. Fire-and-forget — adoption latency is unaffected.
    triggerFillIfNeeded();

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
