// Destroy a splite: stop the VM if it's running, drop the lume bundle,
// remove ~/.splites/vms/<n>/, deregister from the registry. Idempotent —
// missing pieces are fine, we just don't claim to have removed them.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { findSplite, removeSplite } from "./registry.ts";
import { stopSplite } from "./lifecycle.ts";
import { PATHS } from "./state.ts";
import { LumeClient } from "../engine/lume.ts";
import { bundleDir } from "../engine/bundle.ts";

export interface DestroyResult {
  found: boolean;
  removedRegistry: boolean;
  removedStateDir: boolean;
  removedBundle: boolean;
}

export async function destroySplite(name: string): Promise<DestroyResult> {
  const record = await findSplite(name);

  const lume = new LumeClient();
  const lumeInfo = await lume.info(name).catch(() => null);

  if (lumeInfo && lumeInfo.status !== "stopped") {
    await stopSplite(name).catch(() => {});
  }

  let removedBundle = false;
  if (lumeInfo) {
    await lume.delete(name).catch(() => {});
    removedBundle = true;
  } else if (existsSync(bundleDir(name))) {
    // Stale bundle from a failed create, lume doesn't know about it.
    await rm(bundleDir(name), { recursive: true, force: true });
    removedBundle = true;
  }

  let removedStateDir = false;
  const vmDir = PATHS.vmDir(name);
  if (existsSync(vmDir)) {
    await rm(vmDir, { recursive: true, force: true });
    removedStateDir = true;
  }

  const removedRegistry = await removeSplite(name);

  return {
    found:
      record !== undefined ||
      lumeInfo !== null ||
      removedStateDir ||
      removedRegistry,
    removedRegistry,
    removedStateDir,
    removedBundle,
  };
}
