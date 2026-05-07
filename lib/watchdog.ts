// Autosleep watchdog. Runs once per tick (every 30s in splited), scans
// every splite the engine reports as running, and stops the ones that
// have crossed their idle threshold. Pure dispatch — IO is injected so
// the tick is unit-testable without splited or lume.

import { shouldAutoSleep, touch } from "./idle.ts";
import type { SpliteRecord } from "./registry.ts";

export interface WatchdogTickArgs {
  records: SpliteRecord[];
  isRunning: (name: string) => boolean;
  lastTouchedMs: (name: string) => number | undefined;
  nowMs: number;
  defaultSeconds: number | null;
  stopSplite: (name: string) => Promise<void>;
  // Optional host-side activity probe (Phase A.1.3.d). When provided,
  // each tick samples activity for running splites; an active sample
  // bumps lastTouched so the splite is considered "fresh" by
  // shouldAutoSleep. This catches in-guest work that doesn't cross
  // splited's API/proxy surfaces (long ssh sessions, in-guest
  // background jobs, etc.) — sig-6 / sig-A in docs/state-tiers.md.
  probeActivity?: (name: string) => Promise<boolean>;
}

export async function runWatchdogTick(args: WatchdogTickArgs): Promise<string[]> {
  const stopped: string[] = [];
  // Defaults treat null/0/NaN as "no global default" — disabled. The
  // shouldAutoSleep check then only fires for splites with a numeric
  // override on the record.
  const defaultSec =
    args.defaultSeconds === null || !Number.isFinite(args.defaultSeconds)
      ? 0
      : args.defaultSeconds;

  for (const record of args.records) {
    if (!args.isRunning(record.name)) continue;

    // Activity probe runs FIRST — if the splite has open work, we want
    // to touch it before deciding whether to sleep. Probe failure is
    // non-fatal; an unreachable splite just falls back to touch-only
    // logic (the existing API/proxy touches still drive lastTouched).
    if (args.probeActivity) {
      try {
        const active = await args.probeActivity(record.name);
        if (active) touch(record.name, args.nowMs);
      } catch {
        // ignore probe failures
      }
    }

    const should = shouldAutoSleep({
      record,
      lastTouchedMs: args.lastTouchedMs(record.name),
      nowMs: args.nowMs,
      defaultSeconds: defaultSec,
    });
    if (!should) continue;
    try {
      await args.stopSplite(record.name);
      stopped.push(record.name);
    } catch {
      // Best-effort. Next tick retries — the splite will still be
      // running and still idle, so it'll re-trigger.
    }
  }
  return stopped;
}
