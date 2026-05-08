// Destroy a well: stop the VM if it's running, drop the lume bundle,
// remove ~/.wells/vms/<n>/, deregister from the registry. Idempotent —
// missing pieces are fine, we just don't claim to have removed them.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { findWell, removeWell } from "./registry.ts";
import { stopWell } from "./lifecycle.ts";
import { closeSshControl } from "./sshControl.ts";
import { PATHS } from "./state.ts";
import { LumeClient } from "../engine/lume.ts";
import { bundleDir } from "../engine/bundle.ts";

export interface DestroyResult {
  found: boolean;
  removedRegistry: boolean;
  removedStateDir: boolean;
  removedBundle: boolean;
}

export async function destroyWell(name: string): Promise<DestroyResult> {
  const record = await findWell(name);

  const lume = new LumeClient();
  const lumeInfo = await lume.info(name).catch(() => null);

  if (lumeInfo && lumeInfo.status !== "stopped") {
    await stopWell(name).catch(() => {});
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

  // Close any leftover SSH control socket. stopWell already does this
  // for the running case; this catches the bundle-is-gone-but-socket-
  // remains case too.
  await closeSshControl({ name });

  const removedRegistry = await removeWell(name);

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
