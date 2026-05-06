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

export async function listCheckpoints(name: string): Promise<CheckpointRecord[]> {
  const dir = PATHS.vmCheckpoints(name);
  if (!existsSync(dir)) return [];
  const ids = await readdir(dir);
  const records: CheckpointRecord[] = [];
  for (const id of ids) {
    const metaPath = join(dir, id, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      records.push(JSON.parse(await readFile(metaPath, "utf-8")));
    } catch {
      // skip corrupt entries — list is best-effort
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
