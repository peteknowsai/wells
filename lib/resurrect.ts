// Startup resurrection — restart wells that were `alive_running` or
// `alive_paused` before welld died.
//
// Background (cells team 2026-05-11 06:58Z): cells team's birth wedge
// relies on Tier 4 (running-resident eggs in the pool). When welld
// restarts, the lume supervisor cycles + the VZ XPC children die with
// it; every running well goes to status=stopped. Without resurrection,
// the pool loses its "warm running" state on every welld bounce.
//
// Policy: runtime.json wins on startup. If runtime says alive_*, we
// trust that the operator wanted this well running, and lume's view
// post-restart is the stale one. We start the well.
//
// Skips:
//   - Wells whose hibernate.bin exists → those are hibernating; should
//     auto-wake via inbound traffic (wakeWell), not cold-boot.
//   - Wells whose last runtime.state was stopped / missing / error_*.
//     Stopped is intentional; orphaned is broken.
//
// Serialization: starts wells one at a time. The host's vmnet DHCP
// has a concurrent ceiling of 4 (W.13 findings); even with that
// headroom, serial avoids a thundering herd on the DHCP server.

import { LumeClient } from "../engine/vwell.ts";
import { existsSync } from "node:fs";
import { startWell } from "./lifecycle.ts";
import { log } from "./log.ts";
import { listWells, lumeNameOf } from "./registry.ts";
import { PATHS } from "./state.ts";
import { readRuntime, writeRuntime } from "./wellRuntime.ts";

export interface ResurrectResult {
  considered: number;
  resurrected: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
}

export async function resurrectAliveWells(): Promise<ResurrectResult> {
  const records = await listWells();
  const lume = new LumeClient();
  const result: ResurrectResult = {
    considered: records.length,
    resurrected: [],
    skipped: [],
    failed: [],
  };

  for (const rec of records) {
    const runtime = await readRuntime(rec.name);
    if (!runtime) {
      result.skipped.push({ name: rec.name, reason: "no runtime.json" });
      continue;
    }

    // Only resurrect wells that were definitively alive.
    if (
      runtime.state !== "alive_running" &&
      runtime.state !== "alive_paused"
    ) {
      result.skipped.push({
        name: rec.name,
        reason: `state=${runtime.state} (not alive_*)`,
      });
      continue;
    }

    // Hibernate file present → leave as hibernating, traffic-on-wake
    // is the right path.
    if (existsSync(PATHS.vmHibernate(rec.name))) {
      result.skipped.push({
        name: rec.name,
        reason: "hibernate.bin present (will wake on traffic instead)",
      });
      continue;
    }

    // Confirm lume currently sees stopped — if it sees running, the
    // welld restart didn't actually clip this VM and we don't need
    // to start it.
    const lumeName = lumeNameOf(rec);
    const info = await lume.info(lumeName).catch(() => null);
    if (info?.status === "running") {
      result.skipped.push({
        name: rec.name,
        reason: "lume already reports running",
      });
      continue;
    }
    // W.78: lume has no record of this well — the bundle was deleted or
    // never materialized (typical for "bobby-class" ghosts: registry
    // entries that survived a welld bounce after their lume serve died
    // taking the bundles with it). Without this fast-skip, startWell hits
    // SSH timeout per well — 32 ghosts × 60s = 32 min jam, blocking new
    // POST /v1/wells calls until the queue drains. Cells team's
    // verification 2026-05-13 19:08Z hit exactly this on the Pi2 bounce.
    if (info === null) {
      result.skipped.push({
        name: rec.name,
        reason: "lume has no record (orphan registry entry)",
      });
      continue;
    }

    // Resurrect. W.73: startWell now verifies SSH-ready before returning,
    // so resurrect failures surface here (Error) rather than getting
    // recorded as "started" and dying silently within seconds. The
    // pre-W.73 path trusted lume's optimistic status flip, but Tier-4
    // cidata-mounted VMs were observed crashing post-status-flip; the
    // SSH probe catches that race.
    try {
      log.info("resurrect: starting well", { name: rec.name });
      const startResult = await startWell(rec.name);
      // W.69: refresh runtime.json post-startWell. Pre-W.69, resurrect
      // left runtime.ip stamped with the pre-bounce IP — but vmnet
      // doesn't guarantee same-IP across cold restart, so the lease
      // publisher could write a stale entry. After this, the publisher
      // sees the IP startWell actually observed via waitForNewerLease.
      // (egg-94b5e5 zombie cells team reported 08:52Z: welld said
      // running + ip=192.168.64.5, ping/ssh failed at that IP because
      // the resurrected VM came up at a different address.)
      const fresh = await readRuntime(rec.name);
      if (fresh) {
        await writeRuntime(rec.name, {
          ...fresh,
          state: "alive_running",
          last_transition_at: new Date().toISOString(),
          ip: startResult.ip || null,
        });
      }
      result.resurrected.push(rec.name);
      log.info("resurrect: started", {
        name: rec.name,
        ip: startResult.ip,
      });
    } catch (e) {
      const err = (e as Error).message;
      log.error("resurrect: start failed", { name: rec.name, err });
      result.failed.push({ name: rec.name, error: err });
    }
  }

  return result;
}
