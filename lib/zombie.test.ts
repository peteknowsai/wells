import { describe, expect, test } from "bun:test";
import {
  recoverZombieWell,
  stepZombieState,
  ZOMBIE_CONFIRM_TICKS,
  type ZombieRecoverDeps,
} from "./zombie.ts";

describe("stepZombieState", () => {
  test("clean tick resets the count", () => {
    expect(stepZombieState(undefined, false)).toEqual({ next: 0, confirmed: false });
    expect(stepZombieState(5, false)).toEqual({ next: 0, confirmed: false });
  });

  test("confirms exactly on the threshold tick", () => {
    let state: number | undefined;
    const emissions: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const { next, confirmed } = stepZombieState(state, true);
      state = next;
      emissions.push(confirmed);
    }
    // ZOMBIE_CONFIRM_TICKS=2 → confirm on tick 2 only, not re-emitted.
    expect(emissions).toEqual([false, true, false, false]);
    expect(ZOMBIE_CONFIRM_TICKS).toBe(2);
  });

  test("transient single-tick mismatch never confirms", () => {
    const a = stepZombieState(undefined, true);
    expect(a.confirmed).toBe(false);
    const b = stepZombieState(a.next, false);
    expect(b).toEqual({ next: 0, confirmed: false });
  });
});

describe("recoverZombieWell", () => {
  function makeDeps(overrides: Partial<ZombieRecoverDeps> = {}): {
    deps: ZombieRecoverDeps;
    calls: string[];
  } {
    const calls: string[] = [];
    const deps: ZombieRecoverDeps = {
      readRuntime: async () => ({ state: "alive_running", xpc_child_pid: 4242 }),
      writeRuntime: async (_n, rt) => {
        calls.push(`writeRuntime:${(rt as { state: string }).state}`);
      },
      lumeStatus: async () => "stopped",
      isVzXpcPid: async () => true,
      killXpcChild: async (pid) => {
        calls.push(`kill:${pid}`);
        return true;
      },
      waitForDiskReleased: async () => {
        calls.push("diskWait");
      },
      startWell: async (n) => {
        calls.push(`start:${n}`);
      },
      withLock: async (_n, fn) => {
        calls.push("lock");
        return fn();
      },
      ...overrides,
    };
    return { deps, calls };
  }

  test("happy path: kill child → disk wait → runtime stopped → start", async () => {
    const { deps, calls } = makeDeps();
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "recovered" });
    expect(calls).toEqual([
      "lock",
      "kill:4242",
      "diskWait",
      "writeRuntime:stopped",
      "start:mother",
    ]);
  });

  test("aborts when runtime changed before the lock was acquired", async () => {
    const { deps, calls } = makeDeps({
      readRuntime: async () => ({ state: "stopped", xpc_child_pid: null }),
    });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "aborted_state_changed", state: "stopped" });
    expect(calls).toEqual(["lock"]);
  });

  test("aborts when runtime is missing entirely", async () => {
    const { deps } = makeDeps({ readRuntime: async () => null });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "aborted_state_changed", state: null });
  });

  test("never kills when lume says running (sticky shape / racing start)", async () => {
    const { deps, calls } = makeDeps({ lumeStatus: async () => "running" });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "aborted_lume_running" });
    expect(calls).toEqual(["lock"]);
  });

  test("no tracked pid → skips kill, still disk-waits and recovers", async () => {
    const { deps, calls } = makeDeps({
      readRuntime: async () => ({ state: "alive_running", xpc_child_pid: null }),
    });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "recovered" });
    expect(calls).toEqual(["lock", "diskWait", "writeRuntime:stopped", "start:mother"]);
  });

  test("stale/reused pid (not a VZ child) → never killed, recovery proceeds", async () => {
    const { deps, calls } = makeDeps({ isVzXpcPid: async () => false });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "recovered" });
    // kill:4242 must NOT appear — PID reuse would hit an innocent process.
    expect(calls).toEqual(["lock", "diskWait", "writeRuntime:stopped", "start:mother"]);
  });

  test("unkillable child → failed, nothing else touched", async () => {
    const { deps, calls } = makeDeps();
    deps.killXpcChild = async (pid) => {
      calls.push(`kill:${pid}`);
      return false;
    };
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "failed", error: "xpc child 4242 did not die" });
    expect(calls).toEqual(["lock", "kill:4242"]);
  });

  test("disk never released → failed with the throw's message", async () => {
    const { deps, calls } = makeDeps({
      waitForDiskReleased: async () => {
        throw new Error("disk still held within 60000ms");
      },
    });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "failed", error: "disk still held within 60000ms" });
    expect(calls).not.toContain("start:mother");
  });

  test("startWell throw → failed, but runtime was already set to honest stopped", async () => {
    const { deps, calls } = makeDeps({
      startWell: async () => {
        throw new Error("boot timeout");
      },
    });
    const result = await recoverZombieWell("mother", deps);
    expect(result).toEqual({ kind: "failed", error: "boot timeout" });
    expect(calls).toContain("writeRuntime:stopped");
  });

  test("runs entirely inside the well lock", async () => {
    let lockHeld = false;
    let sawLockDuringStart = false;
    const { deps } = makeDeps({
      withLock: async (_n, fn) => {
        lockHeld = true;
        const r = await fn();
        lockHeld = false;
        return r;
      },
      startWell: async () => {
        sawLockDuringStart = lockHeld;
      },
    });
    await recoverZombieWell("mother", deps);
    expect(sawLockDuringStart).toBe(true);
  });
});
