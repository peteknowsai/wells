// Well checkpoints — APFS clonefile of the well's disk into
// ~/.wells/vms/<name>/checkpoints/<id>/disk.img. Copy-on-write means
// creation is sub-millisecond and a checkpoint costs ~zero space until
// the live disk diverges.

import { mkdir, writeFile, readdir, readFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { clonefile } from "./clonefile.ts";
import { loadDefaults } from "./defaults.ts";
import { log } from "./log.ts";
import {
  deleteCheckpoint as r2Delete,
  downloadCheckpoint as r2Download,
  uploadCheckpoint as r2Upload,
  type UploadResult,
} from "./r2.ts";
import { findWell, lumeNameOf, type R2Config } from "./registry.ts";
import { resolveWellIp } from "./dhcp.ts";
import { PATHS } from "./state.ts";
import { bundleDiskPath } from "../engine/bundle.ts";
import { LumeClient } from "../engine/vwell.ts";
import { stopWell, startWell } from "./lifecycle.ts";

export interface CheckpointRecord {
  id: string;
  created_at: string;
  size_bytes: number;
  comment?: string;
  // Phase A.2 cold-tier sync. Falsy until R2 push succeeds; toggled true
  // by createCheckpoint when the well has R2 creds and the upload lands.
  r2_uploaded?: boolean;
  r2_uploaded_at?: string;
  r2_key?: string;
  // Phase A.4 retention. When set, the checkpoint expires at this
  // wall-clock time and is dropped on the next gc pass regardless of
  // last-N retention. Format ISO-8601 to match created_at.
  expires_at?: string;
  retain_for_seconds?: number;
}

// Parse a duration like "7d", "12h", "30m", "45s" into seconds. Returns
// undefined for unknown shapes — callers should treat that as a usage error.
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
  }
  return undefined;
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
  opts: {
    comment?: string;
    retainForSeconds?: number;
  } & CheckpointDeps = {},
): Promise<CheckpointRecord> {
  const upload = opts.r2Upload ?? r2Upload;
  const remove = opts.r2Delete ?? r2Delete;
  const record = await findWell(name);
  if (!record) throw new Error(`well '${name}' not found in registry`);

  const bundleDisk = bundleDiskPath(lumeNameOf(record));
  if (!existsSync(bundleDisk)) {
    throw new Error(
      `well '${name}' has no bundle disk at ${bundleDisk}`,
    );
  }

  // If the well is running, flush the guest filesystem first. APFS
  // clonefile captures host-level disk bytes — anything still in the
  // guest's page cache is invisible to us. Best-effort: skip if the VM
  // isn't reachable.
  const lume = new LumeClient();
  const info = await lume.info(name).catch(() => null);
  if (info?.status === "running") {
    // resolveWellIp, not readDhcpLease — pinned-IP/MAC wells never land
    // in dhcpd_leases under their own hostname, so a bare readDhcpLease
    // returns null and the guest fs flush gets silently skipped.
    const ip = await resolveWellIp(name);
    if (ip) {
      const ssh = spawn(
        [
          "ssh",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          "-i", PATHS.vmSshKey(name),
          `root@${ip}`,
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
  const createdAt = new Date();
  const meta: CheckpointRecord = {
    id,
    created_at: createdAt.toISOString(),
    size_bytes: s.size,
    ...(opts.comment ? { comment: opts.comment } : {}),
    ...(opts.retainForSeconds !== undefined
      ? {
          retain_for_seconds: opts.retainForSeconds,
          expires_at: new Date(
            createdAt.getTime() + opts.retainForSeconds * 1000,
          ).toISOString(),
        }
      : {}),
  };

  // Write initial meta.json (r2_uploaded:false until upload completes).
  // For callers without R2 config, this is the final state.
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });

  // R2 upload runs async — for sparse 50GB+ disks the upload can blow
  // past Bun.serve's idleTimeout (255s max), so we return cp.id now and
  // let the upload progress in the background. Callers poll via
  // GET /v1/wells/<n>/checkpoints to see r2_uploaded flip true. If welld
  // restarts mid-upload the cp stays at r2_uploaded:false and the
  // caller can re-checkpoint.
  if (record.r2) {
    const r2Cfg = record.r2;
    void uploadCheckpointAsync({
      cfg: r2Cfg,
      name,
      id,
      checkpointDisk,
      metaPath: join(dir, "meta.json"),
      meta,
      upload,
    });
  }

  await gcOldCheckpoints(name, { r2Delete: remove });
  return meta;
}

async function uploadCheckpointAsync(opts: {
  cfg: R2Config;
  name: string;
  id: string;
  checkpointDisk: string;
  metaPath: string;
  meta: CheckpointRecord;
  upload: NonNullable<CheckpointDeps["r2Upload"]>;
}): Promise<void> {
  const { cfg, name, id, checkpointDisk, metaPath, meta, upload } = opts;
  try {
    const r = await upload(cfg, name, id, checkpointDisk);
    meta.r2_uploaded = true;
    meta.r2_uploaded_at = new Date().toISOString();
    meta.r2_key = r.key;
    if (existsSync(metaPath)) {
      await writeFile(metaPath, JSON.stringify(meta, null, 2), {
        mode: 0o600,
      });
    }
    log.info("checkpoint: r2 upload ok", {
      well: name,
      id,
      key: r.key,
      bytes: r.bytes,
      ms: r.durationMs,
    });
  } catch (e) {
    log.warn("checkpoint: r2 upload failed (kept local)", {
      well: name,
      id,
      err: (e as Error).message,
    });
  }
}

// Default last-N retention if defaults.ts can't be read (test fixtures,
// stale state). Configurable per host via defaults.checkpoint_retain_count.
export const CHECKPOINT_RETAIN_FALLBACK = 5;

export async function gcOldCheckpoints(
  name: string,
  opts: {
    r2Delete?: CheckpointDeps["r2Delete"];
    retainCount?: number;
    nowMs?: number;
  } = {},
): Promise<string[]> {
  const remove = opts.r2Delete ?? r2Delete;
  const now = opts.nowMs ?? Date.now();

  // Pull retain-count from defaults unless caller overrode. Fall back to
  // hardcoded if defaults can't be loaded — better to keep too many than
  // accidentally nuke them.
  let retainCount = opts.retainCount;
  if (retainCount === undefined) {
    try {
      const d = await loadDefaults();
      retainCount = d.checkpoint_retain_count;
    } catch {
      retainCount = CHECKPOINT_RETAIN_FALLBACK;
    }
  }

  const all = await listCheckpoints(name);
  const record = await findWell(name);
  const removed: string[] = [];

  // First pass: drop expired TTLs regardless of count. expires_at is ISO,
  // compare to now. Missing field = no TTL = skip.
  const survivingAfterTtl: typeof all = [];
  for (const cp of all) {
    if (cp.expires_at && Date.parse(cp.expires_at) <= now) {
      await dropCheckpoint(name, cp.id, record, remove, cp.r2_uploaded ?? false);
      removed.push(cp.id);
    } else {
      survivingAfterTtl.push(cp);
    }
  }

  // Second pass: last-N rule on what survived TTL.
  if (survivingAfterTtl.length > retainCount) {
    const toRemove = survivingAfterTtl.slice(
      0,
      survivingAfterTtl.length - retainCount,
    );
    for (const cp of toRemove) {
      await dropCheckpoint(name, cp.id, record, remove, cp.r2_uploaded ?? false);
      removed.push(cp.id);
    }
  }
  return removed;
}

async function dropCheckpoint(
  name: string,
  id: string,
  record: { r2?: R2Config } | null | undefined,
  r2DeleteFn: NonNullable<CheckpointDeps["r2Delete"]>,
  hadR2Upload: boolean,
): Promise<void> {
  await rm(PATHS.vmCheckpoint(name, id), { recursive: true, force: true });
  if (record?.r2 && hadR2Upload) {
    try {
      await r2DeleteFn(record.r2, name, id);
    } catch (e) {
      log.warn("checkpoint: r2 delete failed", {
        well: name,
        id,
        err: (e as Error).message,
      });
    }
  }
}

// Force-expire a single checkpoint by id. Backs the `well checkpoint
// expire <id>` CLI. Best-effort R2 cleanup.
export async function expireCheckpoint(
  name: string,
  id: string,
  opts: { r2Delete?: CheckpointDeps["r2Delete"] } = {},
): Promise<{ removed: boolean }> {
  const remove = opts.r2Delete ?? r2Delete;
  const dir = PATHS.vmCheckpoint(name, id);
  if (!existsSync(dir)) return { removed: false };
  const all = await listCheckpoints(name);
  const cp = all.find((c) => c.id === id);
  const record = await findWell(name);
  await dropCheckpoint(name, id, record, remove, cp?.r2_uploaded ?? false);
  return { removed: true };
}

export interface ListedCheckpoint extends CheckpointRecord {
  // Physical bytes on disk (st_blocks * 512). On APFS this is "divergence
  // size" — a fresh checkpoint is near zero because clonefile shares blocks
  // with the live disk; physical_bytes grows as the well writes.
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
  const record = await findWell(name);
  if (!record) throw new Error(`well '${name}' not found in registry`);

  const cpDir = PATHS.vmCheckpoint(name, id);
  const cpDisk = join(cpDir, "disk.img");

  const localMissing = !existsSync(cpDisk);
  const shouldFetch = (opts.fromR2 || localMissing) && !!record.r2;
  if (shouldFetch && record.r2) {
    await mkdir(cpDir, { recursive: true, mode: 0o700 });
    const r = await download(record.r2, name, id, cpDisk);
    log.info("checkpoint: r2 download ok", {
      well: name,
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
        `well '${name}' has no R2 config; cannot pull checkpoint '${id}'`,
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
  const record = await findWell(name);
  if (!record) throw new Error(`well '${name}' not found in registry`);
  await stopWell(name);
  await clonefile(cpDisk, bundleDiskPath(lumeNameOf(record)));
  const started = await startWell(name);
  return { ip: started.ip, bootMs: started.bootMs };
}
