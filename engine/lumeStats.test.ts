import { describe, expect, test, beforeEach } from "bun:test";
import {
  _pushRespawnForTests,
  _resetRespawnStatsForTests,
  lumeRespawnStats,
} from "./lumeProcess.ts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("lumeRespawnStats — sliding window", () => {
  beforeEach(() => {
    _resetRespawnStatsForTests();
  });

  test("zero state: no respawns, not degraded", () => {
    const s = lumeRespawnStats();
    expect(s).toEqual({
      totalRespawnsLastHour: 0,
      respawnsLast5Min: 0,
      respawnsLast1Min: 0,
      degraded: false,
    });
  });

  test("counts respawns within each window", () => {
    const now = Date.now();
    // 30s ago, 2min ago, 10min ago, 90min ago
    _pushRespawnForTests(now - 30 * 1000);
    _pushRespawnForTests(now - 2 * MIN);
    _pushRespawnForTests(now - 10 * MIN);
    _pushRespawnForTests(now - 90 * MIN);

    const s = lumeRespawnStats();
    expect(s.respawnsLast1Min).toBe(1);     // just 30s-ago
    expect(s.respawnsLast5Min).toBe(2);     // 30s + 2min
    expect(s.totalRespawnsLastHour).toBe(3); // 30s + 2min + 10min (90min pruned)
  });

  test("prunes entries older than 1 hour on read", () => {
    const now = Date.now();
    _pushRespawnForTests(now - 2 * HOUR);
    _pushRespawnForTests(now - 70 * MIN);
    _pushRespawnForTests(now - 30 * MIN);
    expect(lumeRespawnStats().totalRespawnsLastHour).toBe(1);
  });

  test("degraded flips on at 5 respawns within 5min", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      _pushRespawnForTests(now - i * 30 * 1000); // every 30s for 2.5min
    }
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBe(5);
    expect(s.degraded).toBe(true);
  });

  test("degraded stays off below threshold", () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      _pushRespawnForTests(now - i * 30 * 1000);
    }
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBe(4);
    expect(s.degraded).toBe(false);
  });

  test("respawns outside the 5min window don't trigger degraded", () => {
    const now = Date.now();
    // Spread 10 respawns over 30 minutes — always 5min-ago window has at most a few.
    for (let i = 0; i < 10; i++) {
      _pushRespawnForTests(now - i * 3 * MIN);
    }
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBeLessThan(5);
    expect(s.degraded).toBe(false);
  });
});
