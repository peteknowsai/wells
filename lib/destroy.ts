// Destroy a well: stop the VM if it's running, drop the lume bundle,
// remove ~/.wells/vms/<n>/, deregister from the registry. Idempotent —
// missing pieces are fine, we just don't claim to have removed them.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { findWell, lumeNameOf, removeWell } from "./registry.ts";
import { stopWell } from "./lifecycle.ts";
import { closeSshControl } from "./sshControl.ts";
import { releaseLeaseBestEffort } from "./dhcpHelper.ts";
import { PATHS } from "./state.ts";
import { LumeClient } from "../engine/vwell.ts";
import { bundleDir } from "../engine/bundle.ts";
import { log } from "./log.ts";

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

  // Release the vmnet DHCP lease so the IP can be reissued. macOS
  // bootpd never GCs /var/db/dhcpd_leases on its own — every destroyed
  // well otherwise leaves a zombie that eventually exhausts the pool
  // (cells team 2026-05-11). Best-effort: if the privileged helper
  // isn't installed (scripts/install-dhcp-helper.sh), this is a no-op
  // and welld logs once. The lume bundle name is what bootpd recorded;
  // for pool-adopted wells that's the pool-XXXX name, not the operator
  // name.
  await releaseLeaseBestEffort(lumeName);

  // Service definitions live outside the vm dir and used to survive the
  // well (cells found an orphaned ~/.wells/services/egg-22f6bb after its
  // well was gone, 2026-06-11). A destroyed well's defs have no consumer —
  // a recreate with the same name registers fresh ones.
  const svcDir = PATHS.wellServicesDir(name);
  if (existsSync(svcDir)) {
    await rm(svcDir, { recursive: true, force: true });
  }

  const removedRegistry = await removeWell(name);

  // Destroys were the one lifecycle transition with no log line — an
  // operator diffing the fleet against the journal couldn't tell a destroy
  // from a record desync (cells chased exactly that ghost, 2026-06-11).
  log.info("destroyWell: destroyed", {
    name,
    lume_name: lumeName,
    removed_bundle: removedBundle,
    removed_registry: removedRegistry,
  });

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
