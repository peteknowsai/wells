// State paths and dir helpers. Default root is ~/.wells/.
// Set WELL_STATE_DIR to override (used by tests).

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export function stateRoot(): string {
  return process.env.WELL_STATE_DIR ?? join(homedir(), ".wells");
}

export const PATHS = {
  root: () => stateRoot(),
  token: () => join(stateRoot(), "token"),
  registry: () => join(stateRoot(), "registry.json"),
  images: () => join(stateRoot(), "images"),
  imageDir: (name: string) => join(stateRoot(), "images", name),
  vms: () => join(stateRoot(), "vms"),
  vmDir: (name: string) => join(stateRoot(), "vms", name),
  vmDisk: (name: string) => join(stateRoot(), "vms", name, "disk.img"),
  vmMeta: (name: string) => join(stateRoot(), "vms", name, "meta.json"),
  vmSshKey: (name: string) => join(stateRoot(), "vms", name, "ssh_key"),
  vmSshHostKey: (name: string) => join(stateRoot(), "vms", name, "ssh_host_key"),
  vmCheckpoints: (name: string) => join(stateRoot(), "vms", name, "checkpoints"),
  vmCheckpoint: (name: string, id: string) =>
    join(stateRoot(), "vms", name, "checkpoints", id),
  vmPolicy: (name: string) => join(stateRoot(), "vms", name, "policy.json"),
  services: () => join(stateRoot(), "services"),
  wellServicesDir: (well: string) =>
    join(stateRoot(), "services", well),
  serviceFile: (well: string, id: string) =>
    join(stateRoot(), "services", well, `${id}.json`),
};

export async function ensureStateDirs(): Promise<void> {
  await Promise.all([
    mkdir(PATHS.root(), { recursive: true, mode: 0o700 }),
    mkdir(PATHS.images(), { recursive: true, mode: 0o700 }),
    mkdir(PATHS.vms(), { recursive: true, mode: 0o700 }),
    mkdir(PATHS.services(), { recursive: true, mode: 0o700 }),
  ]);
}

export async function ensureVmDir(name: string): Promise<string> {
  const d = PATHS.vmDir(name);
  await mkdir(d, { recursive: true, mode: 0o700 });
  await mkdir(PATHS.vmCheckpoints(name), { recursive: true, mode: 0o700 });
  return d;
}
