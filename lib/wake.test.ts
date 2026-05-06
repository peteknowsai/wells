// Tests focus on the pure dedup logic — the thing that benefits from
// unit coverage. End-to-end ensureRunning behavior is covered by the
// live smoke against pete (start a stopped splite, observe wake).

import { describe, expect, test, beforeEach } from "bun:test";
import { _resetForTests, dedupedStart } from "./wake.ts";
import type { StartResult } from "./lifecycle.ts";

beforeEach(() => _resetForTests());

const okResult: StartResult = { ip: "10.0.0.1", bootMs: 1000, alreadyRunning: false };

describe("dedupedStart", () => {
  test("calls start once for a single caller", async () => {
    let calls = 0;
    const r = await dedupedStart("pete", async () => {
      calls += 1;
      return okResult;
    });
    expect(calls).toBe(1);
    expect(r).toEqual(okResult);
  });

  test("dedupes concurrent calls for the same name to one start", async () => {
    let calls = 0;
    let release!: () => void;
    const slow = new Promise<StartResult>((res) => {
      release = () => res(okResult);
    });
    const start = async (_n: string): Promise<StartResult> => {
      calls += 1;
      return await slow;
    };
    const p1 = dedupedStart("pete", start);
    const p2 = dedupedStart("pete", start);
    const p3 = dedupedStart("pete", start);
    queueMicrotask(release);
    const results = await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.ip === "10.0.0.1")).toBe(true);
  });

  test("different names get separate starts", async () => {
    let calls = 0;
    const start = async (_n: string): Promise<StartResult> => {
      calls += 1;
      return okResult;
    };
    await Promise.all([dedupedStart("a", start), dedupedStart("b", start)]);
    expect(calls).toBe(2);
  });

  test("after a start completes, a subsequent call starts a fresh one", async () => {
    let calls = 0;
    const start = async (_n: string): Promise<StartResult> => {
      calls += 1;
      return okResult;
    };
    await dedupedStart("pete", start);
    await dedupedStart("pete", start); // pete is "running" again, but dedupe cache cleared
    expect(calls).toBe(2);
  });

  test("a failed start clears the cache so the next call retries", async () => {
    let calls = 0;
    const start = async (_n: string): Promise<StartResult> => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt failed");
      return okResult;
    };
    await expect(dedupedStart("pete", start)).rejects.toThrow("first attempt failed");
    const r = await dedupedStart("pete", start);
    expect(calls).toBe(2);
    expect(r).toEqual(okResult);
  });

  test("a failure during dedupe propagates to all in-flight callers", async () => {
    let calls = 0;
    const start = async (_n: string): Promise<StartResult> => {
      calls += 1;
      // Reject on the next microtask so both callers attach before the failure.
      await Promise.resolve();
      throw new Error("boot failed");
    };
    const p1 = dedupedStart("pete", start);
    const p2 = dedupedStart("pete", start);
    const results = await Promise.allSettled([p1, p2]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(results.every((r) => (r as PromiseRejectedResult).reason?.message === "boot failed")).toBe(true);
  });
});
