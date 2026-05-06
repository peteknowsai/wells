// Splite create orchestration. Composes engine + state + cloud-init into a
// single end-to-end flow:
//
//   validate name → ensure dirs → per-splite ssh key → compose user-data →
//   build cidata.iso → lume.create bundle → clonefile base disk into bundle
//   → truncate to requested size → boot via `lume run` (detached, --mount
//   cidata) → wait for DHCP lease → wait for ssh ready → register.
//
// Mirrors scripts/bake-base-image.ts's pattern; the bake is "make the base",
// this is "instantiate the base into a splite". Keep them aligned.

import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { randomUUID } from "node:crypto";

import { log } from "./log.ts";
import { ensureSshKey } from "./sshKey.ts";
import { composeSpliteUserData } from "./cloudInitSplite.ts";
import { clonefile } from "./clonefile.ts";
import { readDhcpLease } from "./dhcp.ts";
import { PATHS, ensureStateDirs, ensureVmDir } from "./state.ts";
import { addSplite, type SpliteRecord } from "./registry.ts";
import { loadDefaults } from "./defaults.ts";
import {
  normalizeSize,
  sizeToTruncateArg,
  validateSpliteName,
} from "./splitePolicy.ts";
import { LumeClient } from "../engine/lume.ts";
import { bundleDiskPath } from "../engine/bundle.ts";

const RELEASE = "25.10";
const SPLITES_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(SPLITES_ROOT, "templates", "cloud-init-splite.yaml");

export interface CreateOptions {
  name: string;
  cpu?: number;
  memory?: string;
  disk?: string;
  // Public key the host will use to ssh into the splite. Defaults to
  // ~/.ssh/id_ed25519.pub if present, else id_rsa.pub.
  hostPubkey?: string;
}

export interface CreateResult {
  record: SpliteRecord;
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
  await writeFile(
    networkConfigPath,
    `version: 2\nethernets:\n  all:\n    match:\n      name: "*"\n    dhcp4: true\n`,
  );

  const isoPath = join(vmDir, "cidata.iso");
  const seed = spawn(
    [
      "bun",
      "run",
      join(SPLITES_ROOT, "scripts", "make-cloud-init-seed.ts"),
      composedPath,
      isoPath,
      `--network-config=${networkConfigPath}`,
      `--hostname=${hostname}`,
      `--instance-id=splite-${hostname}-${Date.now().toString(36)}`,
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
  throw new Error(`no DHCP lease for hostname '${hostname}' within ${timeoutMs}ms`);
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
        "test -f /etc/.splite-ready && echo ready",
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code === 0 && out === "ready") return;
    await Bun.sleep(3000);
  }
  throw new Error(`splite ssh not ready within ${timeoutMs}ms`);
}

export async function createSplite(opts: CreateOptions): Promise<CreateResult> {
  validateSpliteName(opts.name);

  await ensureStateDirs();

  const defaults = await loadDefaults();
  const cpu = opts.cpu ?? defaults.cpu;
  const memory = normalizeSize(opts.memory ?? defaults.memory);
  const diskSize = normalizeSize(opts.disk ?? defaults.disk);

  const baseDisk = join(
    PATHS.imageDir(`ubuntu-${RELEASE}-base`),
    "disk.img",
  );
  if (!existsSync(baseDisk)) {
    throw new Error(
      `base image not baked yet: ${baseDisk} missing. run scripts/bake-base-image.ts`,
    );
  }

  const lume = new LumeClient();
  const existing = await lume.list().catch(() => [] as Array<{ name: string }>);
  if (existing.some((v) => v.name === opts.name)) {
    throw new Error(`lume already has a VM named '${opts.name}'`);
  }

  const vmDir = await ensureVmDir(opts.name);
  log.info("create: vmDir ready", { dir: vmDir });

  const splitePubkey = await ensureSshKey(
    PATHS.vmSshKey(opts.name),
    `splite@${opts.name}`,
  );
  const hostPubkey = opts.hostPubkey ?? (await detectHostPubkey());

  const template = await Bun.file(TEMPLATE_PATH).text();
  const composed = composeSpliteUserData(template, [hostPubkey, splitePubkey]);

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

  const logPath = join(vmDir, "lume-run.log");
  const logFd = openSync(logPath, "a");
  log.info("create: spawning lume run (detached)", { name: opts.name, log: logPath });
  const runProc = spawn(
    [
      "lume", "run", opts.name,
      "--no-display",
      `--mount=${cidataPath}`,
    ],
    { stdout: logFd, stderr: logFd, stdin: "ignore" },
  );
  runProc.unref();

  await lume.waitForStatus(opts.name, "running", {
    timeoutMs: 60_000,
    intervalMs: 1000,
  });

  const ip = await waitForDhcpLease(opts.name, 90_000);
  log.info("create: DHCP lease", { ip });

  await waitForSshReady(ip, PATHS.vmSshKey(opts.name), 5 * 60_000);
  log.info("create: ssh ready");

  const record: SpliteRecord = {
    name: opts.name,
    uuid: randomUUID(),
    created_at: new Date().toISOString(),
    cpu,
    memory,
    disk_size: diskSize,
  };
  await addSplite(record);

  // Persist a minimal meta.json next to the splite for sources of truth
  // that aren't in the registry (the cidata path, which key, log path).
  const meta = {
    name: opts.name,
    cidata: cidataPath,
    ssh_key: PATHS.vmSshKey(opts.name),
    lume_run_log: logPath,
  };
  await writeFile(PATHS.vmMeta(opts.name), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });

  return { record, ip };
}

// Best-effort meta read for `splite info` and friends.
export async function readMeta(name: string): Promise<unknown | null> {
  const path = PATHS.vmMeta(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

// Disk usage in bytes for a splite's bundle disk. Returns null if the
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
