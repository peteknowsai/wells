import { afterEach, describe, expect, test } from "bun:test";
import { _resetForTests as resetIdle } from "./idle.ts";
import { runWatchdogTick } from "./watchdog.ts";
import type { WellRecord } from "./registry.ts";

afterEach(() => resetIdle());

function rec(name: string, override?: number | null): WellRecord {
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
  records: WellRecord[];
  running: Set<string>;
  lastTouched: Map<string, number>;
  stops: string[];
  failNext?: Set<string>;
}

function stage(records: WellRecord[], running: string[]): Stage {
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
    stopWell: async (n) => {
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
  test("stops a well past its default idle threshold", async () => {
    const s = stage([rec("pete")], ["pete"]);
    s.lastTouched.set("pete", 0);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped).toEqual(["pete"]);
    expect(s.stops).toEqual(["pete"]);
  });

  test("doesn't stop a running well that's still within budget", async () => {
    const s = stage([rec("pete")], ["pete"]);
    s.lastTouched.set("pete", 50_000);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped).toEqual([]);
    expect(s.stops).toEqual([]);
  });

  test("never stops a well with auto_sleep_seconds: null override", async () => {
    const s = stage([rec("pete", null)], ["pete"]);
    s.lastTouched.set("pete", 0);
    const stopped = await tick(s, 999_999_999, 60);
    expect(stopped).toEqual([]);
  });

  test("respects per-well override over default", async () => {
    const s = stage([rec("pete", 30)], ["pete"]);
    s.lastTouched.set("pete", 0);
    // Default is 600s (would NOT trigger), but pete's override is 30s.
    const stopped = await tick(s, 40_000, 600);
    expect(stopped).toEqual(["pete"]);
  });

  test("ignores stopped wells entirely", async () => {
    const s = stage([rec("pete")], []); // not running
    s.lastTouched.set("pete", 0);
    const stopped = await tick(s, 999_999_999, 60);
    expect(stopped).toEqual([]);
  });

  test("never-touched well is left alone (just-booted grace)", async () => {
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

  test("active probe bumps lastTouched; well avoids sleep this tick", async () => {
    // pete is well past 60s idle (lastTouched=0, now=70s), but the probe
    // sees an active connection — touch fires, watchdog reads the new
    // timestamp via the SAME lastTouched callback (so we point it at
    // the idle module's getter via a thin wrapper).
    const { touch, getLastTouched } = await import("./idle.ts");
    touch("pete", 0);
    const records = [rec("pete")];
    const stopped = await runWatchdogTick({
      records,
      isRunning: () => true,
      lastTouchedMs: (n) => getLastTouched(n),
      nowMs: 70_000,
      defaultSeconds: 60,
      stopWell: async () => {
        throw new Error("should not have stopped");
      },
      probeActivity: async () => true,
    });
    expect(stopped).toEqual([]);
    expect(getLastTouched("pete")).toBe(70_000);
  });

  test("inactive probe does NOT bump lastTouched; sleep still fires", async () => {
    const { touch, getLastTouched } = await import("./idle.ts");
    touch("pete", 0);
    const records = [rec("pete")];
    const stops: string[] = [];
    const stopped = await runWatchdogTick({
      records,
      isRunning: () => true,
      lastTouchedMs: (n) => getLastTouched(n),
      nowMs: 70_000,
      defaultSeconds: 60,
      stopWell: async (n) => {
        stops.push(n);
      },
      probeActivity: async () => false,
    });
    expect(stopped).toEqual(["pete"]);
    expect(stops).toEqual(["pete"]);
    expect(getLastTouched("pete")).toBe(0); // unchanged
  });

  test("probe failure is non-fatal — falls through to standard logic", async () => {
    const { touch, getLastTouched } = await import("./idle.ts");
    touch("pete", 0);
    const records = [rec("pete")];
    const stops: string[] = [];
    const stopped = await runWatchdogTick({
      records,
      isRunning: () => true,
      lastTouchedMs: (n) => getLastTouched(n),
      nowMs: 70_000,
      defaultSeconds: 60,
      stopWell: async (n) => {
        stops.push(n);
      },
      probeActivity: async () => {
        throw new Error("lsof boom");
      },
    });
    expect(stopped).toEqual(["pete"]);
    expect(stops).toEqual(["pete"]);
  });

  test("scans multiple wells in one tick", async () => {
    const s = stage([rec("a"), rec("b"), rec("c", null), rec("d")], ["a", "b", "c"]);
    s.lastTouched.set("a", 0);
    s.lastTouched.set("b", 50_000);
    s.lastTouched.set("c", 0);
    s.lastTouched.set("d", 0);
    const stopped = await tick(s, 70_000, 60);
    expect(stopped.sort()).toEqual(["a"]); // d not running, b not idle enough, c never-sleep
  });
});

describe("runWatchdogTick — cooperative fast sleep", () => {
  function fastTick(opts: {
    record: WellRecord;
    nowMs: number;
    defaultSeconds: number | null;
    lastTouchedMs?: number;
    idleSince?: number;
    idleGraceMs?: number;
    probeActive?: boolean;
  }): Promise<string[]> {
    return runWatchdogTick({
      records: [opts.record],
      isRunning: () => true,
      lastTouchedMs: () => opts.lastTouchedMs,
      nowMs: opts.nowMs,
      defaultSeconds: opts.defaultSeconds,
      stopWell: async () => {},
      ...(opts.probeActive !== undefined
        ? { probeActivity: async () => opts.probeActive as boolean }
        : {}),
      idleSignalledSince: () => opts.idleSince,
      idleGraceMs: opts.idleGraceMs ?? 8_000,
    });
  }

  test("idle-signalled past the grace window → sleeps before the auto_sleep threshold", async () => {
    // Idle-signalled 9s ago (grace 8s). auto_sleep is 60s and the well
    // was touched 5s ago — shouldAutoSleep alone would NOT fire.
    const stopped = await fastTick({
      record: rec("pete", 60),
      nowMs: 100_000,
      defaultSeconds: 60,
      lastTouchedMs: 95_000,
      idleSince: 91_000,
    });
    expect(stopped).toEqual(["pete"]);
  });

  test("idle-signalled but still inside the grace window → not slept", async () => {
    const stopped = await fastTick({
      record: rec("pete", 60),
      nowMs: 100_000,
      defaultSeconds: 60,
      lastTouchedMs: 95_000,
      idleSince: 95_000, // 5s ago, grace is 8s
    });
    expect(stopped).toEqual([]);
  });

  test("the pin vetoes a cooperative idle signal (auto_sleep_seconds: null)", async () => {
    const stopped = await fastTick({
      record: rec("mother", null),
      nowMs: 100_000,
      defaultSeconds: 60,
      idleSince: 0, // idle "forever"
    });
    expect(stopped).toEqual([]);
  });

  test("a disabled global default + no override also vetoes the idle signal", async () => {
    const stopped = await fastTick({
      record: rec("pete"), // no override → uses default
      nowMs: 100_000,
      defaultSeconds: null, // autosleep globally disabled
      idleSince: 0,
    });
    expect(stopped).toEqual([]);
  });

  test("an active probe vetoes a stale idle signal", async () => {
    const stopped = await fastTick({
      record: rec("pete", 60),
      nowMs: 100_000,
      defaultSeconds: 60,
      idleSince: 0,
      probeActive: true,
    });
    expect(stopped).toEqual([]);
  });

  test("no idle signal → cooperative path is inert; normal threshold still rules", async () => {
    const stopped = await fastTick({
      record: rec("pete", 60),
      nowMs: 100_000,
      defaultSeconds: 60,
      lastTouchedMs: 95_000, // only 5s idle
      // idleSince undefined
    });
    expect(stopped).toEqual([]);
  });
});
