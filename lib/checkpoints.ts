// Splite checkpoints — APFS clonefile of the splite's disk into
// ~/.splites/vms/<name>/checkpoints/<id>/disk.img. Copy-on-write means
// creation is sub-millisecond and a checkpoint costs ~zero space until
// the live disk diverges.

import { mkdir, writeFile, readdir, readFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { clonefile } from "./clonefile.ts";
import { findSplite } from "./registry.ts";
import { readDhcpLease } from "./dhcp.ts";
import { PATHS } from "./state.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { LumeClient } from "../engine/lume.ts";
import { stopSplite, startSplite } from "./lifecycle.ts";

export interface CheckpointRecord {
  id: string;
  created_at: string;
  size_bytes: number;
}

export async function createCheckpoint(name: string): Promise<CheckpointRecord> {
  const record = await findSplite(name);
  if (!record) throw new Error(`splite '${name}' not found in registry`);

  const bundleDisk = bundleDiskPath(name);
  if (!existsSync(bundleDisk)) {
    throw new Error(
      `splite '${name}' has no bundle disk at ${bundleDisk}`,
    );
  }

  // If the splite is running, flush the guest filesystem first. APFS
  // clonefile captures host-level disk bytes — anything still in the
  // guest's page cache is invisible to us. Best-effort: skip if the VM
  // isn't reachable.
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "running") {
    const ip = await readDhcpLease(name);
    if (ip) {
      const ssh = spawn(
        [
          "ssh",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          "-i", PATHS.vmSshKey(name),
          `ubuntu@${ip}`,
          "sync",
        ],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
      );
      await ssh.exited;
    }
  }

  // Millisecond timestamp — sortable, human-readable enough, no ambiguity
  // on rapid successive checkpoints.
  const id = Date.now().toString();
  const dir = PATHS.vmCheckpoint(name, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const checkpointDisk = join(dir, "disk.img");
  await clonefile(bundleDisk, checkpointDisk);

  const s = await stat(checkpointDisk);
  const meta: CheckpointRecord = {
    id,
    created_at: new Date().toISOString(),
    size_bytes: s.size,
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });

  await gcOldCheckpoints(name);
  return meta;
}

// Sprites parity: keep the 5 most recent checkpoints, auto-GC the rest at
// create time. Older ones get reclaimed without explicit user action so the
// disk doesn't fill up.
export const CHECKPOINT_RETAIN = 5;

export async function gcOldCheckpoints(name: string): Promise<string[]> {
  const all = await listCheckpoints(name);
  if (all.length <= CHECKPOINT_RETAIN) return [];
  const toRemove = all.slice(0, all.length - CHECKPOINT_RETAIN);
  const removed: string[] = [];
  for (const cp of toRemove) {
    await rm(PATHS.vmCheckpoint(name, cp.id), { recursive: true, force: true });
    removed.push(cp.id);
  }
  return removed;
}

export interface ListedCheckpoint extends CheckpointRecord {
  // Physical bytes on disk (st_blocks * 512). On APFS this is "divergence
  // size" — a fresh checkpoint is near zero because clonefile shares blocks
  // with the live disk; physical_bytes grows as the splite writes.
  physical_bytes: number;
}

export async function listCheckpoints(name: string): Promise<ListedCheckpoint[]> {
  const dir = PATHS.vmCheckpoints(name);
  if (!existsSync(dir)) return [];
  const ids = await readdir(dir);
  const records: ListedCheckpoint[] = [];
  for (const id of ids) {
    const cpDir = join(dir, id);
    const metaPath = join(cpDir, "meta.json");
    const diskPath = join(cpDir, "disk.img");
    if (!existsSync(metaPath)) continue;
    try {
      const meta: CheckpointRecord = JSON.parse(await readFile(metaPath, "utf-8"));
      let physical = 0;
      if (existsSync(diskPath)) {
        const s = await stat(diskPath);
        const blocks = (s as unknown as { blocks?: number }).blocks;
        physical = typeof blocks === "number" ? blocks * 512 : s.size;
      }
      records.push({ ...meta, physical_bytes: physical });
    } catch {
      // skip corrupt entries — list is best-effort
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

export interface RestoreResult {
  ip: string;
  bootMs: number;
}

export async function restoreCheckpoint(
  name: string,
  id: string,
): Promise<RestoreResult> {
  const record = await findSplite(name);
  if (!record) throw new Error(`splite '${name}' not found in registry`);

  const cpDisk = join(PATHS.vmCheckpoint(name, id), "disk.img");
  if (!existsSync(cpDisk)) {
    throw new Error(`checkpoint '${id}' not found at ${cpDisk}`);
  }

  await stopSplite(name);
  await clonefile(cpDisk, bundleDiskPath(name));
  const started = await startSplite(name);
  return { ip: started.ip, bootMs: started.bootMs };
}
