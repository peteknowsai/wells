// Capture the device manifest at hibernate time and validate it at
// wake time. VZ's `restoreMachineStateFrom` rejects with cryptic
// errors if the VZVirtualMachine config drifts from what was saved.
//
// B.0.9.d.4 invariant: cidata is birth media only. Hibernation only
// operates on disk-only steady-state VMs. The recipe captures that
// contract:
//   - mount_path must be null at hibernate time
//   - storage_device_count is 1 (root disk only)
// Wake validates both before calling VZ.
//
// Source of truth for VM hardware shape is lume's `~/.lume/<n>/
// config.json`. Wells's runtime.json owns the steady_state_mount.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

// Hash the steady-state bundle shape. Any change to hardware shape
// OR mount state bumps the hash. Wake compares against the saved
// recipe; mismatch = refuse.
export function computeConfigHash(
  config: LumeConfig,
  mountPath: string | null,
  storageDeviceCount: number,
): string {
  const canonical = JSON.stringify({
    networkMode: config.networkMode,
    cpuCount: config.cpuCount,
    diskSize: config.diskSize,
    os: config.os,
    display: config.display,
    memorySize: config.memorySize,
    macAddress: config.macAddress,
    mountPath,
    storageDeviceCount,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Build a recipe from current bundle state. Called at hibernate time
// for sealed (disk-only) wells. Caller (hibernateWell) gates on
// runtime.hibernate_ready before invoking this.
export async function captureRestoreRecipe(
  name: string,
): Promise<RestoreRecipe> {
  const cfg = await readLumeConfig(name);
  if (cfg.cpuCount === undefined || cfg.memorySize === undefined) {
    throw new Error(
      `lume config for '${name}' missing cpuCount or memorySize`,
    );
  }
  if (cfg.macAddress === undefined) {
    throw new Error(`lume config for '${name}' missing macAddress`);
  }
  // Disk-only steady state: 1 storage device (root disk), no mount.
  const mountPath: string | null = null;
  const storageDeviceCount = 1;
  return {
    mount_path: mountPath,
    storage_device_count: storageDeviceCount,
    cpu_count: cfg.cpuCount,
    memory_bytes: cfg.memorySize,
    display: cfg.display ?? "1024x768",
    mac_address: cfg.macAddress,
    config_hash: computeConfigHash(cfg, mountPath, storageDeviceCount),
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
  if (saved.mount_path !== null) {
    return `mount_path drift: hibernate-time saved=${saved.mount_path} but disk-only contract requires null. Re-create the well to seal it.`;
  }
  if (saved.storage_device_count !== 1) {
    return `storage_device_count drift: saved=${saved.storage_device_count} but disk-only contract requires 1`;
  }
  if (cfg.cpuCount !== saved.cpu_count) {
    return `cpu_count drift: saved=${saved.cpu_count} now=${cfg.cpuCount}`;
  }
  if (cfg.memorySize !== saved.memory_bytes) {
    return `memory_bytes drift: saved=${saved.memory_bytes} now=${cfg.memorySize}`;
  }
  if (cfg.macAddress !== saved.mac_address) {
    return `mac_address drift: saved=${saved.mac_address} now=${cfg.macAddress}`;
  }
  const currentHash = computeConfigHash(cfg, null, 1);
  if (currentHash !== saved.config_hash) {
    return `config_hash drift: saved=${saved.config_hash.slice(0, 12)} now=${currentHash.slice(0, 12)}`;
  }
  return null;
}
