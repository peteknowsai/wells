// Autosleep watchdog. Runs once per tick (every 30s in splited), scans
// every splite the engine reports as running, and stops the ones that
// have crossed their idle threshold. Pure dispatch — IO is injected so
// the tick is unit-testable without splited or lume.

import { shouldAutoSleep } from "./idle.ts";
import type { SpliteRecord } from "./registry.ts";

export interface WatchdogTickArgs {
  records: SpliteRecord[];
  isRunning: (name: string) => boolean;
  lastTouchedMs: (name: string) => number | undefined;
  nowMs: number;
  defaultSeconds: number | null;
  stopSplite: (name: string) => Promise<void>;
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
