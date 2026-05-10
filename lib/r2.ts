// R2 / S3-compatible client for cold-tier checkpoint sync. Phase A.2.
//
// Each well carries its own R2 creds (see WellRecord.r2). Path layout in
// the bucket: `wells/<name>/checkpoints/<id>/disk.img`. Mirrors the local
// layout (`~/.wells/vms/<name>/checkpoints/<id>/disk.img`) so a fresh
// host can rehydrate a well from R2 with no rewriting.
//
// This module is the API surface. Loop A.2.1 lands the skeleton; A.2.2/A.2.3
// fill in the streaming PUT/GET against bun's S3Client.

import { S3Client } from "bun";
import type { R2Config } from "./registry.ts";

export type R2Key = string;

export function checkpointKey(wellName: string, checkpointId: string): R2Key {
  return `wells/${wellName}/checkpoints/${checkpointId}/disk.img`;
}

export function clientFor(config: R2Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
  });
}

export interface UploadResult {
  key: R2Key;
  bytes: number;
  durationMs: number;
}

// Stream a local file to R2. Best-effort by design — the caller (checkpoint
// create) treats failures as warnings, not hard errors. Local checkpoint is
// always the source of truth; R2 is durable backup.
export async function uploadCheckpoint(
  config: R2Config,
  wellName: string,
  checkpointId: string,
  localPath: string,
): Promise<UploadResult> {
  const t0 = Date.now();
  const key = checkpointKey(wellName, checkpointId);
  const client = clientFor(config);
  const local = Bun.file(localPath);
  const bytes = local.size;
  // S3 multipart caps at 10,000 parts. Default 5MB parts × 10k = 50GB
  // ceiling, and the 50GB sparse disk.img bumps past that. Use 16MB
  // parts so the cap is 160GB — covers the foreseeable disk sizes.
  await client.write(key, local, { partSize: 16 * 1024 * 1024 });
  return { key, bytes, durationMs: Date.now() - t0 };
}

export interface DownloadResult {
  key: R2Key;
  bytes: number;
  durationMs: number;
}

// Stream from R2 into a local path. Used by `well checkpoint restore
// --from-r2` and the future fresh-host hydration path.
export async function downloadCheckpoint(
  config: R2Config,
  wellName: string,
  checkpointId: string,
  localPath: string,
): Promise<DownloadResult> {
  const t0 = Date.now();
  const key = checkpointKey(wellName, checkpointId);
  const client = clientFor(config);
  const remote = client.file(key);
  await Bun.write(localPath, remote);
  const bytes = (await Bun.file(localPath).stat()).size;
  return { key, bytes, durationMs: Date.now() - t0 };
}

// GC counterpart — when local retention rotates a checkpoint out, drop the
// matching R2 object too unless WELL_R2_RETAIN_FOREVER=1.
export async function deleteCheckpoint(
  config: R2Config,
  wellName: string,
  checkpointId: string,
): Promise<void> {
  if (process.env.WELL_R2_RETAIN_FOREVER === "1") return;
  const key = checkpointKey(wellName, checkpointId);
  const client = clientFor(config);
  await client.delete(key);
}
