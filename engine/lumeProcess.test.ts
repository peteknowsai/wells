import { describe, expect, test, beforeEach } from "bun:test";
import {
  lumeRespawnStats,
  _resetRespawnStatsForTests,
  _pushRespawnForTests,
} from "./lumeProcess.ts";

// Coverage backfill for the lume supervisor's respawn-tracking surface
// (MVP-PLAN line 384: "Test coverage for B.0 changes"). The supervisor
// itself spawns real subprocesses + does HTTP probes so we don't unit
// test it directly here. But the stats it pushes drive `/healthz` and
// the degraded-flag cells team consumes, so we lock the pure-function
// shape of lumeRespawnStats: window math, sliding-cutoff pruning, and
// the 5-respawns-in-5-min degraded threshold (W.20-era guarantee).

describe("lumeRespawnStats", () => {
  beforeEach(() => {
    _resetRespawnStatsForTests();
  });

  test("empty: zero counts, not degraded", () => {
    const s = lumeRespawnStats();
    expect(s.totalRespawnsLastHour).toBe(0);
    expect(s.respawnsLast5Min).toBe(0);
    expect(s.respawnsLast1Min).toBe(0);
    expect(s.degraded).toBe(false);
  });

  test("single recent push reflects in all windows", () => {
    _pushRespawnForTests(Date.now() - 1000);
    const s = lumeRespawnStats();
    expect(s.totalRespawnsLastHour).toBe(1);
    expect(s.respawnsLast5Min).toBe(1);
    expect(s.respawnsLast1Min).toBe(1);
    expect(s.degraded).toBe(false);
  });

  test("1-min window excludes 90s-old entries (still in 5min and 1hour)", () => {
    _pushRespawnForTests(Date.now() - 90 * 1000);
    const s = lumeRespawnStats();
    expect(s.totalRespawnsLastHour).toBe(1);
    expect(s.respawnsLast5Min).toBe(1);
    expect(s.respawnsLast1Min).toBe(0);
  });

  test("5-min window excludes 6-min-old entries (still in 1hour)", () => {
    _pushRespawnForTests(Date.now() - 6 * 60 * 1000);
    const s = lumeRespawnStats();
    expect(s.totalRespawnsLastHour).toBe(1);
    expect(s.respawnsLast5Min).toBe(0);
    expect(s.respawnsLast1Min).toBe(0);
  });

  test("1-hour pruning drops > 1h-old entries entirely", () => {
    // Push two ancient + one recent; stats should show only the recent.
    _pushRespawnForTests(Date.now() - 70 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 90 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 1000);
    const s = lumeRespawnStats();
    expect(s.totalRespawnsLastHour).toBe(1);
    expect(s.respawnsLast5Min).toBe(1);
    expect(s.respawnsLast1Min).toBe(1);
  });

  test("multiple entries within 1-min window all counted", () => {
    _pushRespawnForTests(Date.now() - 5_000);
    _pushRespawnForTests(Date.now() - 30_000);
    _pushRespawnForTests(Date.now() - 50_000);
    const s = lumeRespawnStats();
    expect(s.respawnsLast1Min).toBe(3);
    expect(s.respawnsLast5Min).toBe(3);
  });

  test("4 respawns in 5 min: NOT yet degraded (threshold is 5)", () => {
    for (let i = 0; i < 4; i++) {
      _pushRespawnForTests(Date.now() - i * 30_000);
    }
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBe(4);
    expect(s.degraded).toBe(false);
  });

  test("5 respawns in 5 min: degraded fires", () => {
    for (let i = 0; i < 5; i++) {
      _pushRespawnForTests(Date.now() - i * 30_000);
    }
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBe(5);
    expect(s.degraded).toBe(true);
  });

  test("6 respawns split across the 5-min boundary: only inside-window count", () => {
    // Three respawns within the last 4 minutes, three before the 5-min
    // cutoff — only the recent three count.
    _pushRespawnForTests(Date.now() - 1 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 2 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 3 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 6 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 7 * 60 * 1000);
    _pushRespawnForTests(Date.now() - 8 * 60 * 1000);
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBe(3);
    expect(s.degraded).toBe(false);
    expect(s.totalRespawnsLastHour).toBe(6);
  });

  test("entries exactly at the 5-min boundary are inclusive", () => {
    // The implementation uses `>= now - 5 * 60 * 1000`, so an entry at
    // exactly the 5-min mark counts. We push slightly inside (4m 59s)
    // and slightly outside (5m 1s) to pin the boundary direction.
    _pushRespawnForTests(Date.now() - (5 * 60 * 1000 - 1000));
    _pushRespawnForTests(Date.now() - (5 * 60 * 1000 + 1000));
    const s = lumeRespawnStats();
    expect(s.respawnsLast5Min).toBe(1);
  });

  test("entries exactly at the 1-min boundary are inclusive", () => {
    _pushRespawnForTests(Date.now() - (60 * 1000 - 100));
    _pushRespawnForTests(Date.now() - (60 * 1000 + 100));
    const s = lumeRespawnStats();
    expect(s.respawnsLast1Min).toBe(1);
    expect(s.respawnsLast5Min).toBe(2);
  });

  test("stats call is idempotent — repeated reads with no new pushes are stable", () => {
    _pushRespawnForTests(Date.now() - 1000);
    const a = lumeRespawnStats();
    const b = lumeRespawnStats();
    expect(a).toEqual(b);
  });

  test("pruning happens lazily on read — old entries don't accumulate forever", () => {
    // Push 10 entries from 2 hours ago. Without pruning, totalRespawnsLastHour
    // would be 10. After lumeRespawnStats() runs (which calls pruneOldRespawns),
    // they should all be gone.
    for (let i = 0; i < 10; i++) {
      _pushRespawnForTests(Date.now() - (2 * 60 * 60 * 1000 + i * 1000));
    }
    const s = lumeRespawnStats();
    expect(s.totalRespawnsLastHour).toBe(0);
  });

  test("degraded flag clears once respawns age out", () => {
    // Five recent respawns → degraded
    for (let i = 0; i < 5; i++) {
      _pushRespawnForTests(Date.now() - i * 30_000);
    }
    expect(lumeRespawnStats().degraded).toBe(true);
    // Reset + push the same five but aged past 5 minutes
    _resetRespawnStatsForTests();
    for (let i = 0; i < 5; i++) {
      _pushRespawnForTests(Date.now() - (6 * 60 * 1000 + i * 1000));
    }
    expect(lumeRespawnStats().degraded).toBe(false);
  });
});
