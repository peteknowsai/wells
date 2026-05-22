// Idle tracking for autosleep. Pure decision logic + an in-memory map of
// last-touched timestamps. The watchdog (next sub-chunk) calls
// `shouldAutoSleep` on each well periodically.
//
// Why in-memory: per-request registry writes would contend with create/
// destroy and add disk noise. After a welld restart, every well's
// last-touched is reset to "now" — fine, just delays the first sleep
// by `auto_sleep_seconds`. The override (`auto_sleep_seconds`) IS
// persisted on the record.

import type { WellRecord } from "./registry.ts";

const lastTouched = new Map<string, number>();

export function touch(name: string, nowMs: number = Date.now()): void {
  lastTouched.set(name, nowMs);
}

export function getLastTouched(name: string): number | undefined {
  return lastTouched.get(name);
}

export function clearLastTouched(name: string): void {
  lastTouched.delete(name);
}

export interface ShouldAutoSleepArgs {
  record: WellRecord;
  // Unix ms of last touch. Undefined when welld has never seen this
  // well touched (e.g. fresh boot) — treated as "just now" so we don't
  // immediately stop a well before the user has a chance to use it.
  lastTouchedMs: number | undefined;
  nowMs: number;
  // Global default applied when the record has no override.
  defaultSeconds: number;
}

// True when this well participates in autosleep at all — i.e. it has a
// positive effective idle threshold. A null override ("never sleep"),
// or a non-positive / absent effective value, means the well is pinned
// awake. The cooperative idle signal and the activity probe can only
// sleep a well that's autosleep-enabled; neither overrides the pin.
export function autoSleepEnabled(
  record: WellRecord,
  defaultSeconds: number,
): boolean {
  // null override = never sleep. (Distinct from undefined = use default.)
  if (record.auto_sleep_seconds === null) return false;
  const seconds = record.auto_sleep_seconds ?? defaultSeconds;
  return Number.isFinite(seconds) && seconds > 0;
}

export function shouldAutoSleep(args: ShouldAutoSleepArgs): boolean {
  const { record, lastTouchedMs, nowMs, defaultSeconds } = args;

  if (!autoSleepEnabled(record, defaultSeconds)) return false;

  // No record of activity yet — treat as just-touched. The watchdog will
  // get its chance once the well has been around for `seconds`.
  if (lastTouchedMs === undefined) return false;

  const seconds = record.auto_sleep_seconds ?? defaultSeconds;
  return nowMs - lastTouchedMs >= seconds * 1000;
}

// Test hook — reset the in-memory map between cases.
export function _resetForTests(): void {
  lastTouched.clear();
}
