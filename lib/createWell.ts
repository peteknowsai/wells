// Well create orchestration. Composes engine + state + cloud-init into a
// single end-to-end flow:
//
//   validate name → ensure dirs → per-well ssh key → compose user-data →
//   build cidata.iso → lume.create bundle → clonefile base disk into bundle
//   → truncate to requested size → boot via lume.start API with mount=cidata
//   → wait for DHCP lease → wait for ssh ready → register.
//
// We boot via the HTTP API (POST /lume/vms/:name/run with mount field) rather
// than spawning `lume run` as a subprocess — the latter doesn't put the VM in
// lume serve's SharedVM cache, which breaks pause/resume. Requires the lume
// patch in vendor/lume.patches/swift/0001-add-mount-to-RunVMRequest.
//
// Mirrors scripts/bake-base-image.ts's pattern; the bake is "make the base",
// this is "instantiate the base into a well". Keep them aligned.

import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { randomUUID } from "node:crypto";

import { log } from "./log.ts";
import { ensureSshKey } from "./sshKey.ts";
import { buildWellSeed } from "./wellSeed.ts";
import { clonefile } from "./clonefile.ts";
import {
  dumpDhcpLeases,
  findNewLeases,
  readDhcpLeaseByMac,
  readDhcpLeaseEntry,
  type LeaseEntry,
  type LeaseSnapshot,
} from "./dhcp.ts";
import { PATHS, ensureStateDirs, ensureVmDir } from "./state.ts";
import { addWell, type R2Config, type WellRecord } from "./registry.ts";
import { loadDefaults } from "./defaults.ts";
import {
  normalizeSize,
  sizeToTruncateArg,
  validateWellName,
} from "./wellPolicy.ts";
import { LumeClient } from "../engine/lume.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import {
  CURRENT_IMAGE_CONTRACT_VERSION,
  imageDiskPath,
  imageExists,
  imageMeta,
} from "./imageStore.ts";
import { defaultRuntime, writeRuntime } from "./wellRuntime.ts";

const RELEASE = "25.10";
// Exported for the pool-fill path so its default image matches createWell's.
export const DEFAULT_BASE_IMAGE = `ubuntu-${RELEASE}-base`;

export interface CreateOptions {
  name: string;
  cpu?: number;
  memory?: string;
  disk?: string;
  // Public key the host will use to ssh into the well. Defaults to
  // ~/.ssh/id_ed25519.pub if present, else id_rsa.pub.
  hostPubkey?: string;
  r2?: R2Config;
  // Env vars baked into /etc/environment via cloud-init. Use for
  // things like CELLS_PROXY_SECRET that need to be present from
  // first boot — saves a post-birth round-trip.
  env?: Record<string, string>;
  // Image name to clone from. Defaults to the prebuilt
  // ubuntu-<release>-base. Set to skip the cloud-init boot for fresh
  // wells when you already have a saved image with the agent layout.
  fromImage?: string;
}

export interface CreateResult {
  record: WellRecord;
  ip: string;
}

// Exported for the pool-fill driver script + callers that don't have a
// pubkey already in hand. Reads ~/.ssh/id_ed25519.pub or id_rsa.pub.
export async function detectHostPubkey(): Promise<string> {
  const candidates = [
    join(homedir(), ".ssh", "id_ed25519.pub"),
    join(homedir(), ".ssh", "id_rsa.pub"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return (await Bun.file(p).text()).trim();
  }
  throw new Error(
    "no ssh public key found at ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub — `ssh-keygen -t ed25519` first",
  );
}


// Read the MAC address from lume's bundle config.json. Returned in
// lowercase normalized form. Best-effort — returns null if the file
// is missing or unparseable.
async function readLumeMac(name: string): Promise<string | null> {
  const path = join(homedir(), ".lume", name, "config.json");
  if (!existsSync(path)) return null;
  try {
    const text = await Bun.file(path).text();
    const cfg = JSON.parse(text) as { macAddress?: string };
    if (typeof cfg.macAddress !== "string") return null;
    return cfg.macAddress.toLowerCase();
  } catch {
    return null;
  }
}

// True if this lease entry was NOT in the pre-boot snapshot — i.e., it
// arrived after we started this VM. When `beforeSnapshot` is undefined,
// every entry is treated as fresh (no filter applied). Comparison key
// is (ip, lease epoch); vmnet rewrites the lease epoch on every grant
// or renewal, so two entries with identical (ip, lease) really are the
// same write.
//
// Pure helper; exported for unit tests to pin the stale-name-reuse
// guarantee without needing a live vmnet bridge.
export function isFreshLease(
  entry: { ip: string; lease: number },
  beforeSnapshot?: LeaseSnapshot[],
): boolean {
  if (!beforeSnapshot) return true;
  return !beforeSnapshot.some(
    (s) => s.ip === entry.ip && s.lease === entry.lease,
  );
}

// Exported so the pool-fill path (lib/poolFill.ts) can reuse the same
// MAC-aware, snapshot-filtered DHCP wait without duplicating the
// substrate-most-first lookup logic. Same contract as the inline
// usage below: returns the well's IP, throws with a self-explaining
// "no DHCP lease" diagnostic on timeout.
export async function waitForDhcpLease(
  hostname: string,
  timeoutMs: number,
  lume?: LumeClient,
  beforeSnapshot?: LeaseSnapshot[],
): Promise<string> {
  // Lookup priority (substrate-most first):
  //   1. delta-snapshot — any lease that didn't exist before
  //      lume.start IS this VM's lease, regardless of hostname or
  //      DUID/client-id format. Doesn't race with cloud-init.
  //   2. MAC match — works once a renewal lands with 01,<mac>
  //      identity (latent until base images are re-baked with
  //      DUID=link-layer or ClientIdentifier=mac in networkd.conf).
  //   3. hostname match — fallback for cases without a snapshot
  //      and without MAC, e.g. a re-attempt after welld restart.
  //
  // ALL three paths are filtered against `beforeSnapshot` when one is
  // provided. Without that filter, name-reuse produces a stale-lease
  // bug: vmnet's `/var/db/dhcpd_leases` keeps old entries indefinitely;
  // re-creating a well that previously existed under the same name would
  // return the prior IP in <20ms (file read), then welld would sit ssh-
  // poking a dead address while the real DHCP lease arrived 4-6s later.
  // Cells team's smoke-7 hit this 2026-05-09 22:50:05 (logged
  // "DHCP lease 192.168.64.134" 15ms after lume.start; real VM was at
  // .136). Fix: any candidate from MAC or hostname match must not
  // already be in the pre-start snapshot.
  // See cells punchlist 2026-05-08 + B.0.8 commit history.
  const mac = await readLumeMac(hostname);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (beforeSnapshot) {
      const after = await dumpDhcpLeases();
      const fresh = findNewLeases(beforeSnapshot, after);
      if (fresh.length > 0) {
        // Highest lease epoch wins — robust to concurrent creates.
        fresh.sort((a, b) => b.lease - a.lease);
        const ip = fresh[0]!.ip;
        if (ip) return ip;
      }
    }
    if (mac) {
      const byMac = await readDhcpLeaseByMac(mac);
      if (byMac && isFreshLease(byMac, beforeSnapshot)) return byMac.ip;
    }
    const entry = await readDhcpLeaseEntry(hostname);
    if (entry && isFreshLease(entry, beforeSnapshot)) return entry.ip;
    await Bun.sleep(2000);
  }
  // On timeout, dump:
  //   1. lume.info — was the VM actually running? distinguishes
  //      "guest never booted" from "guest booted but no DHCP".
  //   2. recent leases — top 5. tells us whether ANY guest got
  //      a lease (so we know vmnet's bootpd is responding) and
  //      whether one came up under a different hostname.
  // Cells team punchlist 2026-05-08: "no DHCP lease" must be self-
  // explaining. The two pieces above answer most triage questions
  // without anyone shelling in.
  const snapshot = await dumpDhcpLeases();
  const recent = snapshot.slice(0, 5).map((e) =>
    `name=${e.name ?? "(none)"} ip=${e.ip ?? "(none)"} lease=${e.lease}`,
  );
  const leaseSummary = recent.length > 0
    ? `recent leases: ${recent.join("; ")}`
    : "leases file empty or unreadable";

  let lumeSummary = "lume.info not queried";
  if (lume) {
    try {
      const info = await lume.info(hostname);
      lumeSummary = info
        ? `lume.info: status=${info.status} ip=${info.ipAddress ?? "(none)"}`
        : "lume.info: VM not in lume registry (?!)";
    } catch (e) {
      lumeSummary = `lume.info failed: ${(e as Error).message}`;
    }
  }

  throw new Error(
    `no DHCP lease for hostname '${hostname}' within ${timeoutMs}ms — ${lumeSummary}; ${leaseSummary}`,
  );
}

import { waitForDiskReleased } from "./diskReleased.ts";

// Exported so the pool-fill path can reuse it. Same contract: polls
// the guest until `/etc/.well-ready` exists + SSH accepts the per-well
// key; throws on timeout.
export async function waitForSshReady(
  ip: string,
  keyPath: string,
  timeoutMs: number,
): Promise<void> {
  // Local vmnet bridge: connection establishes in <100ms when sshd is up.
  // ConnectTimeout=2 (was 4) catches sshd-not-yet-listening quickly so we
  // can retry. Retry interval 1s (was 3s) — a fast sshd-coming-up window
  // is ~1-2s on Apple Silicon, faster than the prior poll could see.
  // Saves ~2s per failed-first-attempt cycle. Cells team's repeated
  // 15s-target trips on warming-restart's ssh probe were partly here.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = spawn(
      [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=2",
        "-o", "LogLevel=ERROR",
        "-i", keyPath,
        `ubuntu@${ip}`,
        "test -f /etc/.well-ready && echo ready",
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code === 0 && out === "ready") return;
    await Bun.sleep(1000);
  }
  throw new Error(`well ssh not ready within ${timeoutMs}ms`);
}

export async function createWell(opts: CreateOptions): Promise<CreateResult> {
  validateWellName(opts.name);

  await ensureStateDirs();

  const defaults = await loadDefaults();
  const cpu = opts.cpu ?? defaults.cpu;
  const memory = normalizeSize(opts.memory ?? defaults.memory);
  const diskSize = normalizeSize(opts.disk ?? defaults.disk);

  const fromImage = opts.fromImage ?? DEFAULT_BASE_IMAGE;
  if (!(await imageExists(fromImage))) {
    if (fromImage === DEFAULT_BASE_IMAGE) {
      throw new Error(
        `base image not baked yet: ${imageDiskPath(fromImage)} missing. run scripts/bake-base-image.ts`,
      );
    }
    throw new Error(`image '${fromImage}' not found in ${PATHS.images()}`);
  }
  // Image-contract gate. Every image — base or saved — must have a
  // versioned meta.json. Bake script + saveImage both stamp it.
  // Refuse old contract versions up front rather than letting the
  // fork hang on DHCP for 90s. (`rinsed` semantics flipped 2026-05-09
  // — see ImageMeta. No longer a refusal signal; it's now a
  // positive "fork-ready" signal.)
  const meta = await imageMeta(fromImage);
  const v = meta?.image_contract_version;
  if (v === undefined || v < CURRENT_IMAGE_CONTRACT_VERSION) {
    throw new Error(
      `image '${fromImage}' has incompatible contract (image_contract_version=${v ?? "missing"}, expected ${CURRENT_IMAGE_CONTRACT_VERSION}) — re-bake from ${DEFAULT_BASE_IMAGE}.`,
    );
  }
  const baseDisk = imageDiskPath(fromImage);

  const lume = new LumeClient();
  const existing = await lume.list().catch(() => [] as Array<{ name: string }>);
  if (existing.some((v) => v.name === opts.name)) {
    throw new Error(`lume already has a VM named '${opts.name}'`);
  }

  const tStart = Date.now();
  const phase: Record<string, number> = {};
  const mark = (name: string) => {
    phase[name] = Date.now() - tStart;
  };

  const vmDir = await ensureVmDir(opts.name);
  mark("vmDir");
  log.info("create: vmDir ready", { dir: vmDir });

  const wellPubkey = await ensureSshKey(
    PATHS.vmSshKey(opts.name),
    `well@${opts.name}`,
  );
  const hostPubkey = opts.hostPubkey ?? (await detectHostPubkey());

  // B.0.9.d.4: per-well seed disk replaces cloud-config YAML. The
  // base image now ships well-firstboot.service which mounts the
  // CIDATA-labeled disk and applies identity from well.env +
  // authorized_keys (no cloud-init in path).
  const cidataPath = join(vmDir, "cidata.iso");
  await buildWellSeed(
    {
      hostname: opts.name,
      authorizedKeys: [hostPubkey, wellPubkey],
      ...(opts.env ? { env: opts.env } : {}),
    },
    cidataPath,
  );
  mark("seed");
  log.info("create: well seed built", { path: cidataPath });

  log.info("create: lume create bundle", { name: opts.name, cpu, memory, diskSize });
  await lume.create({
    name: opts.name,
    os: "linux",
    cpu,
    memory,
    diskSize,
    display: "1024x768",
  });
  mark("lumeCreate");
  await lume.waitForStatus(opts.name, "stopped", { timeoutMs: 60_000 });
  mark("waitStopped");

  const bundleDisk = bundleDiskPath(opts.name);
  // Guard: lume's POST /lume/vms returns "provisioning" immediately and
  // info() reports "stopped" before the bundle dir tree is fully on-disk.
  // For long-lived `~/.lume/`, the dir was almost always already there
  // (lume populates it eagerly with cache hits). For a freshly-pointed
  // location like `~/.lume-dev/<name>/`, the parent dir lags. Ensure it
  // exists so `cp -c` doesn't race.
  await mkdir(dirname(bundleDisk), { recursive: true });
  log.info("create: clonefile base → bundle", {
    from: baseDisk,
    to: bundleDisk,
  });
  await clonefile(baseDisk, bundleDisk);
  mark("clonefile");

  const truncProc = spawn(
    ["truncate", "-s", sizeToTruncateArg(diskSize), bundleDisk],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if ((await truncProc.exited) !== 0) {
    const err = await new Response(truncProc.stderr).text();
    throw new Error(`truncate failed: ${err}`);
  }
  mark("truncate");

  // Boot via lume's HTTP /run API with the cidata mount. This puts the VM
  // in lume serve's SharedVM cache so pause/resume work consistently from
  // birth. Requires bin/lume to be built with the wells patch
  // 0001-add-mount-to-RunVMRequest.patch applied.
  // Snapshot leases BEFORE the new VM boots so waitForDhcpLease can
  // identify our lease by what wasn't there before — substrate-level
  // delta lookup that bypasses hostname/DUID racing. See B.0.8 + cells
  // punchlist 2026-05-08.
  const beforeLeases = await dumpDhcpLeases();
  log.info("create: lume.start (API path)", { name: opts.name, mount: cidataPath });
  await lume.start(opts.name, { noDisplay: true, mount: cidataPath });
  mark("lumeStart1");

  await lume.waitForStatus(opts.name, "running", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });
  mark("waitRunning1");

  // L3(b) cell-side static netplan was reverted — wait on DHCP IP
  // and connect there. The allocated pinnedIp is still recorded on
  // the registry record (and resolveWellIp prefers it once present),
  // but until the cell-side wiring is fixed the cell only listens on
  // its DHCP-assigned address. Lever 3(a) framework is in place; the
  // cell-side activation is a separate ship.
  const ip = await waitForDhcpLease(opts.name, 90_000, lume, beforeLeases);
  mark("dhcp1");
  log.info("create: DHCP lease", { ip });

  await waitForSshReady(ip, PATHS.vmSshKey(opts.name), 5 * 60_000);
  mark("ssh1");
  log.info("create: ssh ready (with cidata)", { ip });

  // B.0.9.d.4: warming sequence — detach cidata for hibernate-legal
  // steady state. cidata is birth media only. well-firstboot.service
  // has by now persisted hostname/keys/user/network/agent state to
  // the root disk (proven by /etc/.well-ready). The base image has
  // no cloud-init, so the second boot brings up systemd-networkd
  // immediately from the baked /etc/netplan/01-well.yaml — no
  // datasource search to block, no socket-activation hazards.
  log.info("create: warming — fast guest halt (sync + sysrq)", { name: opts.name });
  // Issue the halt over SSH (guest is reachable from the first-boot
  // probe just above). lume.stop's ACPI path interacts poorly with cidata
  // detach — host SSH probes after the warming-restart see "Connection
  // reset" alternating with "Permission denied", as if sshd is in a half-
  // restarted state. Guest-initiated halt is consistently clean.
  //
  // Fast-halt vs `shutdown -h now`: the latter runs systemd's full
  // poweroff.target (stop all services in dependency order) which takes
  // 4-5s on a guest that has nothing real running. For warming-restart we
  // just need: (a) sync any pending writes (well-firstboot's /etc, ssh
  // host keys, machine-id, swap), (b) release the disk asap so the next
  // lume.start gets a clean handle. `sync` flushes; sysrq-o triggers an
  // immediate kernel-level poweroff that bypasses systemd entirely. Saves
  // ~3-4s of warming sequence per create. Sysrq is enabled by default in
  // Ubuntu's stock kernel; if it's ever disabled we fall through to the
  // disk-release timeout and the next iteration would surface the gap.
  const shutdownProc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=4",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", PATHS.vmSshKey(opts.name),
      `ubuntu@${ip}`,
      "sudo sync && echo o | sudo tee /proc/sysrq-trigger >/dev/null",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  await shutdownProc.exited; // ssh exits immediately after sending; ignore code
  mark("shutdownSent");
  // Wait for the bundle disk to be released by Apple Virtualization. lume's
  // own status field lags well past the actual stop. lsof on the disk file
  // is the substrate-level signal that the VM process has truly exited.
  // Don't call lume.stop after SSH shutdown — observed to crash lume serve
  // when the VM is already gone.
  await waitForDiskReleased(bundleDisk, 60_000);
  mark("diskReleased");
  log.info("create: warming — restart without mount (disk-only)", {
    name: opts.name,
  });
  // Snapshot leases pre-restart so we can identify the well's new lease
  // via delta lookup. well-firstboot regenerates machine-id on first
  // boot, so DUID changes and the second boot gets a NEW DHCP lease.
  // lume.info's IP cache lags by 30s+; the leases file is authoritative
  // and updated within ~3s of DHCP completing.
  const beforeWarm = await dumpDhcpLeases();
  await lume.start(opts.name, { noDisplay: true });
  mark("lumeStart2");
  await lume.waitForStatus(opts.name, "running", { timeoutMs: 60_000 });
  mark("waitRunning2");
  const warmedIp = await waitForDhcpLease(
    opts.name,
    60_000,
    lume,
    beforeWarm,
  );
  mark("dhcp2");
  await waitForSshReady(warmedIp, PATHS.vmSshKey(opts.name), 60_000);
  mark("ssh2");
  log.info("create: warmed (disk-only steady state)", { ip: warmedIp });
  // Phase profile: each marker is cumulative ms from start. Diffs between
  // adjacent markers give per-phase cost. B.0.9.d.4 instrumentation —
  // identify the long pole for create+warm latency optimization.
  log.info("create: profile", { totalMs: phase.ssh2, phase });

  // Persist the seal so hibernate can fire safely. createWell is the
  // only path that flips hibernate_ready=true; nothing else should.
  // The state machine's hibernate verb now refuses on hibernate_ready=
  // false (see lib/lifecycle.ts hibernateWell), protecting against
  // pre-B.0.9.d.4 wells producing broken hibernate.bin files.
  const detachedAt = new Date().toISOString();
  await writeRuntime(opts.name, {
    ...defaultRuntime(),
    last_transition_at: detachedAt,
    hibernate_ready: true,
    birth_media_detached_at: detachedAt,
    steady_state_mount: null,
  });

  // Read the well's MAC from lume's config.json so we can record it
  // on the registry record. Substrate-level identity for DHCP lease
  // resolution (B.0.8.e). Best-effort: if the file is missing or
  // unparseable, the record gets no mac_address and dhcp lookup falls
  // back to hostname matching.
  const macAddress = await readLumeMac(opts.name);

  const record: WellRecord = {
    name: opts.name,
    uuid: randomUUID(),
    created_at: new Date().toISOString(),
    cpu,
    memory,
    disk_size: diskSize,
    auth: "well",
    ...(macAddress ? { mac_address: macAddress } : {}),
    ...(opts.r2 ? { r2: opts.r2 } : {}),
  };
  await addWell(record);

  // Persist a minimal meta.json next to the well for sources of truth
  // that aren't in the registry (the cidata path, which key).
  const wellMeta = {
    name: opts.name,
    cidata: cidataPath,
    ssh_key: PATHS.vmSshKey(opts.name),
  };
  await writeFile(PATHS.vmMeta(opts.name), JSON.stringify(wellMeta, null, 2), {
    mode: 0o600,
  });

  return { record, ip: warmedIp };
}

// Best-effort meta read for `well info` and friends.
export async function readMeta(name: string): Promise<unknown | null> {
  const path = PATHS.vmMeta(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

// Disk usage in bytes for a well's bundle disk. Returns null if the
// bundle isn't there (e.g., never booted). Uses size on disk, not allocated
// size — APFS clonefile means logical and physical can diverge wildly.
export async function diskUsageBytes(name: string): Promise<number | null> {
  const path = bundleDiskPath(name);
  if (!existsSync(path)) return null;
  try {
    const s = await stat(path);
    // st_blocks * 512 ≈ on-disk size on APFS. Bun's stat exposes it as `blocks`.
    const blocks = (s as unknown as { blocks?: number }).blocks;
    if (typeof blocks === "number") return blocks * 512;
    return s.size;
  } catch {
    return null;
  }
}
