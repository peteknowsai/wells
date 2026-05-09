import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRuntime,
  nextState,
  readRuntime,
  runtimePath,
  validTransitions,
  writeRuntime,
  type LifecycleVerb,
  type WellState,
} from "./wellRuntime.ts";

describe("nextState transition table", () => {
  test("alive_running accepts the lifecycle verbs we expect", () => {
    expect(nextState("alive_running", "stop")).toBe("stopped");
    expect(nextState("alive_running", "pause")).toBe("alive_paused");
    expect(nextState("alive_running", "hibernate")).toBe("hibernating");
    expect(nextState("alive_running", "destroy")).toBe("missing");
    expect(nextState("alive_running", "start")).toBe("alive_running"); // idempotent
  });

  test("alive_paused → resume → alive_running", () => {
    expect(nextState("alive_paused", "resume")).toBe("alive_running");
    expect(nextState("alive_paused", "pause")).toBe("alive_paused"); // idempotent
  });

  test("hibernating accepts wake, idempotent on hibernate", () => {
    expect(nextState("hibernating", "wake")).toBe("alive_running");
    expect(nextState("hibernating", "hibernate")).toBe("hibernating");
    expect(nextState("hibernating", "stop")).toBe("stopped");
    expect(nextState("hibernating", "destroy")).toBe("missing");
  });

  test("stopped → start → alive_running", () => {
    expect(nextState("stopped", "start")).toBe("alive_running");
    expect(nextState("stopped", "stop")).toBe("stopped"); // idempotent
    expect(nextState("stopped", "destroy")).toBe("missing");
  });

  test("error_orphaned only accepts stop and destroy (recovery)", () => {
    expect(nextState("error_orphaned", "stop")).toBe("stopped");
    expect(nextState("error_orphaned", "destroy")).toBe("missing");
    expect(nextState("error_orphaned", "start")).toBeUndefined();
    expect(nextState("error_orphaned", "wake")).toBeUndefined();
  });

  test("missing only accepts destroy (no-op)", () => {
    expect(nextState("missing", "destroy")).toBe("missing");
    expect(nextState("missing", "start")).toBeUndefined();
    expect(nextState("missing", "stop")).toBeUndefined();
  });

  test("restoring rejects all verbs (transient, lock prevents entry)", () => {
    const verbs: LifecycleVerb[] = [
      "start", "stop", "pause", "resume", "hibernate", "wake", "destroy",
    ];
    for (const v of verbs) {
      expect(nextState("restoring", v)).toBeUndefined();
    }
  });

  test("invalid (state, verb) pairs return undefined", () => {
    // pause on stopped: nonsense, can't pause a non-running VM
    expect(nextState("stopped", "pause")).toBeUndefined();
    // wake on alive_running: VM isn't hibernating
    expect(nextState("alive_running", "wake")).toBeUndefined();
    // resume on stopped: VM isn't paused
    expect(nextState("stopped", "resume")).toBeUndefined();
  });
});

describe("validTransitions table coverage", () => {
  test("every state has at least destroy as an exit", () => {
    const states: WellState[] = [
      "alive_running",
      "alive_paused",
      "hibernating",
      "stopped",
      "restoring",
      "error_orphaned",
      "missing",
    ];
    for (const s of states) {
      // restoring is the one exception — it's transient and the lock
      // serializes everything else around it.
      if (s === "restoring") continue;
      expect(validTransitions[s].destroy).toBeDefined();
    }
  });

  test("idempotent verbs map to themselves where defined", () => {
    expect(validTransitions.alive_running.start).toBe("alive_running");
    expect(validTransitions.alive_paused.pause).toBe("alive_paused");
    expect(validTransitions.hibernating.hibernate).toBe("hibernating");
    expect(validTransitions.stopped.stop).toBe("stopped");
    expect(validTransitions.missing.destroy).toBe("missing");
  });
});

describe("runtime persistence", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-runtime-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("read returns null when no runtime.json exists", async () => {
    expect(await readRuntime("ghost")).toBeNull();
  });

  test("write then read round-trips", async () => {
    const r = defaultRuntime();
    await writeRuntime("pete", r);
    const back = await readRuntime("pete");
    expect(back).toEqual(r);
  });

  test("write is atomic (no partial file on crash)", async () => {
    // Two concurrent writes shouldn't corrupt each other's output.
    // The rename-after-tmp pattern means one of them wins entirely;
    // we just verify no exception leaks out.
    const a = defaultRuntime();
    const b = { ...defaultRuntime(), state: "stopped" as WellState };
    await Promise.all([writeRuntime("pete", a), writeRuntime("pete", b)]);
    const final = await readRuntime("pete");
    expect(final).not.toBeNull();
    // Final state is one of the two — both are valid runtime shapes.
    expect(["alive_running", "stopped"]).toContain(final!.state);
  });

  test("runtimePath sits next to the bundle dir", () => {
    const p = runtimePath("pete");
    expect(p.endsWith("/vms/pete/runtime.json")).toBe(true);
  });

  test("defaultRuntime is alive_running with no error", () => {
    const r = defaultRuntime();
    expect(r.state).toBe("alive_running");
    expect(r.last_error).toBeNull();
    expect(r.hibernate_path).toBeNull();
    expect(r.restore_recipe).toBeNull();
    // ISO8601 timestamp parseable.
    expect(Number.isFinite(Date.parse(r.last_transition_at))).toBe(true);
  });
});
