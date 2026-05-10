// Well registry — JSON file at ~/.wells/registry.json. Source of truth
// for which wells exist on this host. Lume holds VM-runtime state; this
// holds wells-level metadata (created_at, sizing, etc.).

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./state.ts";

// `auth` is the per-well URL access mode. "well" = require Bearer token
// on the public proxy (private). "public" = no auth on the proxy (the
// well's own app server gates whatever it cares about). Required on
// every record; createWell sets it explicitly.
export type WellAuth = "public" | "well";

// R2 / S3-compatible credentials for cold-tier checkpoint sync. Per-well
// because cells's worker plans to mint scoped keys per cell. Keys live in
// the registry next to the rest of the well's metadata; consider them
// secret material — file mode 0600.
export interface R2Config {
  endpoint: string;       // e.g. https://<accountid>.r2.cloudflarestorage.com
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

export interface WellRecord {
  name: string;
  uuid: string;
  created_at: string;
  cpu: number;
  memory: string;
  disk_size: string;
  auth: WellAuth;
  // Per-well override on the autosleep timeout. undefined = use global
  // default (`auto_sleep_seconds` in defaults.json). null = never sleep.
  // Number = sleep after that many seconds idle.
  auto_sleep_seconds?: number | null;
  r2?: R2Config;
  // Stable IP from welld's pinned range (192.168.64.100-249) when set.
  // Cells with pinned_ip skip DHCP entirely — cidata writes a static
  // netplan with this IP. Pre-pinning wells (cells-1..5 created before
  // Lever 3) leave this undefined and continue resolving via DHCP.
  pinned_ip?: string;
  // Lowercase MAC of the well's primary virtual NIC (e.g.
  // "fe:e8:4c:5d:bf:b9"). Read from lume's config.json at create
  // time. Used by lib/dhcp.ts as a substrate-level identifier:
  // wells with `dhcp-identifier: mac` in their netplan get leases
  // recorded as "01,<mac>" in /var/db/dhcpd_leases, so we can
  // resolve IP without depending on cloud-init's hostname. Pre-MAC
  // wells leave this undefined and fall back to hostname matching.
  mac_address?: string;
  // The lume bundle's directory name when it diverges from `name`.
  // For wells created via the fresh-create path, the lume bundle
  // directory is `~/.lume/<name>/` — `lume_name` is undefined and
  // callers fall through to `name`. For wells adopted from the
  // pre-warmed pool (A.1.4), the lume bundle keeps its `pool-XXXX`
  // identity because Apple's VZ saved-state encodes absolute paths
  // (nvram.bin, disk attachments) that would break if the bundle
  // dir were renamed. See docs/findings-pool-adopt-bundle-rename.md.
  // All lume API calls and lume-config reads must resolve this
  // (use `resolveLumeName(name)`); DHCP/SSH/proxy layers key by IP
  // and are unaffected.
  lume_name?: string;
}

export async function updateWellAuth(
  name: string,
  auth: WellAuth,
): Promise<WellRecord | undefined> {
  const reg = await loadRegistry();
  const rec = reg.wells.find((s) => s.name === name);
  if (!rec) return undefined;
  rec.auth = auth;
  await saveRegistry(reg);
  return rec;
}

export async function updateWellAutoSleep(
  name: string,
  autoSleepSeconds: number | null,
): Promise<WellRecord | undefined> {
  const reg = await loadRegistry();
  const rec = reg.wells.find((s) => s.name === name);
  if (!rec) return undefined;
  rec.auto_sleep_seconds = autoSleepSeconds;
  await saveRegistry(reg);
  return rec;
}

interface Registry {
  wells: WellRecord[];
}

export async function loadRegistry(): Promise<Registry> {
  const path = PATHS.registry();
  if (!existsSync(path)) return { wells: [] };
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}

export async function saveRegistry(reg: Registry): Promise<void> {
  const path = PATHS.registry();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function findWell(name: string): Promise<WellRecord | undefined> {
  const reg = await loadRegistry();
  return reg.wells.find((s) => s.name === name);
}

export async function addWell(record: WellRecord): Promise<void> {
  const reg = await loadRegistry();
  if (reg.wells.some((s) => s.name === record.name)) {
    throw new Error(`well '${record.name}' already exists in registry`);
  }
  reg.wells.push(record);
  await saveRegistry(reg);
}

export async function removeWell(name: string): Promise<boolean> {
  const reg = await loadRegistry();
  const before = reg.wells.length;
  reg.wells = reg.wells.filter((s) => s.name !== name);
  if (reg.wells.length === before) return false;
  await saveRegistry(reg);
  return true;
}

export async function listWells(): Promise<WellRecord[]> {
  const reg = await loadRegistry();
  return reg.wells;
}

// Resolve the operator-facing well name to the lume bundle's
// directory name. For fresh-create wells these match; for pool-
// adopted wells the lume bundle keeps its stable `pool-XXXX` name
// (see WellRecord.lume_name). Returns the input unchanged when no
// matching record exists, so callers don't need to special-case
// pre-registry lookups (e.g. createWell's pre-add path).
export async function resolveLumeName(wellName: string): Promise<string> {
  const rec = await findWell(wellName);
  return rec?.lume_name ?? wellName;
}

// Pure variant — preferred when the caller already has the record
// in hand, avoids a redundant registry read.
export function lumeNameOf(record: WellRecord): string {
  return record.lume_name ?? record.name;
}
