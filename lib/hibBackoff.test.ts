import { describe, expect, test } from "bun:test";
import { gateHibernate, recordHibFailure } from "./hibBackoff.ts";

const OPTS = { threshold: 5, cooldownMs: 600_000 };

describe("gateHibernate", () => {
  test("no state → pass through", () => {
    expect(gateHibernate(undefined, 1000)).toEqual({
      skip: false,
      cooldownElapsed: false,
    });
  });

  test("failures but not suspended → pass through", () => {
    expect(
      gateHibernate({ failures: 3, suspendedUntil: null }, 1000),
    ).toEqual({ skip: false, cooldownElapsed: false });
  });

  test("suspended, still inside cooldown → skip", () => {
    expect(
      gateHibernate({ failures: 5, suspendedUntil: 5000 }, 1000),
    ).toEqual({ skip: true, cooldownElapsed: false });
  });

  test("suspended, cooldown elapsed → proceed + signal reset", () => {
    expect(
      gateHibernate({ failures: 5, suspendedUntil: 5000 }, 5000),
    ).toEqual({ skip: false, cooldownElapsed: true });
  });
});

describe("recordHibFailure", () => {
  test("first failure → counter bump, not suspended", () => {
    expect(recordHibFailure(undefined, 1000, OPTS)).toEqual({
      state: { failures: 1, suspendedUntil: null },
      justSuspended: false,
    });
  });

  test("below threshold → keeps counting, not suspended", () => {
    expect(
      recordHibFailure({ failures: 3, suspendedUntil: null }, 1000, OPTS),
    ).toEqual({
      state: { failures: 4, suspendedUntil: null },
      justSuspended: false,
    });
  });

  test("crossing the threshold arms the cooldown + flags justSuspended", () => {
    const r = recordHibFailure(
      { failures: 4, suspendedUntil: null },
      1000,
      OPTS,
    );
    expect(r.state).toEqual({ failures: 5, suspendedUntil: 601_000 });
    expect(r.justSuspended).toBe(true);
  });

  test("a stuck well that retries post-cooldown and fails again re-suspends, no double warn", () => {
    // After a cooldown elapses the watchdog drops the entry; the next
    // failure streak starts fresh. Simulate reaching threshold again.
    const r = recordHibFailure(
      { failures: 4, suspendedUntil: null },
      900_000,
      OPTS,
    );
    expect(r.state.suspendedUntil).toBe(1_500_000);
    expect(r.justSuspended).toBe(true);
  });
});
