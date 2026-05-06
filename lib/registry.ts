// Splite registry — JSON file at ~/.splites/registry.json. Source of truth
// for which splites exist on this host. Lume holds VM-runtime state; this
// holds splites-level metadata (created_at, sizing, etc.).

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./state.ts";

export interface SpliteRecord {
  name: string;
  uuid: string;
  created_at: string;
  cpu: number;
  memory: string;
  disk_size: string;
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
