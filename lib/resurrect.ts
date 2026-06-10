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
import { existsSync, rmSync, statSync } from "node:fs";
import { startWell, type StartResult } from "./lifecycle.ts";
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

// W.73 retry policy. The first lume.start per well right after a fresh
// lume serve is racy — cidata-mounted VMs flip to running, then crash
// within seconds. startWell's waitForSshReady gate (shipped 74d58ee)
// turns that into a thrown error instead of a silent false-resurrect;
// this retry then makes the well actually come back, matching the
// observed "revives cleanly via explicit start afterward". Two attempts
// total — if attempt 2 also fails the well is genuinely broken, not
// racing, and each failed attempt already burns a ~60s SSH timeout, so
// more retries aren't worth it. The settle gives lume serve / the VZ
// layer a moment to quiesce before the second start.
export const RESURRECT_MAX_ATTEMPTS = 2;
export const RESURRECT_RETRY_SETTLE_MS = 3_000;

// Start a well with the W.73 resurrect-retry policy. Returns the
// StartResult on the first attempt that succeeds; throws the last
// error if every attempt fails. `startWellFn` is injectable for tests;
// resurrectAliveWells passes the real startWell.
export async function startWithResurrectRetry(
  name: string,
  startWellFn: (n: string) => Promise<StartResult>,
  settleMs: number = RESURRECT_RETRY_SETTLE_MS,
): Promise<StartResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RESURRECT_MAX_ATTEMPTS; attempt++) {
    try {
      return await startWellFn(name);
    } catch (e) {
      lastErr = e;
      if (attempt < RESURRECT_MAX_ATTEMPTS) {
        log.warn("resurrect: start attempt failed, retrying after settle", {
          name,
          attempt,
          err: (e as Error).message,
        });
        await new Promise((r) => setTimeout(r, settleMs));
      }
    }
  }
  throw lastErr;
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

    // Hibernate file present. Reaching this line means runtime says
    // alive_* — a VALID hibernate sets state=hibernating, so an
    // alive-state bin is almost always a stale leftover (pre-fix wakes
    // never consumed the file; egg-c5e25a sat stopped behind a 17-day-
    // old bin after the 2026-06-10 bounce). Discriminate by mtime:
    //   bin older than the last transition → stale; delete, resurrect.
    //   bin newer → crash window between saveState and the runtime
    //   write; the bin IS the latest state, defer to wake-on-traffic.
    const binPath = PATHS.vmHibernate(rec.name);
    if (existsSync(binPath)) {
      const binMtimeMs = statSync(binPath).mtimeMs;
      const lastTransitionMs = Date.parse(runtime.last_transition_at);
      const stale =
        Number.isFinite(lastTransitionMs) && binMtimeMs < lastTransitionMs;
      if (!stale) {
        result.skipped.push({
          name: rec.name,
          reason: "hibernate.bin present (will wake on traffic instead)",
        });
        continue;
      }
      log.warn(
        "resurrect: stale hibernate.bin (older than last transition) — removing, resurrecting",
        {
          name: rec.name,
          bin_mtime: new Date(binMtimeMs).toISOString(),
          last_transition_at: runtime.last_transition_at,
        },
      );
      rmSync(binPath, { force: true });
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

    // Resurrect with the W.73 retry policy. startWell's waitForSshReady
    // gate turns the fresh-lume-serve race (cidata VMs flipping to
    // running then crashing within seconds) into a thrown error rather
    // than a silent false-resurrect; startWithResurrectRetry then retries
    // once after a settle so the well actually comes back. Both attempts
    // failing means the well is genuinely broken — recorded in `failed`.
    try {
      log.info("resurrect: starting well", { name: rec.name });
      const startResult = await startWithResurrectRetry(rec.name, startWell);
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
      log.error("resurrect: start failed after retry", { name: rec.name, err });
      result.failed.push({ name: rec.name, error: err });
    }
  }

  return result;
}
