// Splite checkpoints — APFS clonefile of the splite's disk into
// ~/.splites/vms/<name>/checkpoints/<id>/disk.img. Copy-on-write means
// creation is sub-millisecond and a checkpoint costs ~zero space until
// the live disk diverges.

import { mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clonefile } from "./clonefile.ts";
import { findSplite } from "./registry.ts";
import { PATHS } from "./state.ts";
import { bundleDiskPath } from "../engine/bundle.ts";

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
  return meta;
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
