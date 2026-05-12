import { describe, expect, test } from "bun:test";
import {
  buildWellResource,
  type BuildWellResourceDeps,
  type BuildWellResourceRecord,
} from "./buildWellResource.ts";

function record(over: Partial<BuildWellResourceRecord> = {}): BuildWellResourceRecord {
  return {
    name: "pete",
    uuid: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-05-12T00:00:00Z",
    cpu: 4,
    memory: "4GB",
    disk_size: "50GB",
    ...over,
  };
}

function makeDeps(over: Partial<BuildWellResourceDeps> = {}): BuildWellResourceDeps {
  return {
    findWell: async (n) => record({ name: n }),
    lumeNameOf: (r) => r.name,
    lumeInfo: async () => ({ status: "running" }),
    resolveWellIp: async () => "192.168.65.10",
    diskUsageBytes: async () => 1234567,
    publicBase: () => null,
    ...over,
  };
}

describe("buildWellResource", () => {
  test("null when findWell returns null", async () => {
    const deps = makeDeps({ findWell: async () => null });
    const r = await buildWellResource("ghost", deps);
    expect(r).toBeNull();
  });

  test("populates from record + lume + ip + disk", async () => {
    const deps = makeDeps();
    const r = await buildWellResource("pete", deps);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("pete");
    expect(r!.cpu).toBe(4);
    expect(r!.memory).toBe("4GB");
    expect(r!.disk_size).toBe("50GB");
    expect(r!.ip).toBe("192.168.65.10");
    expect(r!.disk_used_bytes).toBe(1234567);
  });

  test("status from lume.info passes through", async () => {
    const deps = makeDeps({ lumeInfo: async () => ({ status: "running" }) });
    const r = await buildWellResource("pete", deps);
    expect(r!.status).toBe("running");
  });

  test("status 'missing' when lume returns null", async () => {
    const deps = makeDeps({ lumeInfo: async () => null });
    const r = await buildWellResource("pete", deps);
    expect(r!.status).toBe("missing");
  });

  test("status 'missing' when lume omits status field", async () => {
    const deps = makeDeps({ lumeInfo: async () => ({}) });
    const r = await buildWellResource("pete", deps);
    expect(r!.status).toBe("missing");
  });

  test("url composed when publicBase set", async () => {
    const deps = makeDeps({ publicBase: () => "cells.md" });
    const r = await buildWellResource("pete", deps);
    expect(r!.url).toBe("https://pete.cells.md");
  });

  test("url null when publicBase null", async () => {
    const deps = makeDeps({ publicBase: () => null });
    const r = await buildWellResource("pete", deps);
    expect(r!.url).toBeNull();
  });

  test("disk_used_bytes can be null (in-progress create / errored read)", async () => {
    const deps = makeDeps({ diskUsageBytes: async () => null });
    const r = await buildWellResource("pete", deps);
    expect(r!.disk_used_bytes).toBeNull();
  });

  test("auto_sleep_seconds omitted when record doesn't carry it", async () => {
    const deps = makeDeps();
    const r = await buildWellResource("pete", deps);
    expect("auto_sleep_seconds" in r!).toBe(false);
  });

  test("auto_sleep_seconds: null is preserved (never-sleep mark)", async () => {
    const deps = makeDeps({
      findWell: async (n) => record({ name: n, auto_sleep_seconds: null }),
    });
    const r = await buildWellResource("pete", deps);
    expect(r!.auto_sleep_seconds).toBeNull();
  });

  test("auto_sleep_seconds: number is preserved", async () => {
    const deps = makeDeps({
      findWell: async (n) => record({ name: n, auto_sleep_seconds: 30 }),
    });
    const r = await buildWellResource("pete", deps);
    expect(r!.auto_sleep_seconds).toBe(30);
  });

  test("lumeNameOf is used for the lume.info lookup (pool-adopted divergence)", async () => {
    let captured = "";
    const deps = makeDeps({
      findWell: async (n) => record({ name: n }),
      lumeNameOf: (r) => `pool-${r.name}`,
      lumeInfo: async (lumeName) => {
        captured = lumeName;
        return { status: "running" };
      },
    });
    await buildWellResource("pete", deps);
    expect(captured).toBe("pool-pete");
  });

  test("last_running_at is always null (tracked elsewhere)", async () => {
    const deps = makeDeps();
    const r = await buildWellResource("pete", deps);
    expect(r!.last_running_at).toBeNull();
  });

  test("ip null when DHCP lease absent", async () => {
    const deps = makeDeps({ resolveWellIp: async () => null });
    const r = await buildWellResource("pete", deps);
    expect(r!.ip).toBeNull();
  });
});
