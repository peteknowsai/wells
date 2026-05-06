import { describe, expect, test } from "bun:test";
import { runWatchdogTick } from "./watchdog.ts";
import type { SpliteRecord } from "./registry.ts";

function rec(name: string, override?: number | null): SpliteRecord {
  return {
    name,
    uuid: `u-${name}`,
    created_at: "2026-05-06T00:00:00.000Z",
    cpu: 4,
    memory: "4GB",
    disk_size: "50GB",
    ...(override !== undefined ? { auto_sleep_seconds: override } : {}),
  };
}

interface Stage {
  records: SpliteRecord[];
  running: Set<string>;
  lastTouched: Map<string, number>;
  stops: string[];
  failNext?: Set<string>;
}

function stage(records: SpliteRecord[], running: string[]): Stage {
  return {
    records,
    running: new Set(running),
    lastTouched: new Map(),
    stops: [],
  };
}

function tick(s: Stage, nowMs: number, defaultSeconds: number | null) {
  return runWatchdogTick({
    records: s.records,
    isRunning: (n) => s.running.has(n),
    lastTouchedMs: (n) => s.lastTouched.get(n),
    nowMs,
    defaultSeconds,
    stopSplite: async (n) => {
      if (s.failNext?.has(n)) {
        s.failNext.delete(n);
        throw new Error("stop failed");
      }
      s.stops.push(n);
      s.running.delete(n);
    },
  });
}

describe("runWatchdogTick", () => {
  test("stops a splite past its default idle threshold", async () => {
    const s = stage([rec("pete")], ["pete"]);
    s.lastTouched.set("pete", 0);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped).toEqual(["pete"]);
    expect(s.stops).toEqual(["pete"]);
  });

  test("doesn't stop a running splite that's still within budget", async () => {
    const s = stage([rec("pete")], ["pete"]);
    s.lastTouched.set("pete", 50_000);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped).toEqual([]);
    expect(s.stops).toEqual([]);
  });

  test("never stops a splite with auto_sleep_seconds: null override", async () => {
    const s = stage([rec("pete", null)], ["pete"]);
    s.lastTouched.set("pete", 0);
    const stopped = await tick(s, 999_999_999, 60);
    expect(stopped).toEqual([]);
  });

  test("respects per-splite override over default", async () => {
    const s = stage([rec("pete", 30)], ["pete"]);
    s.lastTouched.set("pete", 0);
    // Default is 600s (would NOT trigger), but pete's override is 30s.
    const stopped = await tick(s, 40_000, 600);
    expect(stopped).toEqual(["pete"]);
  });

  test("ignores stopped splites entirely", async () => {
    const s = stage([rec("pete")], []); // not running
    s.lastTouched.set("pete", 0);
    const stopped = await tick(s, 999_999_999, 60);
    expect(stopped).toEqual([]);
  });

  test("never-touched splite is left alone (just-booted grace)", async () => {
    const s = stage([rec("pete")], ["pete"]);
    // No entry in lastTouched.
    const stopped = await tick(s, 999_999_999, 60);
    expect(stopped).toEqual([]);
  });

  test("null defaultSeconds disables global threshold; only overrides fire", async () => {
    const s = stage([rec("a"), rec("b", 30)], ["a", "b"]);
    s.lastTouched.set("a", 0);
    s.lastTouched.set("b", 0);
    const stopped = await tick(s, 100_000, null);
    expect(stopped).toEqual(["b"]);
  });

  test("stop failures don't break the rest of the tick", async () => {
    const s = stage([rec("a"), rec("b")], ["a", "b"]);
    s.lastTouched.set("a", 0);
    s.lastTouched.set("b", 0);
    s.failNext = new Set(["a"]);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped).toEqual(["b"]);
    expect(s.stops).toEqual(["b"]);
  });

  test("scans multiple splites in one tick", async () => {
    const s = stage([rec("a"), rec("b"), rec("c", null), rec("d")], ["a", "b", "c"]);
    s.lastTouched.set("a", 0);
    s.lastTouched.set("b", 50_000);
    s.lastTouched.set("c", 0);
    s.lastTouched.set("d", 0);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped.sort()).toEqual(["a"]); // d not running, b not idle enough, c never-sleep
  });
});
