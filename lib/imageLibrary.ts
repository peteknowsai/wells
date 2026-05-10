// Image library on R2 — push half (W.4). See
// `docs/proposals/image-library-on-r2.md` for the design.
//
// Layout in the bucket:
//   images/<name>/
//     manifest.json   — R2-only metadata (sha256, pushed_at, push_by_*)
//     meta.json       — verbatim copy of local meta.json
//     disk.img        — disk bytes
//
// pushImage streams the disk through a sha256 hasher first (cheap on a
// 6 GB disk — ~10s on the Mac), then re-streams it to R2. Two-pass is
// honest about what we're checksumming (the bytes that actually go up).
// Re-reading the file twice is fine on APFS clonefile-backed images
// where physical bytes are shared; on a freshly-baked image the OS page
// cache covers the second pass.
//
// Caller wires creds via the optional `client` factory or via the real
// S3Client; tests pass a stub.

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { S3Client } from "bun";

import { PATHS } from "./state.ts";
import { imageDiskPath, imageExists } from "./imageStore.ts";

// VERSION is owned by daemon/welld.ts but pushImage records it in the
// manifest, so receive it via opts (avoids a daemon → lib import).
export interface R2LibraryConfig {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

export function libraryClient(config: R2LibraryConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
  });
}

export function imageLibraryKey(
  name: string,
  artifact: "manifest.json" | "meta.json" | "disk.img",
): string {
  return `images/${name}/${artifact}`;
}

export interface PushManifest {
  name: string;
  disk_sha256: string;
  disk_size_bytes: number;
  pushed_at: string;
  pushed_by_welld_version: string;
  pushed_by_host: string;
}

export interface PushResult {
  manifest: PushManifest;
  keys: { manifest: string; meta: string; disk: string };
  durationMs: number;
}

// DI seam: tests pass a stub that records writes; production calls with
// `client` omitted and pushImage builds the real one from the config.
export interface PushImageDeps {
  client?: S3Client;
  // Optional override for the per-Mac hostname stamped in the manifest.
  // Tests use this to keep snapshots deterministic.
  host?: string;
  // Optional override for the wall-clock timestamp stamped in pushed_at.
  // Tests pass a fixed value.
  now?: () => Date;
}

export async function pushImage(
  name: string,
  config: R2LibraryConfig,
  welldVersion: string,
  deps: PushImageDeps = {},
): Promise<PushResult> {
  const t0 = Date.now();
  if (!(await imageExists(name))) {
    throw new Error(`image '${name}' not found locally — bake or save first`);
  }

  const diskPath = imageDiskPath(name);
  const metaPath = `${PATHS.imageDir(name)}/meta.json`;
  if (!existsSync(metaPath)) {
    throw new Error(
      `image '${name}' has no meta.json at ${metaPath} — malformed local image`,
    );
  }

  // Pass 1 — compute sha256 of disk bytes. Stream so we don't pull a
  // 6 GB file into RAM. Bun.CryptoHasher.update accepts ArrayBuffer
  // chunks; read the file as a stream of chunks.
  const hasher = new Bun.CryptoHasher("sha256");
  const file = Bun.file(diskPath);
  const stream = file.stream();
  for await (const chunk of stream) hasher.update(chunk);
  const diskSha256 = hasher.digest("hex");
  const diskSizeBytes = (await stat(diskPath)).size;

  const manifest: PushManifest = {
    name,
    disk_sha256: diskSha256,
    disk_size_bytes: diskSizeBytes,
    pushed_at: (deps.now ?? (() => new Date()))().toISOString(),
    pushed_by_welld_version: welldVersion,
    pushed_by_host: deps.host ?? hostname(),
  };

  // Pass 2 — upload artifacts. Order: manifest last so a partial
  // upload doesn't expose an apparently-complete image. Pull verifies
  // by sha256 against manifest, so a half-uploaded disk caught by an
  // interrupted push won't validate on the next pull either way, but
  // "manifest implies disk is whole" keeps the contract clean.
  const client = deps.client ?? libraryClient(config);
  const metaBytes = await readFile(metaPath);
  const keyDisk = imageLibraryKey(name, "disk.img");
  const keyMeta = imageLibraryKey(name, "meta.json");
  const keyManifest = imageLibraryKey(name, "manifest.json");

  await client.write(keyDisk, Bun.file(diskPath));
  await client.write(keyMeta, metaBytes);
  await client.write(keyManifest, JSON.stringify(manifest, null, 2));

  return {
    manifest,
    keys: { manifest: keyManifest, meta: keyMeta, disk: keyDisk },
    durationMs: Date.now() - t0,
  };
}
