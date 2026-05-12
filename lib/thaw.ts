// Thaw — wells's verb for "given one hibernated bundle, materialize a
// new running VM from it." Single-thaw. Multi-thaw is the same primitive
// called N times sequentially through the module-level mutex.
//
// Why a mutex: empirically, lume can't handle ≥ 2 concurrent
// `restoreMachineStateFrom` calls — even 2 simultaneous calls crash
// lume serve (supervisor respawns, but the in-flight thaws are lost).
// See docs/findings-thaw.md Phase 2 for the bisection. The hard
// constraint is concurrency = 1; this mutex enforces it on the wells
// side so callers can `Promise.all` if they want without breaking lume.
//
// What thaw does NOT do (yet):
//   - **Identity rinse.** machine-id, ssh host keys, etc. all match
//     src's. Cells team's egg use case is "ephemeral cells" so this
//     is fine; if a thaw is meant to run for any duration, caller
//     should rinse identity post-thaw.
//   - **MAC mutation.** Tested 2026-05-10: changing `config.json.macAddress`
//     before restoreState makes VZ reject with "invalid argument" — the
//     MAC is part of the saved-state contract VZ validates at restore.
//     For now: thaw inherits src's MAC verbatim. Concurrent running of
//     multiple thaws from the same hibernate.bin will collide on
//     vmnet's DHCP lease table. Workable use case: "destroy old before
//     creating new" (cells's egg-pop). Concurrent multi-thaw needs a
//     post-restore guest-side MAC change (`ip link set address` +
//     dhclient renew) — follow-up.
//
// What thaw DOES:
//   1. Copy src bundle's `config.json`, `nvram.bin`, `disk.img`, and
//      `hibernate.bin` into a new bundle (v4 full-mirror — what VZ's
//      restoreMachineStateFrom requires to accept).
//   2. Register the new well in welld's registry (so lume sees it).
//   3. Stop the new well so its disk is released for VZ to attach.
//   4. Issue lume.restoreState against the new well's bundle.
//   5. Wait for status=running, return the new well's info.

import { copyFile, readFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LumeClient } from "../engine/vwell.ts";
import { findWell, addWell, type WellRecord } from "./registry.ts";
import { readRuntime, writeRuntime, defaultRuntime } from "./wellRuntime.ts";
import { PATHS } from "./state.ts";
import { bundleDir } from "../engine/bundle.ts";
import { log } from "./log.ts";

// generateMac kept exported for the future post-thaw guest-side MAC
// change path (out of scope this fire). First-byte format: bit0=0
// (unicast), bit1=1 (locally-administered). 0x02 (00000010) is the
// canonical "I made this up" prefix — vmnet honors it as a normal
// client MAC. 5 random bytes = 2^40 addresses; collision risk negligible.
export function generateMac(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = 0x02;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(":");
}

// Module-level promise chain that serializes thaw calls. Each call awaits
// the previous one before issuing its own lume.restoreState. Different
// callers can `await thawFrom(...)` in parallel; the actual lume work
// runs one at a time.
let thawChain: Promise<unknown> = Promise.resolve();

export interface ThawOptions {
  // Source well (must be in `hibernating` state with a hibernate.bin
  // file on disk).
  srcName: string;
  // Name for the new (thawed) well. Must be unique in the wells
  // registry — same naming rules as `well create`.
  newName: string;
  // Optional override for the lume client (tests use a stub).
  lume?: Pick<LumeClient, "delete" | "info" | "restoreState" | "stop" | "waitForStatus">;
}

export interface ThawResult {
  name: string;
  uuid: string;
  ip: string;
  bundleDir: string;
  hibernatePath: string;
}

export async function thawFrom(opts: ThawOptions): Promise<ThawResult> {
  // Sequence-tail this call onto the chain. Each caller waits for the
  // previous chain element to settle (success or failure — we don't
  // want a thrown error to permanently break the chain) before its own
  // body runs.
  const next = thawChain
    .catch(() => undefined)
    .then(() => doThawFrom(opts));
  thawChain = next;
  return next;
}

async function doThawFrom(opts: ThawOptions): Promise<ThawResult> {
  const { srcName, newName } = opts;
  const lume = opts.lume ?? new LumeClient();

  // Validate source: must exist in registry and be hibernating with a
  // hibernate.bin file on disk.
  const srcRecord = await findWell(srcName);
  if (!srcRecord) {
    throw new Error(`thaw: source well '${srcName}' not found`);
  }
  const srcRuntime = await readRuntime(srcName);
  if (srcRuntime?.state !== "hibernating") {
    throw new Error(
      `thaw: source well '${srcName}' is in state '${srcRuntime?.state ?? "unknown"}', need 'hibernating'`,
    );
  }
  const srcHibernate = PATHS.vmHibernate(srcName);
  if (!existsSync(srcHibernate)) {
    throw new Error(`thaw: source hibernate.bin missing at ${srcHibernate}`);
  }
  const srcBundle = bundleDir(srcRecord.lume_name ?? srcName);
  if (!existsSync(join(srcBundle, "disk.img"))) {
    throw new Error(`thaw: source bundle disk.img missing at ${srcBundle}`);
  }

  // Validate new name: must NOT exist in registry yet.
  if (await findWell(newName)) {
    throw new Error(`thaw: well '${newName}' already exists`);
  }

  log.info("thaw: starting", { src: srcName, dst: newName });

  const newBundle = bundleDir(newName);

  // Provision lume bundle dir + the v4-mirror contents. Lume expects
  // the bundle to exist and contain config.json/nvram.bin/disk.img
  // before it'll accept a restoreState call against the name. Tested
  // 2026-05-10: VZ rejects "invalid argument" if config.json's MAC
  // differs from src's at restoreState — the MAC is part of the
  // saved-state contract. So copy config.json verbatim. MAC mutation
  // (for concurrent thaws from same src) needs a post-restore
  // guest-side path; out of scope this slice.
  // Mode 0o755 matches createWell's bundle perms — VZ's hardened
  // runtime expects world-traversable bundle dirs even when files
  // inside are 0600 (hibernate.bin, nvram.bin). Empirically, 0o700
  // bundle dir → "permission denied" from VZ at restoreState even
  // though the lume process is the same UID as the bundle owner.
  await mkdir(newBundle, { recursive: true, mode: 0o755 });
  await copyFile(join(srcBundle, "config.json"), join(newBundle, "config.json"));
  await copyFile(join(srcBundle, "nvram.bin"), join(newBundle, "nvram.bin"));
  await copyFile(join(srcBundle, "disk.img"), join(newBundle, "disk.img"));

  // Pull MAC out of the bundle config.json — needed for the new
  // well's registry so resolveWellIp can find a DHCP lease via
  // mac_address lookup. Older wells didn't stamp mac_address in
  // their registry record; new ones do (createWell.ts:480ish), but
  // we read from config.json so the path works for both.
  let bundleMac: string | undefined;
  try {
    const cfg = JSON.parse(
      await readFile(join(newBundle, "config.json"), "utf-8"),
    );
    if (typeof cfg.macAddress === "string") bundleMac = cfg.macAddress;
  } catch {
    // ignore; fall through with no mac_address recorded
  }

  // hibernate.bin lives in welld state, not lume bundle. Place a copy
  // adjacent to disk.img so lume.restoreState's hibernate_path points
  // at the new bundle's local copy (avoids any race with src's path).
  const newHibernate = join(newBundle, "hibernate.bin");
  await copyFile(srcHibernate, newHibernate);
  // ALSO copy the device-graph snapshot lume's restoreState reads to
  // validate the rebuilt VZ config. Lives at <hibernate.bin's
  // dir>/hibernate.config.json (engine/vwell-src/src/VM/VM.swift:745).
  // Without this, lume's drift-diff has nothing to compare against
  // and the restore rejects.
  //
  // The snapshot encodes ABSOLUTE PATHS for nvram.bin, disk.img, and
  // lume-config-<name> temp dir. For the cln, those paths must match
  // the cln bundle (different name → different path). String-rewrite
  // src's name → cln's name in the snapshot text so the diff is clean.
  const srcHibernateConfig = join(PATHS.vmDir(srcName), "hibernate.config.json");
  if (existsSync(srcHibernateConfig)) {
    const srcLumeName = srcRecord.lume_name ?? srcName;
    let snapshot = await readFile(srcHibernateConfig, "utf-8");
    // Replace path segments referring to src with the new name. The
    // snapshot is JSON-serialized with `\/` slash escaping, so cover
    // both forms. Both appear: `/<srcLumeName>/` (in absolute bundle
    // paths inside JSON-string values) and `lume-config-<srcLumeName>`
    // (in lume's temp config-share dir mount).
    snapshot = snapshot.split(`/${srcLumeName}/`).join(`/${newName}/`);
    snapshot = snapshot.split(`\\/${srcLumeName}\\/`).join(`\\/${newName}\\/`);
    snapshot = snapshot.split(`lume-config-${srcLumeName}`).join(`lume-config-${newName}`);
    await Bun.write(join(newBundle, "hibernate.config.json"), snapshot);
  }

  // Register the new well in welld's registry so it shows up in
  // /v1/wells, can be exec'd into, etc. Sizing inherited from src.
  const newRecord: WellRecord = {
    name: newName,
    uuid: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    cpu: srcRecord.cpu,
    memory: srcRecord.memory,
    disk_size: srcRecord.disk_size,
    auth: srcRecord.auth,
    // mac_address inherited from src (verbatim copy — MAC change
    // would break VZ restore). Prefer the registry record's value;
    // fall back to bundle config.json so the path works for older
    // src wells that pre-date mac_address tracking.
    ...((srcRecord.mac_address ?? bundleMac)
      ? { mac_address: (srcRecord.mac_address ?? bundleMac)! }
      : {}),
    ...(srcRecord.lume_name ? { lume_name: newName } : {}),
  };
  await addWell(newRecord);

  const stateDir = PATHS.vmDir(newName);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // hibernate.bin in welld state mirrors lume's so destroy paths find
  // it consistently.
  await copyFile(srcHibernate, PATHS.vmHibernate(newName));
  // Copy src's SSH key (welld→guest auth) so `well exec` works
  // immediately on the thawed well. The thawed disk has src's
  // authorized_keys (because the bundle is a v4 mirror), so the
  // host-side private key from src is the matching half.
  const srcSshKey = PATHS.vmSshKey(srcName);
  if (existsSync(srcSshKey)) {
    await copyFile(srcSshKey, PATHS.vmSshKey(newName));
  }
  const srcSshHostKey = PATHS.vmSshHostKey(srcName);
  if (existsSync(srcSshHostKey)) {
    await copyFile(srcSshHostKey, PATHS.vmSshHostKey(newName));
  }
  // Write runtime as alive_running BEFORE calling restoreState. Why
  // not "hibernating" first then transition: any incoming HTTP request
  // (exec, status, etc.) checks runtime state and triggers
  // ensureRunning if it sees `hibernating` — that would issue a
  // second concurrent lume.restoreState while ours is in flight, which
  // VZ rejects with "permission denied" (and the supervisor then
  // killAndRestarts lume). Pre-mark alive_running so concurrent reads
  // don't trip wake-on-traffic; if our restoreState fails below, we
  // throw and the caller's try/catch surfaces the failure.
  const runningRuntime = defaultRuntime();
  runningRuntime.state = "alive_running";
  runningRuntime.last_running_at = new Date().toISOString();
  await writeRuntime(newName, runningRuntime);

  // Issue restoreState directly. The serialization mutex above means
  // only one thaw is in flight against lume at a time.
  log.info("thaw: lume.restoreState", { dst: newName, hibernatePath: newHibernate });
  await lume.restoreState(newName, newHibernate);

  // Wait for lume to report status=running. The restored VM is at the
  // exact CPU/RAM state src was at hibernate time, so this is fast
  // (<1s typically). Per-VM IP comes back from lume info once vmnet
  // re-attaches.
  await lume.waitForStatus(newName, "running", { timeoutMs: 30_000, intervalMs: 200 });
  const info = await lume.info(newName).catch(() => null);
  const ip = info?.ipAddress ?? "";

  log.info("thaw: complete", { src: srcName, dst: newName, ip });

  return {
    name: newName,
    uuid: newRecord.uuid,
    ip,
    bundleDir: newBundle,
    hibernatePath: newHibernate,
  };
}

// Test-only: reset the serialization chain. Otherwise tests share the
// chain across cases and a single failure cascades.
export function _resetThawChain(): void {
  thawChain = Promise.resolve();
}
