import { describe, expect, test } from "bun:test";
import {
  doctorExitCode,
  gatherDoctorReport,
  renderDoctorText,
  type DoctorDeps,
  type DoctorReport,
} from "./doctor.ts";

const HEALTHY_REPORT: DoctorReport = {
  result: "healthy",
  welld: {
    reachable: true,
    version: "0.1.0-pre",
    uptime: "5m",
    degraded: false,
    lume_owned: true,
    respawns: { last_1min: 0, last_5min: 0, last_hour: 0 },
  },
  lume: { reachable: true, status: "healthy", vm_count: 0, max_vms: 2 },
  orphans: [],
  xpc_children: [],
  wells: {
    listed: true,
    entries: [{ name: "pete", status: "stopped", ip: "192.168.64.7" }],
  },
};

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    fetchHealthz: async () => ({
      ok: true,
      status: 200,
      body: {
        version: "0.1.0-pre",
        started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        lume: {
          owned: true,
          respawns_last_1min: 0,
          respawns_last_5min: 0,
          respawns_last_hour: 0,
        },
        degraded: false,
      },
    }),
    fetchLume: async () => ({
      ok: true,
      status: 200,
      body: { status: "healthy", vm_count: 0, max_vms: 2 },
    }),
    fetchWells: async () => [{ name: "pete", status: "stopped", ip: "192.168.64.7" }],
    scanOrphans: async () => [],
    scanXpcChildren: async () => [],
    ...overrides,
  };
}

describe("doctorExitCode", () => {
  test("healthy → 0", () => expect(doctorExitCode("healthy")).toBe(0));
  test("unhealthy → 1", () => expect(doctorExitCode("unhealthy")).toBe(1));
  test("degraded → 2", () => expect(doctorExitCode("degraded")).toBe(2));
});

describe("gatherDoctorReport", () => {
  test("healthy when everything reachable + degraded=false", async () => {
    const r = await gatherDoctorReport(makeDeps());
    expect(r.result).toBe("healthy");
  });

  test("unhealthy when welld unreachable", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        fetchHealthz: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    expect(r.result).toBe("unhealthy");
    expect(r.welld.reachable).toBe(false);
  });

  test("unhealthy when lume unreachable", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        fetchLume: async () => ({ ok: false, status: 503 }),
      }),
    );
    expect(r.result).toBe("unhealthy");
    expect(r.lume.reachable).toBe(false);
  });

  test("unhealthy when wells list fails", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        fetchWells: async () => {
          throw new Error("registry locked");
        },
      }),
    );
    expect(r.result).toBe("unhealthy");
    expect(r.wells.listed).toBe(false);
  });

  test("degraded when welld reports degraded=true", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        fetchHealthz: async () => ({
          ok: true,
          status: 200,
          body: {
            version: "0.1.0-pre",
            started_at: new Date(Date.now() - 60_000).toISOString(),
            lume: {
              owned: true,
              respawns_last_1min: 2,
              respawns_last_5min: 7,
              respawns_last_hour: 15,
            },
            degraded: true,
          },
        }),
      }),
    );
    expect(r.result).toBe("degraded");
    if (r.welld.reachable) {
      expect(r.welld.degraded).toBe(true);
      expect(r.welld.respawns.last_5min).toBe(7);
    }
  });

  test("populates orphan list from scanOrphans", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        scanOrphans: async () => [
          { pid: 1234, name: "stale-1" },
          { pid: 5678, name: "stale-2" },
        ],
      }),
    );
    expect(r.orphans).toHaveLength(2);
    expect(r.orphans[0]).toEqual({ pid: 1234, name: "stale-1" });
  });

  test("preserves all wells from fetchWells (with null IPs)", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        fetchWells: async () => [
          { name: "a", status: "stopped", ip: null },
          { name: "b", status: "running", ip: "192.168.64.10" },
        ],
      }),
    );
    if (r.wells.listed) {
      expect(r.wells.entries).toHaveLength(2);
      expect(r.wells.entries[0]?.ip).toBeNull();
      expect(r.wells.entries[1]?.ip).toBe("192.168.64.10");
    }
  });

  test("XPC orphan: more VZ children than lume VMs → degraded", async () => {
    // Classic B.0.6 / B.0.7.f scenario: lume crashed and respawned,
    // SharedVM cache lost, but the VZ XPC child kept running.
    const r = await gatherDoctorReport(
      makeDeps({
        fetchLume: async () => ({
          ok: true,
          status: 200,
          body: { status: "healthy", vm_count: 0, max_vms: 2 },
        }),
        scanXpcChildren: async () => [{ pid: 99001 }],
      }),
    );
    expect(r.result).toBe("degraded");
    expect(r.xpc_children).toHaveLength(1);
  });

  test("XPC matched: count equals lume vm_count → still healthy", async () => {
    const r = await gatherDoctorReport(
      makeDeps({
        fetchLume: async () => ({
          ok: true,
          status: 200,
          body: { status: "healthy", vm_count: 1, max_vms: 2 },
        }),
        scanXpcChildren: async () => [{ pid: 99001 }],
      }),
    );
    expect(r.result).toBe("healthy");
  });

  test("XPC under-count: fewer children than lume claims → not degraded", async () => {
    // Mid-shutdown: lume still has the cache entry but VZ child
    // already exited. We surface it but don't degrade — transient.
    const r = await gatherDoctorReport(
      makeDeps({
        fetchLume: async () => ({
          ok: true,
          status: 200,
          body: { status: "healthy", vm_count: 2, max_vms: 4 },
        }),
        scanXpcChildren: async () => [{ pid: 99001 }],
      }),
    );
    expect(r.result).toBe("healthy");
  });
});

describe("renderDoctorText XPC section", () => {
  function reportWithXpc(
    xpcCount: number,
    lumeVmCount: number,
  ): DoctorReport {
    return {
      ...HEALTHY_REPORT,
      lume: { reachable: true, status: "healthy", vm_count: lumeVmCount, max_vms: 2 },
      xpc_children: Array.from({ length: xpcCount }, (_, i) => ({ pid: 1000 + i })),
    };
  }

  test("matched count: no orphan banner", () => {
    const text = renderDoctorText(reportWithXpc(1, 1));
    expect(text).toContain("count: 1 (lume reports 1 VMs)");
    expect(text).not.toContain("ORPHAN");
  });

  test("orphan: ORPHAN banner with pids", () => {
    const text = renderDoctorText(reportWithXpc(2, 0));
    expect(text).toContain("ORPHAN: 2 XPC child(ren)");
    expect(text).toContain("pid 1000");
    expect(text).toContain("pid 1001");
  });

  test("under-count: WARNING but not ORPHAN", () => {
    const text = renderDoctorText(reportWithXpc(0, 1));
    expect(text).toContain("WARNING");
    expect(text).not.toContain("ORPHAN");
  });
});

describe("renderDoctorText", () => {
  test("renders all sections + healthy result", () => {
    const out = renderDoctorText(HEALTHY_REPORT);
    expect(out).toContain("=== welld ===");
    expect(out).toContain("=== lume serve ===");
    expect(out).toContain("=== orphaned lume run subprocesses ===");
    expect(out).toContain("=== wells ===");
    expect(out).toContain("RESULT: wells is HEALTHY");
  });

  test("renders welld unreachable with error", () => {
    const r: DoctorReport = {
      ...HEALTHY_REPORT,
      result: "unhealthy",
      welld: { reachable: false, error: "ECONNREFUSED 127.0.0.1:7878" },
    };
    expect(renderDoctorText(r)).toContain("unreachable: ECONNREFUSED");
  });

  test("renders degraded with explanation suffix", () => {
    const r: DoctorReport = { ...HEALTHY_REPORT, result: "degraded" };
    const out = renderDoctorText(r);
    expect(out).toContain("RESULT: wells is DEGRADED");
    expect(out).toContain("operational but fragile");
  });

  test("renders orphan list", () => {
    const r: DoctorReport = {
      ...HEALTHY_REPORT,
      orphans: [{ pid: 1234, name: "stale-1" }],
    };
    expect(renderDoctorText(r)).toContain("pid 1234 → stale-1");
  });

  test("shows '(none)' when no orphans", () => {
    expect(renderDoctorText(HEALTHY_REPORT)).toContain("(none)");
  });

  test("shows '(no wells)' for empty registry", () => {
    const r: DoctorReport = {
      ...HEALTHY_REPORT,
      wells: { listed: true, entries: [] },
    };
    expect(renderDoctorText(r)).toContain("(no wells)");
  });

  test("renders null IP as em-dash", () => {
    const r: DoctorReport = {
      ...HEALTHY_REPORT,
      wells: {
        listed: true,
        entries: [{ name: "pete", status: "stopped", ip: null }],
      },
    };
    expect(renderDoctorText(r)).toContain("—");
  });
});
