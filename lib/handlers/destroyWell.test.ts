import { describe, expect, test } from "bun:test";
import { handleDestroyWell, type DestroyWellDeps } from "./destroyWell.ts";

interface MockCall {
  fn: string;
  args: unknown[];
}

function makeDeps(overrides: Partial<DestroyWellDeps> = {}): {
  deps: DestroyWellDeps;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const deps: DestroyWellDeps = {
    destroyWell: async (name) => {
      calls.push({ fn: "destroyWell", args: [name] });
      return {
        found: true,
        removedRegistry: true,
        removedStateDir: true,
        removedBundle: true,
      };
    },
    clearLastTouched: (name) => {
      calls.push({ fn: "clearLastTouched", args: [name] });
    },
    clearWatchdogFailures: (name) => {
      calls.push({ fn: "clearWatchdogFailures", args: [name] });
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("handleDestroyWell", () => {
  test("success: 200 with sprite-shaped fields (snake_case)", async () => {
    const { deps } = makeDeps();
    const res = await handleDestroyWell("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("pete");
    expect(body.found).toBe(true);
    expect(body.removed_registry).toBe(true);
    expect(body.removed_state_dir).toBe(true);
    expect(body.removed_bundle).toBe(true);
  });

  test("idempotent: found=false still returns 200", async () => {
    const { deps } = makeDeps({
      destroyWell: async () => ({
        found: false,
        removedRegistry: false,
        removedStateDir: false,
        removedBundle: false,
      }),
    });
    const res = await handleDestroyWell("ghost", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { found: boolean };
    expect(body.found).toBe(false);
  });

  test("destroyWell throws → 500 destroy_failed", async () => {
    const { deps } = makeDeps({
      destroyWell: async () => {
        throw new Error("bundle delete refused: locked");
      },
    });
    const res = await handleDestroyWell("pete", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("destroy_failed");
    expect(body.message).toContain("bundle delete refused");
  });

  test("clearLastTouched fires after destroyWell (stale-touch hygiene)", async () => {
    const { deps, calls } = makeDeps();
    await handleDestroyWell("pete", deps);
    const destroyIdx = calls.findIndex((c) => c.fn === "destroyWell");
    const clearIdx = calls.findIndex((c) => c.fn === "clearLastTouched");
    expect(destroyIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(destroyIdx);
  });

  test("clearWatchdogFailures fires on success", async () => {
    const { deps, calls } = makeDeps();
    await handleDestroyWell("pete", deps);
    const clear = calls.find((c) => c.fn === "clearWatchdogFailures");
    expect(clear).toBeDefined();
    expect(clear!.args).toEqual(["pete"]);
  });

  test("on destroy failure, clear functions are NOT called (no half-cleanup)", async () => {
    const { deps, calls } = makeDeps({
      destroyWell: async () => {
        throw new Error("boom");
      },
    });
    await handleDestroyWell("pete", deps);
    expect(calls.find((c) => c.fn === "clearLastTouched")).toBeUndefined();
    expect(calls.find((c) => c.fn === "clearWatchdogFailures")).toBeUndefined();
  });
});
