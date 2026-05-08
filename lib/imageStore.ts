// Image store — saved snapshots of well disk state, used to fast-clone
// new wells from a known-good baseline. The shape mirrors the existing
// ubuntu-25.10-base image that bake-base-image.ts produces, so a saved
// image and the baked base are interchangeable from `createWell`'s POV.
//
//   ~/.wells/images/<name>/
//     disk.img    — frozen disk (clonefile'd from the source well's bundle)
//     meta.json   — name, from_well, from_disk_size, created_at, notes
//
// Save semantics: the source well must be stopped (or paused) so the disk
// state is consistent. We don't try to quiesce a running fs — clonefile of
// a hot disk gets you a torn snapshot. If you want a hot snapshot, use
// checkpoints; images are for "freeze this baseline so I can fork it."

import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PATHS } from "./state.ts";
import { clonefile } from "./clonefile.ts";
import { findWell } from "./registry.ts";
import { bundleDiskPath } from "../engine/bundle.ts";

// Same RFC1123 shape as well names. Images live in directories on disk and
// flow through API paths — keep the surface narrow. No reserved-name set
// for now (ubuntu-25.10-base is just an image you can't accidentally
// overwrite via saveImage because of the source-must-exist check below;
// it's not a well, so saveImage(fromWell="ubuntu-25.10-base", ...) fails).
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateImageName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid image name '${name}': must be lowercase alphanumeric + hyphens, 1–63 chars, no leading/trailing hyphen`,
    );
  }
}

export interface ImageMeta {
  name: string;
  from_well: string | null;   // null for the prebuilt base
  from_disk_size: string | null;
  created_at: string;
  notes?: string;
  size_bytes?: number;        // physical bytes on disk (best-effort)
}

export function imageDiskPath(name: string): string {
  return join(PATHS.imageDir(name), "disk.img");
}

function imageMetaPath(name: string): string {
  return join(PATHS.imageDir(name), "meta.json");
}

export async function imageExists(name: string): Promise<boolean> {
  return existsSync(imageDiskPath(name));
}

export async function imageMeta(name: string): Promise<ImageMeta | null> {
  if (!(await imageExists(name))) return null;
  const metaPath = imageMetaPath(name);

  // Best-effort physical size — useful for `well image list` output.
  let sizeBytes: number | undefined;
  try {
    const s = await stat(imageDiskPath(name));
    const blocks = (s as unknown as { blocks?: number }).blocks;
    sizeBytes = typeof blocks === "number" ? blocks * 512 : s.size;
  } catch {
    // ignore
  }

  if (!existsSync(metaPath)) {
    // Legacy / hand-baked image (e.g. ubuntu-25.10-base from bake script).
    // Synthesize a minimal record so list/info don't lie.
    return {
      name,
      from_well: null,
      from_disk_size: null,
      created_at: "unknown",
      ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
    };
  }

  const raw = JSON.parse(await readFile(metaPath, "utf-8")) as ImageMeta;
  return { ...raw, ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}) };
}

export async function listImages(): Promise<ImageMeta[]> {
  const root = PATHS.images();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: ImageMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await imageMeta(e.name);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface SaveOptions {
  fromWell: string;
  imageName: string;
  notes?: string;
}

// Clone a stopped well's bundle disk into the image store. Caller's
// responsibility to ensure the well isn't running — saveImage doesn't
// peek at lume, because the call site already knows (the daemon route
// checks status before invoking). Returns the saved image's meta.
export async function saveImage(opts: SaveOptions): Promise<ImageMeta> {
  validateImageName(opts.imageName);

  if (await imageExists(opts.imageName)) {
    throw new Error(`image '${opts.imageName}' already exists — rm it first`);
  }

  const record = await findWell(opts.fromWell);
  if (!record) {
    throw new Error(`source well '${opts.fromWell}' not found`);
  }

  const srcDisk = bundleDiskPath(opts.fromWell);
  if (!existsSync(srcDisk)) {
    throw new Error(`source well '${opts.fromWell}' has no bundle disk at ${srcDisk}`);
  }

  const dir = PATHS.imageDir(opts.imageName);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const dstDisk = imageDiskPath(opts.imageName);
  await clonefile(srcDisk, dstDisk);

  const meta: ImageMeta = {
    name: opts.imageName,
    from_well: opts.fromWell,
    from_disk_size: record.disk_size,
    created_at: new Date().toISOString(),
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
  await writeFile(imageMetaPath(opts.imageName), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });

  // Fold in size_bytes from the freshly cloned disk.
  return (await imageMeta(opts.imageName))!;
}

export async function removeImage(name: string): Promise<boolean> {
  validateImageName(name);
  const dir = PATHS.imageDir(name);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
