// Splite registry — JSON file at ~/.splites/registry.json. Source of truth
// for which splites exist on this host. Lume holds VM-runtime state; this
// holds splites-level metadata (created_at, sizing, etc.).

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./state.ts";

// `auth` is the per-splite URL access mode. "splite" = require Bearer token
// on the public proxy (private). "public" = no auth on the proxy (the
// splite's own app server gates whatever it cares about).
//
// Backward compat: an undefined `auth` on an existing record is treated as
// "public" — Pete's pre-Phase-10 splites stay reachable without surprise
// 401s. New splites created post-10 default to "splite" via createSplite.
export type SpliteAuth = "public" | "splite";

export interface SpliteRecord {
  name: string;
  uuid: string;
  created_at: string;
  cpu: number;
  memory: string;
  disk_size: string;
  auth?: SpliteAuth;
  // Per-splite override on the autosleep timeout. undefined = use global
  // default (`auto_sleep_seconds` in defaults.json). null = never sleep.
  // Number = sleep after that many seconds idle.
  auto_sleep_seconds?: number | null;
}

export async function updateSpliteAuth(
  name: string,
  auth: SpliteAuth,
): Promise<SpliteRecord | undefined> {
  const reg = await loadRegistry();
  const rec = reg.splites.find((s) => s.name === name);
  if (!rec) return undefined;
  rec.auth = auth;
  await saveRegistry(reg);
  return rec;
}

export async function updateSpliteAutoSleep(
  name: string,
  autoSleepSeconds: number | null,
): Promise<SpliteRecord | undefined> {
  const reg = await loadRegistry();
  const rec = reg.splites.find((s) => s.name === name);
  if (!rec) return undefined;
  rec.auto_sleep_seconds = autoSleepSeconds;
  await saveRegistry(reg);
  return rec;
}

interface Registry {
  splites: SpliteRecord[];
}

export async function loadRegistry(): Promise<Registry> {
  const path = PATHS.registry();
  if (!existsSync(path)) return { splites: [] };
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

export async function findSplite(name: string): Promise<SpliteRecord | undefined> {
  const reg = await loadRegistry();
  return reg.splites.find((s) => s.name === name);
}

export async function addSplite(record: SpliteRecord): Promise<void> {
  const reg = await loadRegistry();
  if (reg.splites.some((s) => s.name === record.name)) {
    throw new Error(`splite '${record.name}' already exists in registry`);
  }
  reg.splites.push(record);
  await saveRegistry(reg);
}

export async function removeSplite(name: string): Promise<boolean> {
  const reg = await loadRegistry();
  const before = reg.splites.length;
  reg.splites = reg.splites.filter((s) => s.name !== name);
  if (reg.splites.length === before) return false;
  await saveRegistry(reg);
  return true;
}

export async function listSplites(): Promise<SpliteRecord[]> {
  const reg = await loadRegistry();
  return reg.splites;
}
