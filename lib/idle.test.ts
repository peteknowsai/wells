import { describe, expect, test, beforeEach } from "bun:test";
import {
  _resetForTests,
  autoSleepEnabled,
  clearLastTouched,
  getLastTouched,
  shouldAutoSleep,
  touch,
} from "./idle.ts";
import type { WellRecord } from "./registry.ts";

const baseRecord: WellRecord = {
  name: "test",
  uuid: "u",
  created_at: "2026-05-06T00:00:00.000Z",
  cpu: 4,
  memory: "4GB",
  disk_size: "50GB",
};

describe("touch / getLastTouched", () => {
  beforeEach(() => _resetForTests());

  test("getLastTouched returns undefined before any touch", () => {
    expect(getLastTouched("pete")).toBeUndefined();
  });

  test("touch records a timestamp readable by getLastTouched", () => {
    touch("pete", 1_700_000_000_000);
    expect(getLastTouched("pete")).toBe(1_700_000_000_000);
  });

  test("touch overwrites the previous timestamp", () => {
    touch("pete", 1_000);
    touch("pete", 2_000);
    expect(getLastTouched("pete")).toBe(2_000);
  });

  test("touches are scoped per well name", () => {
    touch("a", 100);
    touch("b", 200);
    expect(getLastTouched("a")).toBe(100);
    expect(getLastTouched("b")).toBe(200);
  });
});

// clearLastTouched is the watchdog-state-leak fix (commit f2b5630).
// Recreating a well with the same name must NOT inherit a stale
// last-touched from the previous incarnation — otherwise the
// watchdog auto-hibernates the new well immediately if the previous
// touch was past auto_sleep_seconds. Daemon calls clearLastTouched
// on both handleCreateWell and handleDestroyWell.
describe("clearLastTouched", () => {
  beforeEach(() => _resetForTests());

  test("deletes an existing entry", () => {
    touch("pete", 1_000);
    expect(getLastTouched("pete")).toBe(1_000);
    clearLastTouched("pete");
    expect(getLastTouched("pete")).toBeUndefined();
  });

  test("no-op when nothing exists for that name", () => {
    expect(() => clearLastTouched("never-touched")).not.toThrow();
    expect(getLastTouched("never-touched")).toBeUndefined();
  });

  test("clears only the named well, leaves siblings alone", () => {
    touch("a", 100);
    touch("b", 200);
    clearLastTouched("a");
    expect(getLastTouched("a")).toBeUndefined();
    expect(getLastTouched("b")).toBe(200);
  });

  test("post-clear touch reads the fresh timestamp, not the stale one", () => {
    touch("recycled", 1_000);
    clearLastTouched("recycled");
    // Simulating "destroy + create" with the same name far in the future.
    touch("recycled", 9_999_999);
    expect(getLastTouched("recycled")).toBe(9_999_999);
  });
});

describe("shouldAutoSleep", () => {
  test("never sleeps when never-touched (lastTouchedMs undefined)", () => {
    expect(
      shouldAutoSleep({
        record: baseRecord,
        lastTouchedMs: undefined,
        nowMs: 9_999_999_999,
        defaultSeconds: 600,
      }),
    ).toBe(false);
  });

  test("sleeps when idle longer than default", () => {
    expect(
      shouldAutoSleep({
        record: baseRecord,
        lastTouchedMs: 0,
        nowMs: 700_000, // 700s
        defaultSeconds: 600,
      }),
    ).toBe(true);
  });

  test("does NOT sleep when idle less than default", () => {
    expect(
      shouldAutoSleep({
        record: baseRecord,
        lastTouchedMs: 0,
        nowMs: 500_000, // 500s
        defaultSeconds: 600,
      }),
    ).toBe(false);
  });

  test("sleeps right at the boundary (>=)", () => {
    expect(
      shouldAutoSleep({
        record: baseRecord,
        lastTouchedMs: 0,
        nowMs: 600_000,
        defaultSeconds: 600,
      }),
    ).toBe(true);
  });

  test("auto_sleep_seconds: null overrides to never sleep", () => {
    expect(
      shouldAutoSleep({
        record: { ...baseRecord, auto_sleep_seconds: null },
        lastTouchedMs: 0,
        nowMs: 99_999_999,
        defaultSeconds: 600,
      }),
    ).toBe(false);
  });

  test("auto_sleep_seconds: number overrides the default", () => {
    expect(
      shouldAutoSleep({
        record: { ...baseRecord, auto_sleep_seconds: 60 },
        lastTouchedMs: 0,
        nowMs: 80_000, // 80s
        defaultSeconds: 600, // would NOT have triggered default
      }),
    ).toBe(true);
  });

  test("auto_sleep_seconds: 0 means never sleep (treated as disabled)", () => {
    expect(
      shouldAutoSleep({
        record: { ...baseRecord, auto_sleep_seconds: 0 },
        lastTouchedMs: 0,
        nowMs: 99_999_999,
        defaultSeconds: 600,
      }),
    ).toBe(false);
  });

  test("undefined override falls through to default", () => {
    expect(
      shouldAutoSleep({
        record: baseRecord, // auto_sleep_seconds is undefined
        lastTouchedMs: 0,
        nowMs: 700_000,
        defaultSeconds: 600,
      }),
    ).toBe(true);
  });

  test("non-finite default treats as disabled", () => {
    expect(
      shouldAutoSleep({
        record: baseRecord,
        lastTouchedMs: 0,
        nowMs: 99_999_999,
        defaultSeconds: NaN,
      }),
    ).toBe(false);
  });
});

describe("autoSleepEnabled — the pin predicate", () => {
  test("positive per-well override → enabled", () => {
    expect(
      autoSleepEnabled({ ...baseRecord, auto_sleep_seconds: 30 }, 60),
    ).toBe(true);
  });

  test("null override → never sleeps (pinned)", () => {
    expect(
      autoSleepEnabled({ ...baseRecord, auto_sleep_seconds: null }, 60),
    ).toBe(false);
  });

  test("auto_sleep_seconds: 0 → disabled", () => {
    expect(
      autoSleepEnabled({ ...baseRecord, auto_sleep_seconds: 0 }, 60),
    ).toBe(false);
  });

  test("undefined override falls through to a positive default → enabled", () => {
    expect(autoSleepEnabled(baseRecord, 60)).toBe(true);
  });

  test("undefined override + disabled default → not enabled", () => {
    expect(autoSleepEnabled(baseRecord, 0)).toBe(false);
    expect(autoSleepEnabled(baseRecord, NaN)).toBe(false);
  });
});
