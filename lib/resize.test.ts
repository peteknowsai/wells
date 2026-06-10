import { describe, expect, test } from "bun:test";
import { resizeWellMemory, type ResizeDeps } from "./resize.ts";

function makeDeps(overrides: Partial<ResizeDeps> = {}): {
  deps: ResizeDeps;
  writes: Array<{ lumeName: string; cfg: Record<string, unknown> }>;
  registryUpdates: Array<{ name: string; memory: string }>;
} {
  const writes: Array<{ lumeName: string; cfg: Record<string, unknown> }> = [];
  const registryUpdates: Array<{ name: string; memory: string }> = [];
  const deps: ResizeDeps = {
    findWell: async (n) => ({ name: n }),
    resolveLumeName: async (n) => n,
    readRuntimeState: async () => "stopped",
    lumeStatus: async () => "stopped",
    readBundleConfig: async () => ({
      cpuCount: 4,
      memorySize: 1073741824,
      diskSize: 53687091200,
      macAddress: "66:19:8e:3b:54:71",
    }),
    writeBundleConfig: async (lumeName, cfg) => {
      writes.push({ lumeName, cfg });
    },
    updateWellMemory: async (name, memory) => {
      registryUpdates.push({ name, memory });
      return { name };
    },
    withLock: async (_n, fn) => fn(),
    ...overrides,
  };
  return { deps, writes, registryUpdates };
}

describe("resizeWellMemory", () => {
  test("stopped well: rewrites memorySize bytes, preserves other config fields", async () => {
    const { deps, writes, registryUpdates } = makeDeps();
    const result = await resizeWellMemory("mother", "2GB", deps);
    expect(result).toEqual({
      kind: "resized",
      memory: "2GB",
      memory_bytes: 2147483648,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.cfg.memorySize).toBe(2147483648);
    // The rest of the bundle config must survive untouched.
    expect(writes[0]!.cfg.cpuCount).toBe(4);
    expect(writes[0]!.cfg.diskSize).toBe(53687091200);
    expect(writes[0]!.cfg.macAddress).toBe("66:19:8e:3b:54:71");
    expect(registryUpdates).toEqual([{ name: "mother", memory: "2GB" }]);
  });

  test("normalizes the spec (lowercase in, canonical out)", async () => {
    const { deps, registryUpdates } = makeDeps();
    const result = await resizeWellMemory("mother", "1536mb", deps);
    expect(result).toEqual({
      kind: "resized",
      memory: "1536MB",
      memory_bytes: 1536 * 1024 * 1024,
    });
    expect(registryUpdates[0]!.memory).toBe("1536MB");
  });

  test("garbage spec throws before touching anything", async () => {
    const { deps, writes } = makeDeps();
    await expect(resizeWellMemory("mother", "lots", deps)).rejects.toThrow("invalid size");
    expect(writes).toHaveLength(0);
  });

  test("unknown well → not_found", async () => {
    const { deps } = makeDeps({ findWell: async () => null });
    expect(await resizeWellMemory("ghost", "2GB", deps)).toEqual({ kind: "not_found" });
  });

  test("running well (runtime view) → refused well_not_stopped", async () => {
    const { deps, writes } = makeDeps({
      readRuntimeState: async () => "alive_running",
    });
    const result = await resizeWellMemory("mother", "2GB", deps);
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("well_not_stopped");
    expect(writes).toHaveLength(0);
  });

  test("running well (lume view only — zombie shape) → refused", async () => {
    const { deps, writes } = makeDeps({
      readRuntimeState: async () => "stopped",
      lumeStatus: async () => "running",
    });
    const result = await resizeWellMemory("mother", "2GB", deps);
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("well_not_stopped");
    expect(writes).toHaveLength(0);
  });

  test("hibernating well → refused well_hibernating (saved state pins size)", async () => {
    const { deps, writes } = makeDeps({
      readRuntimeState: async () => "hibernating",
    });
    const result = await resizeWellMemory("mother", "2GB", deps);
    expect(result.kind).toBe("refused");
    expect((result as { code: string }).code).toBe("well_hibernating");
    expect(writes).toHaveLength(0);
  });

  test("never-booted well (no runtime.json) resizes fine", async () => {
    const { deps, writes } = makeDeps({
      readRuntimeState: async () => null,
      lumeStatus: async () => null,
    });
    const result = await resizeWellMemory("fresh", "4GB", deps);
    expect(result.kind).toBe("resized");
    expect(writes).toHaveLength(1);
  });

  test("adopted well resolves through lume_name for the bundle path", async () => {
    const { deps, writes } = makeDeps({
      resolveLumeName: async () => "pool-1234",
    });
    await resizeWellMemory("mother", "2GB", deps);
    expect(writes[0]!.lumeName).toBe("pool-1234");
  });

  test("runs under the well lock", async () => {
    let locked: string | null = null;
    const { deps } = makeDeps({
      withLock: async (name, fn) => {
        locked = name;
        return fn();
      },
    });
    await resizeWellMemory("mother", "2GB", deps);
    expect(locked).toBe("mother");
  });
});
