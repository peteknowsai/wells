import { describe, expect, test, beforeEach } from "bun:test";
import {
  _resetForTests,
  getLastTouched,
  shouldAutoSleep,
  touch,
} from "./idle.ts";
import type { SpliteRecord } from "./registry.ts";

const baseRecord: SpliteRecord = {
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

  test("touches are scoped per splite name", () => {
    touch("a", 100);
    touch("b", 200);
    expect(getLastTouched("a")).toBe(100);
    expect(getLastTouched("b")).toBe(200);
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
