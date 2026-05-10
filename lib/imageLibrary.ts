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

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
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

// W.5 — pull half. Fetches manifest first, streams disk to a temp
// path, verifies sha256 against manifest, then rotates into place
// alongside meta.json. On any failure post-temp-write, the temp file
// is cleaned. On sha256 mismatch we throw without overwriting the
// local image (caller's old copy survives).
export interface PullResult {
  manifest: PushManifest;
  localDir: string;
  bytes: number;
  durationMs: number;
}

export interface PullImageDeps {
  client?: S3Client;
  // DI seam for the disk-streaming path. Production uses Bun.write +
  // S3Client.file. Tests pass a stub that writes fixed bytes so the
  // sha256 verification path can be exercised without R2.
  fetchDiskTo?: (
    client: S3Client,
    key: string,
    localPath: string,
  ) => Promise<number>;
}

async function defaultFetchDiskTo(
  client: S3Client,
  key: string,
  localPath: string,
): Promise<number> {
  await Bun.write(localPath, client.file(key));
  return (await Bun.file(localPath).stat()).size;
}

export async function pullImage(
  name: string,
  config: R2LibraryConfig,
  deps: PullImageDeps = {},
): Promise<PullResult> {
  const t0 = Date.now();
  const client = deps.client ?? libraryClient(config);
  const fetchDiskTo = deps.fetchDiskTo ?? defaultFetchDiskTo;

  const keyManifest = imageLibraryKey(name, "manifest.json");
  const keyMeta = imageLibraryKey(name, "meta.json");
  const keyDisk = imageLibraryKey(name, "disk.img");

  // Manifest first — cheap (~1 KB), validates the image exists in
  // the library at all. Bun's S3File has a .text() helper.
  let manifestText: string;
  try {
    manifestText = await client.file(keyManifest).text();
  } catch (e) {
    throw new Error(
      `manifest.json not in R2 for image '${name}' (key=${keyManifest}): ${(e as Error).message}`,
    );
  }
  const manifest = JSON.parse(manifestText) as PushManifest;
  if (manifest.name !== name) {
    throw new Error(
      `manifest name mismatch: requested '${name}', manifest says '${manifest.name}'`,
    );
  }

  const localDir = PATHS.imageDir(name);
  await mkdir(localDir, { recursive: true });
  const tempDisk = join(localDir, "disk.img.partial");

  // Stream disk to a partial path so a mid-pull crash doesn't leave a
  // truncated disk.img masquerading as complete. Verify against the
  // manifest's sha256 BEFORE renaming into place.
  let bytes: number;
  try {
    bytes = await fetchDiskTo(client, keyDisk, tempDisk);
  } catch (e) {
    await rm(tempDisk, { force: true });
    throw new Error(`disk.img stream failed: ${(e as Error).message}`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(tempDisk).stream();
  for await (const chunk of stream) hasher.update(chunk);
  const actualSha = hasher.digest("hex");
  if (actualSha !== manifest.disk_sha256) {
    await rm(tempDisk, { force: true });
    throw new Error(
      `sha256 mismatch for image '${name}': manifest=${manifest.disk_sha256}, downloaded=${actualSha} — partial fetch deleted, retry`,
    );
  }
  if (bytes !== manifest.disk_size_bytes) {
    await rm(tempDisk, { force: true });
    throw new Error(
      `size mismatch for image '${name}': manifest=${manifest.disk_size_bytes}, downloaded=${bytes}`,
    );
  }

  // Meta.json fetch + write. Do this AFTER disk verification so a bad
  // disk doesn't overwrite a good local meta.
  let metaText: string;
  try {
    metaText = await client.file(keyMeta).text();
  } catch (e) {
    await rm(tempDisk, { force: true });
    throw new Error(`meta.json fetch failed: ${(e as Error).message}`);
  }

  // Rotate into place — disk first (atomically), then meta. createWell
  // checks `imageExists(name)` which keys off disk.img presence, so the
  // ordering means a partial recovery still has a valid disk + meta.
  await Bun.write(imageDiskPath(name), Bun.file(tempDisk));
  await rm(tempDisk, { force: true });
  await writeFile(join(localDir, "meta.json"), metaText);

  return {
    manifest,
    localDir,
    bytes,
    durationMs: Date.now() - t0,
  };
}
