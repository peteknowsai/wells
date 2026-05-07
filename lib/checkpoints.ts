// Splite checkpoints — APFS clonefile of the splite's disk into
// ~/.splites/vms/<name>/checkpoints/<id>/disk.img. Copy-on-write means
// creation is sub-millisecond and a checkpoint costs ~zero space until
// the live disk diverges.

import { mkdir, writeFile, readdir, readFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { clonefile } from "./clonefile.ts";
import { log } from "./log.ts";
import {
  deleteCheckpoint as r2Delete,
  downloadCheckpoint as r2Download,
  uploadCheckpoint as r2Upload,
  type UploadResult,
} from "./r2.ts";
import { findSplite, type R2Config } from "./registry.ts";
import { readDhcpLease } from "./dhcp.ts";
import { PATHS } from "./state.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { LumeClient } from "../engine/lume.ts";
import { stopSplite, startSplite } from "./lifecycle.ts";

export interface CheckpointRecord {
  id: string;
  created_at: string;
  size_bytes: number;
  comment?: string;
  // Phase A.2 cold-tier sync. Falsy until R2 push succeeds; toggled true
  // by createCheckpoint when the splite has R2 creds and the upload lands.
  r2_uploaded?: boolean;
  r2_uploaded_at?: string;
  r2_key?: string;
}

// Injection points so tests can run without R2. The defaults call the real
// bun S3Client.
export interface CheckpointDeps {
  r2Upload?: (
    cfg: R2Config,
    name: string,
    id: string,
    localPath: string,
  ) => Promise<UploadResult>;
  r2Delete?: (cfg: R2Config, name: string, id: string) => Promise<void>;
  r2Download?: (
    cfg: R2Config,
    name: string,
    id: string,
    localPath: string,
  ) => Promise<{ bytes: number; durationMs: number }>;
}

export async function createCheckpoint(
  name: string,
  opts: { comment?: string } & CheckpointDeps = {},
): Promise<CheckpointRecord> {
  const upload = opts.r2Upload ?? r2Upload;
  const remove = opts.r2Delete ?? r2Delete;
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
    ...(opts.comment ? { comment: opts.comment } : {}),
  };

  // Best-effort R2 push. Failure here logs a warning but doesn't fail
  // the checkpoint create — the local clonefile is the source of truth.
  if (record.r2) {
    try {
      const r = await upload(record.r2, name, id, checkpointDisk);
      meta.r2_uploaded = true;
      meta.r2_uploaded_at = new Date().toISOString();
      meta.r2_key = r.key;
      log.info("checkpoint: r2 upload ok", {
        splite: name,
        id,
        key: r.key,
        bytes: r.bytes,
        ms: r.durationMs,
      });
    } catch (e) {
      log.warn("checkpoint: r2 upload failed (kept local)", {
        splite: name,
        id,
        err: (e as Error).message,
      });
    }
  }

  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });

  await gcOldCheckpoints(name, { r2Delete: remove });
  return meta;
}

// Sprites parity: keep the 5 most recent checkpoints, auto-GC the rest at
// create time. Older ones get reclaimed without explicit user action so the
// disk doesn't fill up.
export const CHECKPOINT_RETAIN = 5;

export async function gcOldCheckpoints(
  name: string,
  opts: { r2Delete?: CheckpointDeps["r2Delete"] } = {},
): Promise<string[]> {
  const remove = opts.r2Delete ?? r2Delete;
  const all = await listCheckpoints(name);
  if (all.length <= CHECKPOINT_RETAIN) return [];
  const record = await findSplite(name);
  const toRemove = all.slice(0, all.length - CHECKPOINT_RETAIN);
  const removed: string[] = [];
  for (const cp of toRemove) {
    await rm(PATHS.vmCheckpoint(name, cp.id), { recursive: true, force: true });
    removed.push(cp.id);
    // Mirror local retention into R2. Honors SPLITES_R2_RETAIN_FOREVER
    // inside r2.ts. Best-effort — failures are warnings.
    if (record?.r2 && cp.r2_uploaded) {
      try {
        await remove(record.r2, name, cp.id);
      } catch (e) {
        log.warn("checkpoint: r2 delete failed", {
          splite: name,
          id: cp.id,
          err: (e as Error).message,
        });
      }
    }
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

// Make sure the checkpoint disk exists locally, pulling from R2 if needed.
// Pure file IO + R2 — no VM ops, separately testable from the full
// restore pipeline. Returns the local disk path.
export async function ensureCheckpointLocal(
  name: string,
  id: string,
  opts: { fromR2?: boolean } & CheckpointDeps = {},
): Promise<string> {
  const download = opts.r2Download ?? r2Download;
  const record = await findSplite(name);
  if (!record) throw new Error(`splite '${name}' not found in registry`);

  const cpDir = PATHS.vmCheckpoint(name, id);
  const cpDisk = join(cpDir, "disk.img");

  const localMissing = !existsSync(cpDisk);
  const shouldFetch = (opts.fromR2 || localMissing) && !!record.r2;
  if (shouldFetch && record.r2) {
    await mkdir(cpDir, { recursive: true, mode: 0o700 });
    const r = await download(record.r2, name, id, cpDisk);
    log.info("checkpoint: r2 download ok", {
      splite: name,
      id,
      bytes: r.bytes,
      ms: r.durationMs,
    });
    const metaPath = join(cpDir, "meta.json");
    if (!existsSync(metaPath)) {
      const synth: CheckpointRecord = {
        id,
        created_at: new Date().toISOString(),
        size_bytes: r.bytes,
        r2_uploaded: true,
      };
      await writeFile(metaPath, JSON.stringify(synth, null, 2), { mode: 0o600 });
    }
  }

  if (!existsSync(cpDisk)) {
    if (opts.fromR2 && !record.r2) {
      throw new Error(
        `splite '${name}' has no R2 config; cannot pull checkpoint '${id}'`,
      );
    }
    throw new Error(`checkpoint '${id}' not found at ${cpDisk}`);
  }
  return cpDisk;
}

export async function restoreCheckpoint(
  name: string,
  id: string,
  opts: { fromR2?: boolean } & CheckpointDeps = {},
): Promise<RestoreResult> {
  const cpDisk = await ensureCheckpointLocal(name, id, opts);
  await stopSplite(name);
  await clonefile(cpDisk, bundleDiskPath(name));
  const started = await startSplite(name);
  return { ip: started.ip, bootMs: started.bootMs };
}
