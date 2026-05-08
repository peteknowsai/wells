// Path helpers for lume's VM bundle layout.
//
// Empirically (lume v0.3.9 / API v1.0.0), each VM bundle is a directory
// under lume's storage location (default: ~/.lume/<name>/) containing:
//   config.json  — VM config (os, cpu, memory, diskSize, mac, network, display)
//   disk.img     — raw sparse disk file
//   nvram.bin    — Apple Virtualization.framework NVRAM
//
// Wells's orchestrator clonefiles its cloud-image.img into the disk.img
// position after create, then boots with cidata.iso attached.

import { homedir } from "node:os";
import { join } from "node:path";

export function lumeStorageRoot(): string {
  return process.env.WELL_LUME_STORAGE ?? join(homedir(), ".lume");
}

export function bundleDir(name: string): string {
  return join(lumeStorageRoot(), name);
}

export function bundleDiskPath(name: string): string {
  return join(bundleDir(name), "disk.img");
}

export function bundleConfigPath(name: string): string {
  return join(bundleDir(name), "config.json");
}

export function bundleNvramPath(name: string): string {
  return join(bundleDir(name), "nvram.bin");
}
