// A.1.4.b — pool fill.
//
// Hatches one pre-warmed pool member end-to-end:
//   clone base disk → boot with cidata (generic identity) → wait for
//   /etc/.well-ready → sysrq halt → restart without mount → wait for
//   ssh → hibernate → mark ready in pool registry.
//
// On adoption (A.1.4.c, separate fire), the well will be renamed,
// /etc/.well-ready will be reset, cidata will be swapped for the
// operator's identity, and the well will wake from this hibernate.bin
// — putting it back through well-firstboot with the new identity.
//
// This function is the foundational primitive. The background fill
// loop (welld-side, also separate fire) calls this whenever pool depth
// drops below the configured `pool_size`.
//
// Bundle layout for a pool member mirrors a regular well's bundle but
// lives at PATHS.poolMemberDir(name) instead of PATHS.vmDir(name) and
// is tracked in the pool registry instead of the wells registry.

import { spawn } from "bun";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_BASE_IMAGE,
  waitForDhcpLease,
  waitForSshReady,
} from "./createWell.ts";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { clonefile } from "./clonefile.ts";
import { dumpDhcpLeases } from "./dhcp.ts";
import { waitForDiskReleased } from "./diskReleased.ts";
import { loadDefaults } from "./defaults.ts";
import {
  CURRENT_IMAGE_CONTRACT_VERSION,
  imageDiskPath,
  imageExists,
  imageMeta,
} from "./imageStore.ts";
import { log } from "./log.ts";
import {
  addPoolMember,
  generatePoolMemberName,
  removePoolMember,
  setPoolMemberState,
  type PoolMember,
} from "./poolRegistry.ts";
import { ensureSshKey } from "./sshKey.ts";
import { PATHS } from "./state.ts";
import { normalizeSize, sizeToTruncateArg } from "./wellPolicy.ts";
import { buildWellSeed } from "./wellSeed.ts";

export interface FillPoolOptions {
  // Source image to clone for this member. Defaults to ubuntu-25.10-base
  // (matches createWell's default so adoption is a transparent swap).
  sourceImage?: string;
  // Optional sizing override; defaults pulled from defaults.json.
  cpu?: number;
  memory?: string;
  disk?: string;
  // SSH pubkey to authorize on the pool member's `ubuntu` user. The host
  // pubkey makes the member adopt-time accessible to welld for the
  // identity-reset SSH session (rm /etc/.well-ready, swap cidata, etc).
  // Caller passes welld's host pubkey here.
  hostPubkey: string;
}

// Hatch one pool member end-to-end. Throws on any failure; caller's job
// to retry or surface the error. The pool registry entry is removed on
// failure (best-effort cleanup of bundle dirs is also attempted).
export async function fillPoolMember(
  opts: FillPoolOptions,
): Promise<PoolMember> {
  const defaults = await loadDefaults();
  const cpu = opts.cpu ?? defaults.cpu;
  const memory = normalizeSize(opts.memory ?? defaults.memory);
  const diskSize = normalizeSize(opts.disk ?? defaults.disk);
  const fromImage = opts.sourceImage ?? DEFAULT_BASE_IMAGE;

  if (!(await imageExists(fromImage))) {
    throw new Error(
      `pool fill: image '${fromImage}' not found in ${PATHS.images()}`,
    );
  }
  const meta = await imageMeta(fromImage);
  const v = meta?.image_contract_version;
  if (v === undefined || v < CURRENT_IMAGE_CONTRACT_VERSION) {
    throw new Error(
      `pool fill: image '${fromImage}' has incompatible contract (image_contract_version=${
        v ?? "missing"
      }, expected ${CURRENT_IMAGE_CONTRACT_VERSION}) — re-bake from ${DEFAULT_BASE_IMAGE}.`,
    );
  }

  const name = generatePoolMemberName();
  const baseDisk = imageDiskPath(fromImage);
  const lume = new LumeClient();
  const member: PoolMember = {
    name,
    uuid: randomUUID(),
    created_at: new Date().toISOString(),
    source_image: fromImage,
    cpu,
    memory,
    disk_size: diskSize,
    state: "provisioning",
  };
  await addPoolMember(member);

  try {
    const memberDir = PATHS.poolMemberDir(name);
    await mkdir(memberDir, { recursive: true, mode: 0o700 });
    log.info("pool: memberDir ready", { dir: memberDir });

    // Per-member SSH key. We don't include the per-member key in the
    // pool member's authorized_keys (only the host pubkey goes there)
    // because adoption rebuilds cidata for the operator's identity and
    // injects fresh keys at that point. The per-member key here is just
    // the bookkeeping artifact so warm-time SSH probes have a key to
    // present.
    const memberPubkey = await ensureSshKey(
      join(memberDir, "ssh_key"),
      `pool@${name}`,
    );

    // Build pool-shaped seed disk. Hostname matches the pool member's
    // name so well-firstboot can apply per-member identity (host SSH
    // keys, machine-id) to a stable hostname across the warming cycle.
    // Adoption later overwrites this seed with operator identity.
    const cidataPath = join(memberDir, "cidata.iso");
    await buildWellSeed(
      {
        hostname: name,
        authorizedKeys: [opts.hostPubkey, memberPubkey],
      },
      cidataPath,
    );
    log.info("pool: seed built", { path: cidataPath });

    log.info("pool: lume create bundle", {
      name, cpu, memory, diskSize,
    });
    await lume.create({
      name, os: "linux", cpu, memory, diskSize, display: "1024x768",
    });
    await lume.waitForStatus(name, "stopped", { timeoutMs: 60_000 });

    const bundleDisk = bundleDiskPath(name);
    await mkdir(dirname(bundleDisk), { recursive: true });
    log.info("pool: clonefile base → bundle", {
      from: baseDisk, to: bundleDisk,
    });
    await clonefile(baseDisk, bundleDisk);

    // Truncate to requested size (clonefile preserves the source's
    // logical size, which is the base image's; truncate sets the
    // virtual disk size the guest sees).
    await spawn(
      ["truncate", "-s", sizeToTruncateArg(diskSize), bundleDisk],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    ).exited;

    // First boot — with cidata. Snapshot leases so waitForDhcpLease
    // can identify our lease via delta + filter out any stale entries.
    const beforeLeases = await dumpDhcpLeases();
    log.info("pool: lume.start (with cidata)", { name });
    await lume.start(name, { noDisplay: true, mount: cidataPath });
    await lume.waitForStatus(name, "running", {
      timeoutMs: 60_000, intervalMs: 1000,
    });

    const ip = await waitForDhcpLease(name, 90_000, lume, beforeLeases);
    log.info("pool: DHCP lease", { ip });
    await waitForSshReady(ip, join(memberDir, "ssh_key"), 5 * 60_000);
    log.info("pool: ssh ready (first boot)", { ip });

    await setPoolMemberState(name, "warming");

    // Sysrq fast halt (matches createWell's warming sequence). The
    // guest's well-firstboot has by now persisted hostname / SSH host
    // keys / machine-id / swap; sync flushes, sysrq triggers an
    // immediate kernel-level poweroff bypassing systemd's
    // poweroff.target.
    log.info("pool: warming — fast guest halt", { name });
    const haltProc = spawn(
      [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=4",
        "-o", "LogLevel=ERROR",
        "-o", "BatchMode=yes",
        "-i", join(memberDir, "ssh_key"),
        `ubuntu@${ip}`,
        // W.7 — staged sync + sysrq-s + sysrq-o (see createWell.ts
        // for the rationale: pre-flushing the guest before sysrq-o
        // gives Apple's VZ less dirty data to flush post-halt,
        // shrinking the diskReleased wait surfaced by W.6).
        "sudo sync && echo s | sudo tee /proc/sysrq-trigger >/dev/null && echo o | sudo tee /proc/sysrq-trigger >/dev/null",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    await haltProc.exited;
    await waitForDiskReleased(bundleDisk, 60_000);

    // Warming-restart — disk-only, no cidata. This is the steady-state
    // VM shape that hibernate's restoreMachineStateFrom requires.
    const beforeWarm = await dumpDhcpLeases();
    log.info("pool: warming — restart without mount", { name });
    await lume.start(name, { noDisplay: true });
    await lume.waitForStatus(name, "running", {
      timeoutMs: 60_000, intervalMs: 500,
    });
    const warmIp = await waitForDhcpLease(name, 90_000, lume, beforeWarm);
    await waitForSshReady(warmIp, join(memberDir, "ssh_key"), 60_000);
    log.info("pool: warmed (disk-only steady state)", { ip: warmIp });

    // Hibernate — saves VM RAM/CPU/device state to hibernate.bin.
    // Adoption (A.1.4.c) wakes from this file. Per Apple's restore
    // contract, the saved-state file is bundle-pinned; pool members
    // can't share a hibernate.bin (verified in B.0.11.g portability
    // probe).
    const hibernatePath = PATHS.poolMemberHibernate(name);
    log.info("pool: hibernate", { path: hibernatePath });
    await lume.saveState(name, hibernatePath);
    log.info("pool: ready", { name });

    const ready = await setPoolMemberState(
      name,
      "ready",
      new Date().toISOString(),
    );
    if (!ready) {
      throw new Error(
        `pool fill: registry entry for '${name}' disappeared mid-fill`,
      );
    }
    return ready;
  } catch (e) {
    // Best-effort cleanup. Don't throw from cleanup — surface the
    // original error.
    log.error("pool fill failed; cleaning up", {
      name,
      err: (e as Error).message,
    });
    await lume.stop(name).catch(() => {});
    await lume.delete(name).catch(() => {});
    await removePoolMember(name).catch(() => {});
    throw e;
  }
}
