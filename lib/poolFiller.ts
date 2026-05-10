// A.1.4.b.ii — welld background pool filler.
//
// Maintains `pool_size` ready members in the pool registry. Calls
// `fillPoolMember` whenever ready depth drops below the target, async
// (never blocks welld responses). Runs in three modes:
//
//   1. Slow housekeeping timer (every POOL_FILL_INTERVAL_MS) — catches
//      drift between welld restarts; gentle baseline.
//   2. On welld startup — `startPoolFiller` runs one tick immediately
//      so cold-started welld doesn't take a full housekeeping interval
//      to begin filling.
//   3. After each adoption — `triggerFillIfNeeded` from adoptFromPool
//      kicks the next fill the moment pool depth drops.
//
// Concurrency: at most one fill at a time. Filling a pool member takes
// 10-12s on dev (clone + first boot + warming-restart + hibernate);
// running multiple in parallel would thrash the host's memory + IO and
// risk lume serve stalls. If pool_size jumps from 0 to 4, the filler
// fills serially over ~45s rather than all at once.
//
// pool_size = 0 disables the filler (no members hatched, no work done).
// That's the default until cells team opts in via defaults.json.

import { detectHostPubkey } from "./createWell.ts";
import { loadDefaults } from "./defaults.ts";
import { log } from "./log.ts";
import { fillPoolMember } from "./poolFill.ts";
import { countReadyMembers } from "./poolRegistry.ts";

// 60s — slow enough to be background, fast enough that a missed
// adoption-trigger event still gets filled within a minute.
export const POOL_FILL_INTERVAL_MS = 60_000;

// Module state — exposed via getters for tests. Single boolean gate
// so concurrent callers (timer + triggerFillIfNeeded + adoption hook)
// can't kick off parallel fills.
let filling = false;
let stopped = false;

// Pure decision: should the filler hatch a new member right now?
// Exported so the test suite can pin the gap-detection logic without
// a live filler. Returns true iff pool is enabled, no fill is in-
// flight, and ready depth is below target.
export function shouldFill(
  poolSize: number,
  readyCount: number,
  inflight: boolean,
): boolean {
  if (poolSize <= 0) return false;
  if (inflight) return false;
  return readyCount < poolSize;
}

// One filler tick. Reads current target + ready count, hatches one
// member if there's a gap. Catches all errors so a transient lume
// hang or DHCP miss doesn't crash the timer.
async function fillerTick(): Promise<void> {
  if (stopped) return;
  if (filling) return; // shouldn't happen given the timer schedules
                       // serially, but defensive.

  let poolSize: number;
  let readyCount: number;
  try {
    const defaults = await loadDefaults();
    poolSize = defaults.pool_size;
    readyCount = await countReadyMembers();
  } catch (e) {
    log.error("poolFiller: tick read failed", { err: (e as Error).message });
    return;
  }

  if (!shouldFill(poolSize, readyCount, filling)) return;

  filling = true;
  const t0 = Date.now();
  try {
    log.info("poolFiller: hatching member", {
      pool_size: poolSize, ready_before: readyCount,
    });
    const hostPubkey = await detectHostPubkey();
    const member = await fillPoolMember({ hostPubkey });
    log.info("poolFiller: hatched", {
      name: member.name, ms: Date.now() - t0,
    });
  } catch (e) {
    // Don't propagate — keep the timer alive. fillPoolMember already
    // cleans up partial bundles on its own failure path.
    log.error("poolFiller: hatch failed", {
      err: (e as Error).message, ms: Date.now() - t0,
    });
  } finally {
    filling = false;
  }
}

// Start the background filler. Returns a stop function suitable for
// welld shutdown. Idempotent guard so double-start (test reuse) is
// harmless.
//
// The timer is `unref`'d so it doesn't keep the event loop alive on
// its own — welld's HTTP server holds the process up; the filler is
// a passenger.
export function startPoolFiller(): () => void {
  stopped = false;
  // Fire one tick immediately so a freshly-started welld with
  // pool_size>0 begins filling right away rather than waiting a
  // minute for the first interval.
  fillerTick().catch((e) =>
    log.error("poolFiller: startup tick failed", { err: (e as Error).message }),
  );

  const timer = setInterval(() => {
    fillerTick().catch((e) =>
      log.error("poolFiller: tick failed", { err: (e as Error).message }),
    );
  }, POOL_FILL_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Adoption-side trigger. Called by adoptFromPool right after a
// successful adoption so the next fill kicks off immediately rather
// than waiting up to POOL_FILL_INTERVAL_MS for the housekeeping tick.
// Idempotent + non-blocking: if a fill is already in flight, the
// trigger is a no-op; otherwise spawns one tick and returns.
//
// Returns void (fire-and-forget) to keep the adoption path's latency
// budget unaffected.
export function triggerFillIfNeeded(): void {
  if (stopped || filling) return;
  fillerTick().catch((e) =>
    log.error("poolFiller: trigger failed", { err: (e as Error).message }),
  );
}

// Test seam — drains module state so a test that exercises the filler
// doesn't leak a held `filling` flag into the next test.
export function _resetPoolFillerForTests(): void {
  filling = false;
  stopped = false;
}
