import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchTransition,
  transitionWell,
  type Actuators,
  type DispatchResult,
} from "./wellLifecycle.ts";
import {
  defaultRuntime,
  writeRuntime,
  type LifecycleVerb,
  type WellState,
} from "./wellRuntime.ts";
import { _resetLocksForTests } from "./wellLock.ts";

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
    hibernate: "noop",
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
      ["stopped", "hibernate"],
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

// ---------------------------------------------------------------------
// transitionWell — orchestrator with lock + runtime + actuators
// ---------------------------------------------------------------------

function recordingActuators(): {
  actuators: Actuators;
  calls: { verb: LifecycleVerb; name: string }[];
} {
  const calls: { verb: LifecycleVerb; name: string }[] = [];
  const make = (verb: LifecycleVerb): Actuators[LifecycleVerb] =>
    async (name: string) => {
      calls.push({ verb, name });
    };
  return {
    calls,
    actuators: {
      start: make("start"),
      stop: make("stop"),
      pause: make("pause"),
      resume: make("resume"),
      hibernate: make("hibernate"),
      wake: make("wake"),
      destroy: make("destroy"),
    },
  };
}

describe("transitionWell — orchestrator", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-trans-"));
    process.env.WELL_STATE_DIR = tmp;
    _resetLocksForTests();
  });
  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("transition kind: runs the actuator", async () => {
    // Default runtime is alive_running. `stop` is a real transition.
    await writeRuntime("pete", defaultRuntime());
    const { actuators, calls } = recordingActuators();
    const out = await transitionWell("pete", "stop", actuators);
    expect(out.kind).toBe("transition");
    expect(out.from).toBe("alive_running");
    expect(out.to).toBe("stopped");
    expect(calls).toEqual([{ verb: "stop", name: "pete" }]);
  });

  test("noop kind: skips the actuator", async () => {
    // start-on-running is idempotent → noop, no actuator call.
    await writeRuntime("pete", defaultRuntime());
    const { actuators, calls } = recordingActuators();
    const out = await transitionWell("pete", "start", actuators);
    expect(out.kind).toBe("noop");
    expect(out.from).toBe("alive_running");
    expect(out.to).toBe("alive_running");
    expect(calls).toEqual([]);
  });

  test("invalid: throws + does not call the actuator", async () => {
    // wake-on-stopped is invalid (no hibernate file to restore).
    await writeRuntime("pete", { ...defaultRuntime(), state: "stopped" });
    const { actuators, calls } = recordingActuators();
    let err: Error | null = null;
    try {
      await transitionWell("pete", "wake", actuators);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeTruthy();
    expect(err?.message).toContain("wake");
    expect(err?.message).toContain("stopped");
    expect(calls).toEqual([]);
  });

  test("hibernating + wake: actuates the wake verb", async () => {
    // Cells wake-on-traffic contract: hibernating → alive_running.
    await writeRuntime("pete", { ...defaultRuntime(), state: "hibernating" });
    const { actuators, calls } = recordingActuators();
    const out = await transitionWell("pete", "wake", actuators);
    expect(out.kind).toBe("transition");
    expect(out.to).toBe("alive_running");
    expect(calls).toEqual([{ verb: "wake", name: "pete" }]);
  });

  test("default runtime when none persisted (alive_running fallback)", async () => {
    // Unwritten runtime falls back to defaultRuntime() = alive_running.
    // Ensures fresh wells don't trip on missing runtime.json.
    const { actuators } = recordingActuators();
    const out = await transitionWell("nonexistent", "start", actuators);
    expect(out.kind).toBe("noop"); // start-on-running
  });

  test("concurrent calls serialize through the lock", async () => {
    await writeRuntime("pete", defaultRuntime());
    const order: string[] = [];
    const slow: Actuators = {
      ...recordingActuators().actuators,
      pause: async () => {
        order.push("pause-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("pause-end");
      },
    };
    // Kick two concurrent transitions for the same well. The lock
    // ensures pause finishes before the next read sees state = paused.
    const a = transitionWell("pete", "pause", slow);
    // Brief delay so the second call is queued after the first
    // acquires the lock (else they may run truly concurrently
    // depending on microtask order).
    await new Promise((r) => setTimeout(r, 1));
    const b = transitionWell("pete", "stop", slow).catch((e) => e);
    await Promise.all([a, b]);
    expect(order[0]).toBe("pause-start");
    expect(order[1]).toBe("pause-end");
  });
});
