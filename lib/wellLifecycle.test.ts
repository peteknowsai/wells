import { describe, expect, test } from "bun:test";
import { dispatchTransition, type DispatchResult } from "./wellLifecycle.ts";
import type { LifecycleVerb, WellState } from "./wellRuntime.ts";

// Compact encoding for the expected outcome of each (state, verb)
// pair. `noop` = verb's intent already satisfied; `inv` = invalid;
// any other string = the destination state for a real transition.
type Cell = "noop" | "inv" | WellState;

// Full matrix — 7 states × 7 verbs = 49 cells. Every cell is asserted
// in the loop below. Adding a verb or state requires adding a row/
// column here; the test will fail loudly if the table drifts.
const matrix: Record<WellState, Record<LifecycleVerb, Cell>> = {
  alive_running: {
    start: "noop",
    stop: "stopped",
    pause: "alive_paused",
    resume: "noop",
    hibernate: "hibernating",
    wake: "noop",
    destroy: "missing",
  },
  alive_paused: {
    start: "inv",
    stop: "stopped",
    pause: "noop",
    resume: "alive_running",
    hibernate: "hibernating",
    wake: "inv",
    destroy: "missing",
  },
  hibernating: {
    start: "inv",
    stop: "stopped",
    pause: "inv",
    resume: "inv",
    hibernate: "noop",
    wake: "alive_running",
    destroy: "missing",
  },
  stopped: {
    start: "alive_running",
    stop: "noop",
    pause: "inv",
    resume: "inv",
    hibernate: "inv",
    wake: "inv",
    destroy: "missing",
  },
  restoring: {
    start: "inv",
    stop: "inv",
    pause: "inv",
    resume: "inv",
    hibernate: "inv",
    wake: "inv",
    destroy: "inv",
  },
  error_orphaned: {
    start: "inv",
    stop: "stopped",
    pause: "inv",
    resume: "inv",
    hibernate: "inv",
    wake: "inv",
    destroy: "missing",
  },
  missing: {
    start: "inv",
    stop: "inv",
    pause: "inv",
    resume: "inv",
    hibernate: "inv",
    wake: "inv",
    destroy: "noop",
  },
};

function assertCell(
  current: WellState,
  verb: LifecycleVerb,
  expected: Cell,
  result: DispatchResult,
): void {
  if (expected === "inv") {
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toContain(verb);
      expect(result.reason).toContain(current);
    }
    return;
  }
  if (expected === "noop") {
    expect(result.kind).toBe("noop");
    if (result.kind === "noop") {
      expect(result.state).toBe(current);
    }
    return;
  }
  expect(result.kind).toBe("transition");
  if (result.kind === "transition") {
    expect(result.from).toBe(current);
    expect(result.to).toBe(expected);
  }
}

describe("dispatchTransition — full (state × verb) matrix", () => {
  // Generate one test per cell so failures point at the exact pair.
  // Bun runs them in a flat list; 49 named cases stay readable.
  for (const [state, row] of Object.entries(matrix) as [
    WellState,
    Record<LifecycleVerb, Cell>,
  ][]) {
    for (const [verb, expected] of Object.entries(row) as [
      LifecycleVerb,
      Cell,
    ][]) {
      test(`${state} × ${verb} → ${expected}`, () => {
        const result = dispatchTransition(state, verb);
        assertCell(state, verb, expected, result);
      });
    }
  }
});

describe("dispatchTransition — idempotency invariants", () => {
  test("noop never changes state when re-applied", () => {
    // For each state, find a verb that's a noop and confirm two
    // sequential applications stay noop. Pure function so this is
    // mechanical, but the assertion documents the property.
    const idempotentPairs: [WellState, LifecycleVerb][] = [
      ["alive_running", "start"],
      ["alive_running", "resume"],
      ["alive_running", "wake"],
      ["alive_paused", "pause"],
      ["hibernating", "hibernate"],
      ["stopped", "stop"],
      ["missing", "destroy"],
    ];
    for (const [state, verb] of idempotentPairs) {
      const a = dispatchTransition(state, verb);
      const b = dispatchTransition(state, verb);
      expect(a.kind).toBe("noop");
      expect(b.kind).toBe("noop");
      expect(a).toEqual(b);
    }
  });

  test("invalid result includes both verb and current state in reason", () => {
    // Failure mode: caller sees an error and needs to know what they
    // asked vs where the well was. Reason must carry both.
    const r = dispatchTransition("missing", "wake");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.reason).toContain("wake");
      expect(r.reason).toContain("missing");
    }
  });
});
