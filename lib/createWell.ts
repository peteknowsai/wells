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
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { randomUUID } from "node:crypto";

import { log } from "./log.ts";
import { ensureSshKey } from "./sshKey.ts";
import { composeWellUserData } from "./cloudInitWell.ts";
import { clonefile } from "./clonefile.ts";
import { dumpDhcpLeases, readDhcpLease } from "./dhcp.ts";
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
import { imageDiskPath, imageExists } from "./imageStore.ts";

const RELEASE = "25.10";
const DEFAULT_BASE_IMAGE = `ubuntu-${RELEASE}-base`;
const WELL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(WELL_ROOT, "templates", "cloud-init-well.yaml");

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

async function detectHostPubkey(): Promise<string> {
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

async function buildCidata(
  vmDir: string,
  composed: string,
  hostname: string,
): Promise<string> {
  const composedPath = join(vmDir, "user-data.composed.yaml");
  await writeFile(composedPath, composed, { mode: 0o600 });

  const networkConfigPath = join(vmDir, "network-config.yaml");
  // Always DHCP at first boot. For pinned wells (Lever 3), the static
  // IP comes from a write_files entry in user-data that overwrites
  // /etc/netplan/50-cloud-init.yaml; runcmd then `netplan apply`s.
  // The cidata network-config path was unreliable on forks (cloud-init
  // doesn't reapply it on instance-id change for already-configured
  // saved images).
  await writeFile(
    networkConfigPath,
    `version: 2\nethernets:\n  all:\n    match:\n      name: "*"\n    dhcp4: true\n`,
  );

  const isoPath = join(vmDir, "cidata.iso");
  const seed = spawn(
    [
      "bun",
      "run",
      join(WELL_ROOT, "scripts", "make-cloud-init-seed.ts"),
      composedPath,
      isoPath,
      `--network-config=${networkConfigPath}`,
      `--hostname=${hostname}`,
      `--instance-id=well-${hostname}-${Date.now().toString(36)}`,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if ((await seed.exited) !== 0) {
    const err = await new Response(seed.stderr).text();
    throw new Error(`make-cloud-init-seed failed: ${err}`);
  }
  return isoPath;
}

async function waitForDhcpLease(
  hostname: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await readDhcpLease(hostname);
    if (ip) return ip;
    await Bun.sleep(2000);
  }
  // On timeout, dump what we DID see in the leases file. Diagnoses the
  // common from-image failure (clone DHCPs under the source's hostname
  // because cloud-init hasn't reset identity) without round-tripping
  // for `cat /var/db/dhcpd_leases`. Top 5 most-recent entries is plenty.
  const snapshot = await dumpDhcpLeases();
  const recent = snapshot.slice(0, 5).map((e) =>
    `name=${e.name ?? "(none)"} ip=${e.ip ?? "(none)"} lease=${e.lease}`,
  );
  const summary = recent.length > 0
    ? `recent leases: ${recent.join("; ")}`
    : "leases file empty or unreadable";
  throw new Error(
    `no DHCP lease for hostname '${hostname}' within ${timeoutMs}ms — ${summary}`,
  );
}

async function waitForSshReady(
  ip: string,
  keyPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = spawn(
      [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=4",
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
    await Bun.sleep(3000);
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
  const baseDisk = imageDiskPath(fromImage);

  const lume = new LumeClient();
  const existing = await lume.list().catch(() => [] as Array<{ name: string }>);
  if (existing.some((v) => v.name === opts.name)) {
    throw new Error(`lume already has a VM named '${opts.name}'`);
  }

  const vmDir = await ensureVmDir(opts.name);
  log.info("create: vmDir ready", { dir: vmDir });

  const wellPubkey = await ensureSshKey(
    PATHS.vmSshKey(opts.name),
    `well@${opts.name}`,
  );
  const hostPubkey = opts.hostPubkey ?? (await detectHostPubkey());

  const template = await Bun.file(TEMPLATE_PATH).text();
  const composed = composeWellUserData(
    template,
    [hostPubkey, wellPubkey],
    opts.env,
  );

  const cidataPath = await buildCidata(vmDir, composed, opts.name);
  log.info("create: cidata built", { path: cidataPath });

  log.info("create: lume create bundle", { name: opts.name, cpu, memory, diskSize });
  await lume.create({
    name: opts.name,
    os: "linux",
    cpu,
    memory,
    diskSize,
    display: "1024x768",
  });
  await lume.waitForStatus(opts.name, "stopped", { timeoutMs: 60_000 });

  const bundleDisk = bundleDiskPath(opts.name);
  log.info("create: clonefile base → bundle", {
    from: baseDisk,
    to: bundleDisk,
  });
  await clonefile(baseDisk, bundleDisk);

  const truncProc = spawn(
    ["truncate", "-s", sizeToTruncateArg(diskSize), bundleDisk],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if ((await truncProc.exited) !== 0) {
    const err = await new Response(truncProc.stderr).text();
    throw new Error(`truncate failed: ${err}`);
  }

  // Boot via lume's HTTP /run API with the cidata mount. This puts the VM
  // in lume serve's SharedVM cache so pause/resume work consistently from
  // birth. Requires bin/lume to be built with the wells patch
  // 0001-add-mount-to-RunVMRequest.patch applied.
  log.info("create: lume.start (API path)", { name: opts.name, mount: cidataPath });
  await lume.start(opts.name, { noDisplay: true, mount: cidataPath });

  await lume.waitForStatus(opts.name, "running", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });

  // L3(b) cell-side static netplan was reverted — wait on DHCP IP
  // and connect there. The allocated pinnedIp is still recorded on
  // the registry record (and resolveWellIp prefers it once present),
  // but until the cell-side wiring is fixed the cell only listens on
  // its DHCP-assigned address. Lever 3(a) framework is in place; the
  // cell-side activation is a separate ship.
  const ip = await waitForDhcpLease(opts.name, 90_000);
  log.info("create: DHCP lease", { ip });

  await waitForSshReady(ip, PATHS.vmSshKey(opts.name), 5 * 60_000);
  log.info("create: ssh ready", { ip });

  const record: WellRecord = {
    name: opts.name,
    uuid: randomUUID(),
    created_at: new Date().toISOString(),
    cpu,
    memory,
    disk_size: diskSize,
    ...(opts.r2 ? { r2: opts.r2 } : {}),
  };
  await addWell(record);

  // Persist a minimal meta.json next to the well for sources of truth
  // that aren't in the registry (the cidata path, which key).
  const meta = {
    name: opts.name,
    cidata: cidataPath,
    ssh_key: PATHS.vmSshKey(opts.name),
  };
  await writeFile(PATHS.vmMeta(opts.name), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });

  return { record, ip };
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
