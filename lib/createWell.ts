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
// lume serve's SharedVM cache, which breaks pause/resume. Requires the
// `mount` field on lume's RunVMRequest — baked into engine/vwell-src/
// (was originally a patch under vendor/lume.patches/swift/, since absorbed
// into our wells-owned source tree per W.14).
//
// Mirrors scripts/bake-base-image.ts's pattern; the bake is "make the base",
// this is "instantiate the base into a well". Keep them aligned.

import { writeFile, mkdir, stat, rm } from "node:fs/promises";
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
import { addWell, findWell, resolveLumeName, type R2Config, type WellRecord } from "./registry.ts";
import { loadDefaults } from "./defaults.ts";
import {
  DEFAULT_CIDR_PREFIX,
  DEFAULT_GATEWAY,
  nextStaticIp,
  releaseReservedIp,
} from "./ipPool.ts";
import {
  normalizeSize,
  sizeToTruncateArg,
  validateWellName,
} from "./wellPolicy.ts";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import {
  CURRENT_IMAGE_CONTRACT_VERSION,
  imageDiskPath,
  imageExists,
  imageMeta,
  resolveImageName,
} from "./imageStore.ts";
import { pullImage, type R2LibraryConfig } from "./imageLibrary.ts";
import { defaultRuntime, writeRuntime } from "./wellRuntime.ts";
import { findVzXpcPids, waitForNewXpcChild } from "./xpcChild.ts";

// W.5 auto-pull — read per-Mac R2 library creds from env, returning
// null if any of the four required fields is missing. createWell
// only attempts the pull when this returns a complete config.
function readR2LibraryEnv(): R2LibraryConfig | null {
  const endpoint = process.env.WELL_R2_LIBRARY_ENDPOINT;
  const bucket = process.env.WELL_R2_LIBRARY_BUCKET;
  const accessKey = process.env.WELL_R2_LIBRARY_ACCESS_KEY_ID;
  const secret = process.env.WELL_R2_LIBRARY_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKey || !secret) return null;
  return {
    endpoint,
    bucket,
    access_key_id: accessKey,
    secret_access_key: secret,
  };
}

const RELEASE = "25.10";
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

// Reads ~/.ssh/id_ed25519.pub or id_rsa.pub. Exported for callers
// that don't have a pubkey already in hand.
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
export async function readLumeMac(name: string): Promise<string | null> {
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

// MAC-aware, snapshot-filtered DHCP wait. Returns the well's IP,
// throws with a self-explaining "no DHCP lease" diagnostic on timeout.
// Exported so callers building hibernate-legal wells (e.g. cells's
// pool manager via SSH-orchestrated bake) can reuse the lookup logic.
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
      let fresh = findNewLeases(beforeSnapshot, after);
      // A.1.4.f: when MAC is known, restrict delta candidates to
      // those matching it. Without this filter, an unrelated lease
      // RENEWAL (e.g., a just-adopted pool member's vmnet refresh)
      // appears as a "new" lease entry and the fresh-boot consumer
      // wrongly inherits its IP. Surfaced 2026-05-09 by smoke-pool-
      // adopt's cold-fallback cycle, where a 16ms `DHCP lease`
      // pulled the consumed pool member's renewed entry.
      if (mac) {
        const matching = fresh.filter((l) => l.mac === mac);
        // Only fall back to the unfiltered list when MAC produced
        // nothing AND there's no MAC-bearing entry at all (older
        // dhcp-identifier forms). This preserves substrate
        // precedence for new wells without locking out pre-MAC
        // wells that might still hit this path.
        const anyMacEntries = fresh.some((l) => l.mac !== null);
        fresh = matching.length > 0
          ? matching
          : (anyMacEntries ? [] : fresh);
      }
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
    // 500ms poll. Each iteration is three small file reads on
    // /var/db/dhcpd_leases (~40KB) — cheap. The prior 2000ms interval
    // dominated the per-create wall clock: W.6 historical analysis
    // found dhcp1 + dhcp2 both consistently land at ~4s (two polling
    // gaps), even though vmnet typically issues the lease within
    // 2-3s. Tightening to 500ms drops the polling-induced floor by
    // ~1.5s per phase, ~3s per create end-to-end on the happy path.
    await Bun.sleep(500);
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


// Polls the guest until `/etc/.well-ready` exists + SSH accepts the
// per-well key; throws on timeout. Exported so callers can reuse it.
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
    // W.5 auto-pull: when the local image is missing AND the operator
    // has configured an R2 library (per-Mac env), try to fetch it
    // before failing. Mirrors `ensureCheckpointLocal`'s implicit-fetch
    // path. The base image is excluded — the bake script is the
    // canonical producer for it; we don't want a fresh Mac silently
    // pulling a stale `ubuntu-25.10-base` from R2 instead of baking.
    const r2 = readR2LibraryEnv();
    if (r2 && fromImage !== DEFAULT_BASE_IMAGE) {
      log.info("create: image missing locally; pulling from R2 library", {
        image: fromImage,
        bucket: r2.bucket,
      });
      try {
        const result = await pullImage(fromImage, r2);
        log.info("create: image pulled from R2 library", {
          image: fromImage,
          bytes: result.bytes,
          ms: result.durationMs,
        });
      } catch (e) {
        throw new Error(
          `image '${fromImage}' not found locally and R2 pull failed: ${(e as Error).message}`,
        );
      }
    } else if (fromImage === DEFAULT_BASE_IMAGE) {
      throw new Error(
        `base image not baked yet: ${imageDiskPath(fromImage)} missing. run scripts/bake-base-image.ts`,
      );
    } else {
      throw new Error(`image '${fromImage}' not found in ${PATHS.images()}`);
    }
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
  // Aliases (e.g. ubuntu-base → ubuntu-25.10-base) resolve here so
  // forks read from the concrete image's disk.img.
  const baseDisk = imageDiskPath(await resolveImageName(fromImage));

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

  // W.72: static IP allocation. If the operator has enabled the static
  // range in defaults AND the source image's guest knows how to honor
  // WELL_STATIC_IP_CIDR (i.e. it was baked with the W.72-aware
  // well-firstboot.sh), allocate before the VM boots and stamp onto
  // the cidata seed. SSH-wait below skips the DHCP delta lookup and
  // goes straight to ssh-on-pinned-ip.
  //
  // Stale images (pre-W.72 layered images, e.g. cell-base baked from
  // the old ubuntu-base) lack the firstboot handler — allocating a
  // static IP would deadlock the create waiting for SSH on an address
  // the guest never moves to. Fall back to DHCP for those.
  let pinnedIp: string | null = null;
  try {
  if (defaults.static_ip_range != null) {
    if (meta?.firstboot_supports_static_ip) {
      pinnedIp = await nextStaticIp();
      if (!pinnedIp) {
        throw new Error(
          `static IP range exhausted: ${defaults.static_ip_range}`,
        );
      }
      log.info("create: allocated static IP", { name: opts.name, ip: pinnedIp });
    } else {
      log.warn(
        "create: source image lacks firstboot_supports_static_ip — falling back to DHCP",
        { name: opts.name, source_image: fromImage },
      );
    }
  }

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
  // birth. Requires bin/vwell to be built with the wells patch
  // 0001-add-mount-to-RunVMRequest.patch applied.
  // Snapshot leases BEFORE the new VM boots so waitForDhcpLease can
  // identify our lease by what wasn't there before — substrate-level
  // delta lookup that bypasses hostname/DUID racing. See B.0.8 + cells
  // punchlist 2026-05-08.
  const beforeLeases = await dumpDhcpLeases();
  // W.74: snapshot VZ XPC PIDs so we can identify the new
  // VirtualMachine.xpc child after the final lume.start. Captured into
  // runtime.json below; hibernate uses it to release VZ kernel state
  // surgically (per-child SIGKILL instead of process-wide
  // killAndRestartLumeServe).
  const xpcBefore = await findVzXpcPids();
  log.info("create: lume.start (API path)", { name: opts.name, mount: cidataPath });
  await lume.start(opts.name, { noDisplay: true, mount: cidataPath });
  mark("lumeStart1");

  await lume.waitForStatus(opts.name, "running", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });
  mark("waitRunning1");

  // W.72: static-IP wells skip the DHCP delta lookup — well-firstboot.sh
  // writes a static netplan from cidata, the guest lands on its pinned
  // address once netplan applies. SSH on the pinned IP becomes reachable
  // ~10-15s after VM start (DHCP briefly happens with the base image's
  // dhcp4:true netplan, then firstboot swaps it). Allow generous SSH
  // timeout for the swap window.
  let ip: string;
  if (pinnedIp) {
    ip = pinnedIp;
    await waitForSshReady(pinnedIp, PATHS.vmSshKey(opts.name), 5 * 60_000);
    mark("ssh1");
    log.info("create: ssh ready (static IP, with cidata)", { ip });
  } else {
    ip = await waitForDhcpLease(opts.name, 90_000, lume, beforeLeases);
    mark("dhcp1");
    log.info("create: DHCP lease", { ip });
    await waitForSshReady(ip, PATHS.vmSshKey(opts.name), 5 * 60_000);
    mark("ssh1");
    log.info("create: ssh ready (with cidata)", { ip });
  }

  // Piece 3 (boundary cleanup): operator-created wells stay running with
  // cidata attached as alive_running. Hibernate is illegal for these
  // wells (hibernate_ready stays false from defaultRuntime). Callers
  // that need a hibernate-legal well — currently cells's pool builder —
  // run their own warming sequence (halt + restart without cidata) over
  // SSH outside of createWell.
  const warmedIp = ip;
  log.info("create: profile", { totalMs: phase.ssh1, phase });

  // W.74: capture the new VirtualMachine.xpc child PID via diff
  // against the pre-start snapshot. Persisted in runtime.json so
  // hibernate can SIGKILL only this well's child. waitForNewXpcChild
  // returns null on timeout; that path falls back to the legacy
  // killAndRestart behavior in hibernate (degraded — wakes will
  // clip siblings). Healthy path: PID captured within ~500ms.
  const newXpcPid = await waitForNewXpcChild(xpcBefore, { timeoutMs: 5_000 });
  if (newXpcPid != null) {
    log.info("create: tracked new VZ XPC", { name: opts.name, pid: newXpcPid });
  } else {
    log.warn(
      "create: no new XPC appeared (hibernate will fall back to legacy kill+restart)",
      { name: opts.name },
    );
  }
  // Operator-created wells keep cidata mounted and run as alive_running.
  // defaultRuntime() seeds hibernate_ready=false + birth_media_detached_at=null,
  // so the state machine's hibernate verb refuses (see lib/lifecycle.ts
  // hibernateWell). Hibernate-legal wells come from cells's pool builder
  // doing its own warming sequence over SSH outside this path.
  await writeRuntime(opts.name, {
    ...defaultRuntime(),
    ip: warmedIp,
    xpc_child_pid: newXpcPid,
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
    ...(pinnedIp ? { pinned_ip: pinnedIp } : {}),
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
  } catch (err) {
    // A create that fails after lume.create — most often the SSH-ready
    // gate timing out while the host is saturated (cells bake
    // contention, 2026-05-14) — bails before addWell runs. That leaves
    // the VM lume started, and its VirtualMachine.xpc process, with no
    // registry record: an orphan `well doctor` flags as degraded. Reap
    // it so a timed-out create cleans up after itself.
    const reaped = await reapOrphanVm(lume, opts.name, vmDir);
    if (reaped) {
      log.warn("create: failed after VM existed — reaped orphan", {
        name: opts.name,
        err: (err as Error).message,
      });
    }
    throw err;
  } finally {
    // Release the IP reservation regardless of how we exit. On success
    // the pinned_ip is now in the registry (addWell ran), so the
    // in-memory reservation is redundant. On failure the IP is freed
    // immediately so a retry can pick it up rather than scanning past it.
    if (pinnedIp) releaseReservedIp(pinnedIp);
  }
}

// The minimal lume surface reapOrphanVm needs — keeps the helper
// testable with a stub instead of a live LumeClient.
interface ReapLume {
  info(name: string): Promise<unknown>;
  stop(name: string): Promise<unknown>;
  delete(name: string): Promise<unknown>;
}

// Reap a VM left behind by a create that failed after lume.start:
// stop it (which kills the VirtualMachine.xpc process), delete the
// lume bundle, drop the wells state dir. Best-effort and idempotent —
// every step tolerates the VM or dir already being gone. Returns
// whether lume still knew about the VM (i.e. there was something to
// reap). Exported for the createWell catch path + its tests.
export async function reapOrphanVm(
  lume: ReapLume,
  name: string,
  vmDir: string,
): Promise<boolean> {
  const orphan = await lume.info(name).catch(() => null);
  if (orphan) {
    if ((orphan as { status?: string }).status !== "stopped") {
      await lume.stop(name).catch(() => {});
    }
    await lume.delete(name).catch(() => {});
  }
  await rm(vmDir, { recursive: true, force: true }).catch(() => {});
  return orphan != null;
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
//
// Resolves lume_name first so adopted wells (whose bundle lives at
// `~/.lume/pool-XXXX/`, not `~/.lume/<op-name>/`) report correctly.
export async function diskUsageBytes(name: string): Promise<number | null> {
  const path = bundleDiskPath(await resolveLumeName(name));
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
