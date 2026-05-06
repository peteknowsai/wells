// Idle tracking for autosleep. Pure decision logic + an in-memory map of
// last-touched timestamps. The watchdog (next sub-chunk) calls
// `shouldAutoSleep` on each splite periodically.
//
// Why in-memory: per-request registry writes would contend with create/
// destroy and add disk noise. After a splited restart, every splite's
// last-touched is reset to "now" — fine, just delays the first sleep
// by `auto_sleep_seconds`. The override (`auto_sleep_seconds`) IS
// persisted on the record.

import type { SpliteRecord } from "./registry.ts";

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
  record: SpliteRecord;
  // Unix ms of last touch. Undefined when splited has never seen this
  // splite touched (e.g. fresh boot) — treated as "just now" so we don't
  // immediately stop a splite before the user has a chance to use it.
  lastTouchedMs: number | undefined;
  nowMs: number;
  // Global default applied when the record has no override.
  defaultSeconds: number;
}

export function shouldAutoSleep(args: ShouldAutoSleepArgs): boolean {
  const { record, lastTouchedMs, nowMs, defaultSeconds } = args;

  // null override = never sleep. (Distinct from undefined = use default.)
  if (record.auto_sleep_seconds === null) return false;

  const seconds = record.auto_sleep_seconds ?? defaultSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) return false;

  // No record of activity yet — treat as just-touched. The watchdog will
  // get its chance once the splite has been around for `seconds`.
  if (lastTouchedMs === undefined) return false;

  return nowMs - lastTouchedMs >= seconds * 1000;
}

// Test hook — reset the in-memory map between cases.
export function _resetForTests(): void {
  lastTouched.clear();
}
