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
import { releaseLeaseBestEffort } from "./dhcpHelper.ts";
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
import {
  DEFAULT_CIDR_PREFIX,
  DEFAULT_GATEWAY,
  nextStaticIp,
} from "./ipPool.ts";
import { resolveImageName } from "./imageStore.ts";

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
  const baseDisk = imageDiskPath(await resolveImageName(fromImage));
  const lume = new LumeClient();

  // W.72: pool members participate in the static IP pool when the
  // operator enabled it. Each member gets a unique pinned IP that
  // adoption propagates to the resulting well's registry record. The
  // serial gate in poolFiller.ts means no two fills allocate at once,
  // so the in-process mutex is for defense-in-depth.
  let pinnedIp: string | null = null;
  if (defaults.static_ip_range != null) {
    pinnedIp = await nextStaticIp();
    if (!pinnedIp) {
      throw new Error(
        `pool fill: static IP range exhausted (${defaults.static_ip_range})`,
      );
    }
    log.info("pool: allocated static IP", { name, ip: pinnedIp });
  }

  const member: PoolMember = {
    name,
    uuid: randomUUID(),
    created_at: new Date().toISOString(),
    source_image: fromImage,
    cpu,
    memory,
    disk_size: diskSize,
    state: "provisioning",
    ...(pinnedIp ? { pinned_ip: pinnedIp } : {}),
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
        ...(pinnedIp
          ? {
              staticIp: {
                ip: pinnedIp,
                cidrPrefix: DEFAULT_CIDR_PREFIX,
                gateway: DEFAULT_GATEWAY,
              },
            }
          : {}),
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

    // W.72: static-IP pool members skip the DHCP delta lookup — netplan
    // swap inside the guest lands the well at its pinned address.
    let ip: string;
    if (pinnedIp) {
      ip = pinnedIp;
      await waitForSshReady(ip, join(memberDir, "ssh_key"), 5 * 60_000);
      log.info("pool: ssh ready (static IP, first boot)", { ip });
    } else {
      ip = await waitForDhcpLease(name, 90_000, lume, beforeLeases);
      log.info("pool: DHCP lease", { ip });
      await waitForSshReady(ip, join(memberDir, "ssh_key"), 5 * 60_000);
      log.info("pool: ssh ready (first boot)", { ip });
    }

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
    // W.72: same static-IP shortcut as the first boot. The netplan
    // persisted to /etc/netplan/01-well.yaml during firstboot, so the
    // second boot starts directly on the pinned IP with no DHCP.
    let warmIp: string;
    if (pinnedIp) {
      warmIp = pinnedIp;
      await waitForSshReady(warmIp, join(memberDir, "ssh_key"), 60_000);
      log.info("pool: warmed (disk-only steady state, static IP)", {
        ip: warmIp,
      });
    } else {
      warmIp = await waitForDhcpLease(name, 90_000, lume, beforeWarm);
      await waitForSshReady(warmIp, join(memberDir, "ssh_key"), 60_000);
      log.info("pool: warmed (disk-only steady state)", { ip: warmIp });
    }

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
    // W.71: dump diagnostic state BEFORE cleanup destroys evidence.
    // Cells team 2026-05-11 09:19Z flagged intermittent pool-fill DHCP
    // timeouts as "cause unknown" — this gives whoever owns pool (us
    // pre-slice-2, cells post-slice-2) the data to diagnose without
    // re-reproducing the failure.
    await dumpPoolFillFailure({
      name,
      bundleDisk,
      lume,
      err: e as Error,
    }).catch((err) =>
      log.warn("pool-fill diagnostic dump failed", {
        err: (err as Error).message,
      }),
    );
    // Best-effort cleanup. Don't throw from cleanup — surface the
    // original error. Cells team 2026-05-11 07:45Z: pool refill leaks
    // DHCP leases when fill fails mid-bake; lume.delete cleans the
    // bundle but the lease entry in /var/db/dhcpd_leases survives.
    // Release explicitly via the helper to keep the lease pool clean.
    log.error("pool fill failed; cleaning up", {
      name,
      err: (e as Error).message,
    });
    await lume.stop(name).catch(() => {});
    await lume.delete(name).catch(() => {});
    await releaseLeaseBestEffort(name);
    await removePoolMember(name).catch(() => {});
    throw e;
  }
}

interface DumpFailureArgs {
  name: string;
  bundleDisk: string;
  lume: LumeClient;
  err: Error;
}

// W.71 — pool-fill failure diagnostic dump. Emits a single structured
// log block under `event: "pool-fill-timeout"` (regardless of whether
// the actual failure was a DHCP timeout) with enough context to
// diagnose intermittent failures post-hoc. All probes are best-effort
// + tolerate failure; we don't want a broken diagnostic to mask the
// original error.
async function dumpPoolFillFailure(args: DumpFailureArgs): Promise<void> {
  const { name, bundleDisk, lume, err } = args;

  // 1) lume's view of the well at the moment of failure
  const lumeInfo = await lume.info(name).catch((e) => ({
    error: (e as Error).message,
  }));

  // 2) Bundle MAC — confirms whether the bundle's config.json is
  //    parseable, lets cross-reference with leases by MAC.
  const mac = await readLumeMac(name).catch(() => null);

  // 3) Current lease snapshot, filtered to recent entries that might
  //    be ours (last 100 leases is enough — typical /var/db/dhcpd_leases
  //    on a healthy host is <50). Surfacing the FULL recent state
  //    lets cells team diff against a pre-failure snapshot if they
  //    have one.
  const leases = await dumpDhcpLeases()
    .then((all) => all.slice(0, 20))
    .catch(() => [] as Array<unknown>);

  // 4) lsof on the bundle disk — confirms whether VZ is still holding
  //    it (VM alive at the moment of failure, despite lume's view) vs
  //    released (VM truly dead). Critical for distinguishing
  //    "bundle never booted" from "booted but no network."
  const lsof = await probeBundleHold(bundleDisk).catch(() => ({
    error: "lsof probe failed",
  }));

  log.warn("pool-fill-timeout: diagnostic", {
    event: "pool-fill-timeout",
    name,
    bundle_disk: bundleDisk,
    error: err.message,
    lume_info: lumeInfo,
    bundle_mac: mac,
    lease_snapshot: leases,
    bundle_lsof: lsof,
  });
}

async function probeBundleHold(
  bundleDisk: string,
): Promise<{ held_by: string[] } | { error: string }> {
  const proc = spawn(["/usr/sbin/lsof", "-Fpn", bundleDisk], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  // lsof exits 1 when no holders — empty output, not an error.
  if (code !== 0 && code !== 1) return { error: `lsof exit ${code}` };
  // -Fpn emits one field per line, `p<pid>` and `n<name>` pairs.
  // We just want the pids holding it.
  const pids = out
    .split("\n")
    .filter((l) => l.startsWith("p"))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
  return { held_by: pids };
}
