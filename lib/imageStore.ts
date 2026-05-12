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
import { findWell, lumeNameOf } from "./registry.ts";
import { bundleDiskPath } from "../engine/bundle.ts";

// Image names are lowercase alphanumeric with hyphens and dots — the dot
// is intentional so canonical baked names like `ubuntu-25.10-base` are
// valid. Well names stay narrower (no dots) since they flow through DNS
// subdomain paths; images don't. No leading/trailing dot or hyphen.
const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;

export function validateImageName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid image name '${name}': must be lowercase alphanumeric + hyphens + dots, 1–63 chars, no leading/trailing hyphen or dot`,
    );
  }
}

// Bump CURRENT_IMAGE_CONTRACT_VERSION when the wire-level expectations
// between a saved image and a fresh fork's cidata change. Past examples:
//   v1 (2026-05-08) — first-class versioning. Saves stamped from now
//                     on. Older images decode as `image_contract_version
//                     === undefined` and are treated as v0 (potentially
//                     `cloud-init clean`-rinsed by cells's old bake;
//                     `createWell` refuses --from-image for those).
export const CURRENT_IMAGE_CONTRACT_VERSION = 1;

export interface ImageMeta {
  name: string;
  from_well: string | null;   // null for the prebuilt base
  from_disk_size: string | null;
  created_at: string;
  notes?: string;
  size_bytes?: number;        // physical bytes on disk (best-effort)
  // Stamp at save time so create-from-image can reject incompatible
  // saves before booting the fork. Required on every well-saved or
  // bake-script-baked image; absent meta.json = malformed image.
  image_contract_version: number;
  // Welld version that produced the image. Pure diagnostic — don't
  // gate on it. Useful when triaging a working/failing fork report.
  saved_with_welld_version?: string;
  // True when the image has been rinsed before save: machine-id wiped,
  // /etc/.well-ready cleared, networkd state cleared, ssh host keys
  // removed. Forks from a rinsed image regenerate everything via
  // well-firstboot, so DHCP DUID collisions can't happen and the
  // first-boot identity injection runs cleanly.
  // (Pre-2026-05-09 semantics: this field meant "cloud-init was
  // clean'd, forks will fail" — the old refusal was reversed once
  // cloud-init was purged from the substrate. The field is now a
  // positive signal: rinsed=true means fork-ready.)
  rinsed?: boolean;
  // W.72: true when the baked guest's well-firstboot.sh understands
  // WELL_STATIC_IP_CIDR + WELL_GATEWAY + WELL_NAMESERVERS and writes
  // a static netplan on first boot. createWell skips static-IP
  // allocation for images that lack this flag (falls back to DHCP)
  // so a stale layered image — e.g. cell-base baked from a pre-W.72
  // ubuntu-base — doesn't deadlock waiting for SSH on a pinned IP
  // the guest never moves to. Set by the bake script for the base
  // image; saveImage propagates true when the source well itself
  // carried a pinned_ip stamp.
  firstboot_supports_static_ip?: boolean;
}

export function imageDiskPath(name: string): string {
  return join(PATHS.imageDir(name), "disk.img");
}

function imageMetaPath(name: string): string {
  return join(PATHS.imageDir(name), "meta.json");
}

// Alias registry. `~/.wells/images/aliases.json` maps a mutable alias
// (e.g. `ubuntu-base`) to the concrete image it currently points at
// (e.g. `ubuntu-25.10-base`). Cells consumes the alias by default so
// `cells birth --from-image=ubuntu-base` keeps working when wells
// re-bakes to a new immutable name. The bake script flips the alias
// atomically post-bake; immutable tags remain addressable for callers
// that want reproducibility.
//
// Resolution is single-level — an alias must point at a concrete image
// (no alias-of-alias). Validated on setAlias.
function aliasesPath(): string {
  return join(PATHS.images(), "aliases.json");
}

interface AliasRegistry {
  aliases: Record<string, string>;
}

async function readAliasRegistry(): Promise<AliasRegistry> {
  const path = aliasesPath();
  if (!existsSync(path)) return { aliases: {} };
  try {
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<AliasRegistry>;
    return { aliases: parsed.aliases ?? {} };
  } catch {
    return { aliases: {} };
  }
}

async function writeAliasRegistry(reg: AliasRegistry): Promise<void> {
  const path = aliasesPath();
  await mkdir(PATHS.images(), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

// Resolve an image name through the alias registry. Returns the
// concrete target when `name` is an alias, otherwise returns `name`
// unchanged. Single-level lookup — never recurses.
export async function resolveImageName(name: string): Promise<string> {
  const reg = await readAliasRegistry();
  return reg.aliases[name] ?? name;
}

// Pin an alias to a concrete image. Target must already exist on disk.
// Refuses to point at another alias (single-level rule).
export async function setAlias(alias: string, target: string): Promise<void> {
  validateImageName(alias);
  validateImageName(target);
  const reg = await readAliasRegistry();
  if (reg.aliases[target] !== undefined) {
    throw new Error(
      `alias target '${target}' is itself an alias; aliases must point at concrete images`,
    );
  }
  if (!existsSync(imageDiskPath(target))) {
    throw new Error(`alias target '${target}' does not exist on disk`);
  }
  reg.aliases[alias] = target;
  await writeAliasRegistry(reg);
}

export async function removeAlias(alias: string): Promise<boolean> {
  const reg = await readAliasRegistry();
  if (reg.aliases[alias] === undefined) return false;
  delete reg.aliases[alias];
  await writeAliasRegistry(reg);
  return true;
}

export async function listAliases(): Promise<Record<string, string>> {
  return (await readAliasRegistry()).aliases;
}

export async function imageExists(name: string): Promise<boolean> {
  const resolved = await resolveImageName(name);
  return existsSync(imageDiskPath(resolved));
}

export async function imageMeta(name: string): Promise<ImageMeta | null> {
  const resolved = await resolveImageName(name);
  if (!existsSync(imageDiskPath(resolved))) return null;
  const metaPath = imageMetaPath(resolved);

  // Best-effort physical size — useful for `well image list` output.
  let sizeBytes: number | undefined;
  try {
    const s = await stat(imageDiskPath(resolved));
    const blocks = (s as unknown as { blocks?: number }).blocks;
    sizeBytes = typeof blocks === "number" ? blocks * 512 : s.size;
  } catch {
    // ignore
  }

  if (!existsSync(metaPath)) {
    // No meta.json = unstamped image. Bake script + saveImage both
    // write meta; an image dir without one is malformed. Return
    // null so callers (list, createWell) can treat it as "missing
    // contract" and refuse to fork from it.
    return null;
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
  // Stamp `rinsed: true` in the saved image's meta. Set when the
  // caller has run rinseGuest before clonefile (welld's validate+rinse
  // path). Direct saves leave rinsed undefined → forks proceed but
  // get the OLD failure mode (DUID collision). Cells team gets a hint
  // via meta when triaging fork failures.
  rinsed?: boolean;
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

  const srcDisk = bundleDiskPath(lumeNameOf(record));
  if (!existsSync(srcDisk)) {
    throw new Error(`source well '${opts.fromWell}' has no bundle disk at ${srcDisk}`);
  }

  const dir = PATHS.imageDir(opts.imageName);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const dstDisk = imageDiskPath(opts.imageName);
  await clonefile(srcDisk, dstDisk);

  // W.72: a saved image inherits "supports static IP" from its source
  // well. The well's record carries pinned_ip iff it was created via
  // the W.72 path — which means its disk has the W.72-aware firstboot
  // baked in. Cells's cmdBake doesn't need to pass anything extra; the
  // signal is structural.
  const supportsStaticIp = record.pinned_ip !== undefined;

  const meta: ImageMeta = {
    name: opts.imageName,
    from_well: opts.fromWell,
    from_disk_size: record.disk_size,
    created_at: new Date().toISOString(),
    image_contract_version: CURRENT_IMAGE_CONTRACT_VERSION,
    saved_with_welld_version: process.env.WELL_VERSION ?? "0.1.0-pre",
    rinsed: opts.rinsed ?? false,
    firstboot_supports_static_ip: supportsStaticIp,
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
