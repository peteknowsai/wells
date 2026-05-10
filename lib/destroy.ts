// Destroy a well: stop the VM if it's running, drop the lume bundle,
// remove ~/.wells/vms/<n>/, deregister from the registry. Idempotent —
// missing pieces are fine, we just don't claim to have removed them.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { findWell, lumeNameOf, removeWell } from "./registry.ts";
import { stopWell } from "./lifecycle.ts";
import { closeSshControl } from "./sshControl.ts";
import { PATHS } from "./state.ts";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDir } from "../engine/bundle.ts";

export interface DestroyResult {
  found: boolean;
  removedRegistry: boolean;
  removedStateDir: boolean;
  removedBundle: boolean;
}

export async function destroyWell(name: string): Promise<DestroyResult> {
  const record = await findWell(name);
  // Pool-adopted wells keep their `pool-XXXX` lume bundle name across
  // adoption (see WellRecord.lume_name + findings-pool-adopt-bundle-rename).
  // Use the record's lume name when present so we delete the right
  // lume bundle. Fall back to `name` for fresh-create wells and for
  // stale-bundle cleanup paths where no record exists.
  const lumeName = record ? lumeNameOf(record) : name;

  const lume = new LumeClient();
  const lumeInfo = await lume.info(lumeName).catch(() => null);

  if (lumeInfo && lumeInfo.status !== "stopped") {
    await stopWell(name).catch(() => {});
  }

  let removedBundle = false;
  if (lumeInfo) {
    await lume.delete(lumeName).catch(() => {});
    removedBundle = true;
  } else if (existsSync(bundleDir(lumeName))) {
    // Stale bundle from a failed create, lume doesn't know about it.
    await rm(bundleDir(lumeName), { recursive: true, force: true });
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
