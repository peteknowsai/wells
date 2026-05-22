// Autosleep watchdog. Runs once per tick (every 30s in welld), scans
// every well the engine reports as running, and stops the ones that
// have crossed their idle threshold. Pure dispatch — IO is injected so
// the tick is unit-testable without welld or lume.

import { autoSleepEnabled, shouldAutoSleep, touch } from "./idle.ts";
import type { WellRecord } from "./registry.ts";

// Default grace after a cooperative {idle} signal before the watchdog
// is allowed to sleep the well. Welld overrides via idleGraceMs.
export const DEFAULT_IDLE_GRACE_MS = 8_000;

export interface WatchdogTickArgs {
  records: WellRecord[];
  isRunning: (name: string) => boolean;
  lastTouchedMs: (name: string) => number | undefined;
  nowMs: number;
  defaultSeconds: number | null;
  stopWell: (name: string) => Promise<void>;
  // Optional host-side activity probe (Phase A.1.3.d). When provided,
  // each tick samples activity for running wells; an active sample
  // bumps lastTouched so the well is considered "fresh" by
  // shouldAutoSleep. This catches in-guest work that doesn't cross
  // welld's API/proxy surfaces (long ssh sessions, in-guest
  // background jobs, etc.) — sig-6 / sig-A in docs/state-tiers.md.
  probeActivity?: (name: string) => Promise<boolean>;
  // Cooperative fast sleep. When the cell POSTs /lifecycle {idle} on
  // agent_end, welld records the timestamp; this returns it (undefined
  // if the well hasn't signalled idle, or signalled busy since).
  // A well idle-signalled for >= idleGraceMs is sleep-eligible without
  // waiting out the full auto_sleep_seconds — but ONLY if it's
  // autosleep-enabled (the pin still vetoes) and the activity probe
  // doesn't see live work. The watchdog stays the sole decider; the
  // idle signal is a hint that lets it decide sooner, never a command.
  idleSignalledSince?: (name: string) => number | undefined;
  idleGraceMs?: number;
}

export async function runWatchdogTick(args: WatchdogTickArgs): Promise<string[]> {
  const stopped: string[] = [];
  // Defaults treat null/0/NaN as "no global default" — disabled. The
  // shouldAutoSleep check then only fires for wells with a numeric
  // override on the record.
  const defaultSec =
    args.defaultSeconds === null || !Number.isFinite(args.defaultSeconds)
      ? 0
      : args.defaultSeconds;

  const idleGraceMs = args.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;

  for (const record of args.records) {
    if (!args.isRunning(record.name)) continue;

    // Activity probe runs FIRST — if the well has open work, we want
    // to touch it before deciding whether to sleep. Probe failure is
    // non-fatal; an unreachable well just falls back to touch-only
    // logic (the existing API/proxy touches still drive lastTouched).
    let probeActive = false;
    if (args.probeActivity) {
      try {
        probeActive = await args.probeActivity(record.name);
        if (probeActive) touch(record.name, args.nowMs);
      } catch {
        // ignore probe failures
      }
    }

    // Cooperative fast path: a well idle-signalled for >= the grace
    // window is eligible even if it hasn't been quiet long enough for
    // the auto_sleep_seconds threshold. Still gated — autoSleepEnabled
    // keeps the pin honored, and a probe that sees live work vetoes a
    // stale idle signal.
    const idleSince = args.idleSignalledSince?.(record.name);
    const cooperativelyIdle =
      idleSince !== undefined &&
      !probeActive &&
      autoSleepEnabled(record, defaultSec) &&
      args.nowMs - idleSince >= idleGraceMs;

    const should =
      cooperativelyIdle ||
      shouldAutoSleep({
        record,
        lastTouchedMs: args.lastTouchedMs(record.name),
        nowMs: args.nowMs,
        defaultSeconds: defaultSec,
      });
    if (!should) continue;
    try {
      await args.stopWell(record.name);
      stopped.push(record.name);
    } catch {
      // Best-effort. Next tick retries — the well will still be
      // running and still idle, so it'll re-trigger.
    }
  }
  return stopped;
}
