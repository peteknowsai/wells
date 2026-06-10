import { describe, expect, test, beforeEach } from "bun:test";
import {
  _activeLockCount,
  _resetLocksForTests,
  isWellLocked,
  withWellLock,
} from "./wellLock.ts";

describe("withWellLock", () => {
  beforeEach(() => {
    _resetLocksForTests();
  });

  test("single caller passes through immediately", async () => {
    const result = await withWellLock("pete", async () => 42);
    expect(result).toBe(42);
  });

  test("concurrent callers for same name run in arrival order", async () => {
    const log: string[] = [];
    const release: (() => void)[] = [];
    const settled: Promise<void>[] = [];

    // Three pending operations, each waits for an external "release"
    // before completing. Verifies they run sequentially even though
    // we kicked them all off at once.
    for (let i = 0; i < 3; i++) {
      const gate = new Promise<void>((r) => release.push(r));
      settled.push(
        withWellLock("pete", async () => {
          log.push(`start-${i}`);
          await gate;
          log.push(`end-${i}`);
        }),
      );
    }

    // Let the microtask queue drain so the first op's `start` lands.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["start-0"]);

    // Release in reverse order — but execution order should still be 0,1,2.
    release[2]!();
    release[1]!();
    release[0]!();

    await Promise.all(settled);
    expect(log).toEqual([
      "start-0", "end-0",
      "start-1", "end-1",
      "start-2", "end-2",
    ]);
  });

  test("different names run in parallel", async () => {
    const log: string[] = [];
    let releaseAlice: () => void;
    const aliceGate = new Promise<void>((r) => { releaseAlice = r; });

    const alicePromise = withWellLock("alice", async () => {
      log.push("alice-start");
      await aliceGate;
      log.push("alice-end");
    });
    const bobPromise = withWellLock("bob", async () => {
      log.push("bob-start");
      log.push("bob-end");
      return "bob-result";
    });

    // bob should complete fully even though alice is still waiting.
    const bobResult = await bobPromise;
    expect(bobResult).toBe("bob-result");
    expect(log).toContain("bob-end");
    expect(log).not.toContain("alice-end");

    releaseAlice!();
    await alicePromise;
    expect(log).toContain("alice-end");
  });

  test("a failing op releases the lock for the next caller", async () => {
    const order: string[] = [];

    const failing = withWellLock("pete", async () => {
      order.push("failing-ran");
      throw new Error("boom");
    });
    const followup = withWellLock("pete", async () => {
      order.push("followup-ran");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    const result = await followup;
    expect(result).toBe("ok");
    expect(order).toEqual(["failing-ran", "followup-ran"]);
  });

  test("lock entry is GC'd when chain drains", async () => {
    expect(_activeLockCount()).toBe(0);
    await withWellLock("pete", async () => 1);
    // After the only op completes, the map should be empty.
    expect(_activeLockCount()).toBe(0);
  });

  test("returns the inner function's value, including non-trivial types", async () => {
    const obj = { a: 1, b: [2, 3] };
    const result = await withWellLock("pete", async () => obj);
    expect(result).toBe(obj);
  });

  test("queue still drains even with mix of fast and slow ops", async () => {
    const log: number[] = [];
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      ops.push(
        withWellLock("pete", async () => {
          // Even-numbered ops wait a tick; odd run synchronously.
          if (i % 2 === 0) await Promise.resolve();
          log.push(i);
        }),
      );
    }
    await Promise.all(ops);
    expect(log).toEqual([0, 1, 2, 3, 4]);
  });

  test("isWellLocked reflects hold and release", async () => {
    expect(isWellLocked("pete")).toBe(false);
    let resolveInner: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveInner = r;
    });
    const held = withWellLock("pete", async () => {
      await gate;
    });
    expect(isWellLocked("pete")).toBe(true);
    expect(isWellLocked("other")).toBe(false);
    resolveInner();
    await held;
    expect(isWellLocked("pete")).toBe(false);
  });
});
