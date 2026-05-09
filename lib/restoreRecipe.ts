// Capture the device manifest at hibernate time and validate it at
// wake time. VZ's `restoreMachineStateFrom` rejects with cryptic
// errors if the VZVirtualMachine config drifts from what was saved
// — disk path changes, mount path changes, CPU/memory differs,
// network mode flips, etc. The fix: snapshot the recipe at
// hibernate, refuse the wake if anything moved.
//
// Source of truth for VM hardware shape is lume's `~/.lume/<n>/
// config.json`. Cidata path is owned by wells (PATHS.vmCidata).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./state.ts";
import type { RestoreRecipe } from "./wellRuntime.ts";

interface LumeConfig {
  networkMode?: string;
  cpuCount?: number;
  diskSize?: number;
  os?: string;
  display?: string;
  memorySize?: number;
  macAddress?: string;
}

function lumeConfigPath(name: string): string {
  return join(homedir(), ".lume", name, "config.json");
}

async function readLumeConfig(name: string): Promise<LumeConfig> {
  const p = lumeConfigPath(name);
  if (!existsSync(p)) {
    throw new Error(`lume config missing for '${name}': ${p}`);
  }
  const text = await readFile(p, "utf-8");
  return JSON.parse(text) as LumeConfig;
}

// Hash the bundle config + cidata path together. Any change to
// hardware shape OR mount path bumps the hash. Wake compares the
// hash from the saved recipe against the current bundle's hash;
// mismatch = refuse.
export function computeConfigHash(
  config: LumeConfig,
  cidataPath: string,
): string {
  const canonical = JSON.stringify({
    networkMode: config.networkMode,
    cpuCount: config.cpuCount,
    diskSize: config.diskSize,
    os: config.os,
    display: config.display,
    memorySize: config.memorySize,
    macAddress: config.macAddress,
    cidataPath,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Build a recipe from current bundle state. Called at hibernate time;
// the result gets persisted in WellRuntime.restore_recipe.
export async function captureRestoreRecipe(
  name: string,
): Promise<RestoreRecipe> {
  const cfg = await readLumeConfig(name);
  const cidataPath = PATHS.vmCidata(name);
  if (cfg.cpuCount === undefined || cfg.memorySize === undefined) {
    throw new Error(
      `lume config for '${name}' missing cpuCount or memorySize`,
    );
  }
  return {
    cidata_path: cidataPath,
    cpu_count: cfg.cpuCount,
    memory_bytes: cfg.memorySize,
    display: cfg.display ?? "1024x768",
    config_hash: computeConfigHash(cfg, cidataPath),
  };
}

// Compare a saved recipe against current bundle state. Returns null
// if drift-free (safe to wake), or a human-readable description of
// the first drift detected. Caller routes drift wells to
// error_orphaned and writes last_error.
export async function validateRestoreRecipe(
  name: string,
  saved: RestoreRecipe,
): Promise<string | null> {
  const cfg = await readLumeConfig(name);
  const currentCidata = PATHS.vmCidata(name);
  if (currentCidata !== saved.cidata_path) {
    return `cidata path drift: saved=${saved.cidata_path} now=${currentCidata}`;
  }
  if (cfg.cpuCount !== saved.cpu_count) {
    return `cpu_count drift: saved=${saved.cpu_count} now=${cfg.cpuCount}`;
  }
  if (cfg.memorySize !== saved.memory_bytes) {
    return `memory_bytes drift: saved=${saved.memory_bytes} now=${cfg.memorySize}`;
  }
  const currentHash = computeConfigHash(cfg, currentCidata);
  if (currentHash !== saved.config_hash) {
    return `config_hash drift: saved=${saved.config_hash.slice(0, 12)} now=${currentHash.slice(0, 12)}`;
  }
  return null;
}
