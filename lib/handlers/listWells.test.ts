import { describe, expect, test } from "bun:test";
import { handleListWells, type ListWellsDeps } from "./listWells.ts";

// List view fans out per-row: registry rows × lume status × per-well IP.
// Tests pin the cross-product mapping logic, the missing-from-lume case,
// and the url composition rule.

function makeDeps(overrides: Partial<ListWellsDeps> = {}): ListWellsDeps {
  return {
    listWells: async () => [],
    listLumeVms: async () => [],
    publicBase: () => null,
    resolveWellIp: async () => null,
    getWedgeLabel: () => "ok",
    ...overrides,
  };
}

describe("handleListWells", () => {
  test("empty registry → empty wells array, 200", async () => {
    const res = await handleListWells(makeDeps());
    expect(res.status).toBe(200);
    const body = await res.json() as { wells: unknown[] };
    expect(body.wells).toEqual([]);
  });

  test("registry row + matching lume entry → status from lume", async () => {
    const deps = makeDeps({
      listWells: async () => [{ name: "pete", created_at: "2026-05-12T00:00:00Z" }],
      listLumeVms: async () => [{ name: "pete", status: "running" }],
    });
    const res = await handleListWells(deps);
    const body = await res.json() as { wells: Array<{ name: string; status: string }> };
    expect(body.wells).toHaveLength(1);
    expect(body.wells[0].status).toBe("running");
  });

  test("registry row + no lume entry → status 'missing'", async () => {
    const deps = makeDeps({
      listWells: async () => [{ name: "ghost", created_at: "2026-05-12T00:00:00Z" }],
      listLumeVms: async () => [],
    });
    const res = await handleListWells(deps);
    const body = await res.json() as { wells: Array<{ status: string }> };
    expect(body.wells[0].status).toBe("missing");
  });

  test("publicBase set → url composed; null → url null", async () => {
    const withBase = makeDeps({
      listWells: async () => [{ name: "pete", created_at: "2026-05-12T00:00:00Z" }],
      publicBase: () => "cells.md",
    });
    const r1 = await handleListWells(withBase);
    const b1 = await r1.json() as { wells: Array<{ url: string | null }> };
    expect(b1.wells[0].url).toBe("https://pete.cells.md");

    const noBase = makeDeps({
      listWells: async () => [{ name: "pete", created_at: "2026-05-12T00:00:00Z" }],
      publicBase: () => null,
    });
    const r2 = await handleListWells(noBase);
    const b2 = await r2.json() as { wells: Array<{ url: string | null }> };
    expect(b2.wells[0].url).toBeNull();
  });

  test("resolveWellIp result flows into row.ip", async () => {
    const deps = makeDeps({
      listWells: async () => [{ name: "pete", created_at: "2026-05-12T00:00:00Z" }],
      resolveWellIp: async () => "192.168.65.42",
    });
    const res = await handleListWells(deps);
    const body = await res.json() as { wells: Array<{ ip: string | null }> };
    expect(body.wells[0].ip).toBe("192.168.65.42");
  });

  test("last_running_at is always null (tracked elsewhere)", async () => {
    const deps = makeDeps({
      listWells: async () => [{ name: "pete", created_at: "2026-05-12T00:00:00Z" }],
    });
    const res = await handleListWells(deps);
    const body = await res.json() as { wells: Array<{ last_running_at: string | null }> };
    expect(body.wells[0].last_running_at).toBeNull();
  });

  test("multiple rows preserved in registry order", async () => {
    const deps = makeDeps({
      listWells: async () => [
        { name: "alpha", created_at: "2026-05-12T00:00:00Z" },
        { name: "bravo", created_at: "2026-05-12T00:00:00Z" },
        { name: "charlie", created_at: "2026-05-12T00:00:00Z" },
      ],
    });
    const res = await handleListWells(deps);
    const body = await res.json() as { wells: Array<{ name: string }> };
    expect(body.wells.map((w) => w.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("wedge label flows through per-row from getWedgeLabel dep", async () => {
    const labels: Record<string, "ok" | "suspected" | "confirmed"> = {
      alpha: "ok",
      bravo: "suspected",
      charlie: "confirmed",
    };
    const deps = makeDeps({
      listWells: async () => [
        { name: "alpha", created_at: "2026-05-12T00:00:00Z" },
        { name: "bravo", created_at: "2026-05-12T00:00:00Z" },
        { name: "charlie", created_at: "2026-05-12T00:00:00Z" },
      ],
      getWedgeLabel: (n) => labels[n] ?? "ok",
    });
    const res = await handleListWells(deps);
    const body = await res.json() as { wells: Array<{ name: string; wedge: string }> };
    expect(body.wells.map((w) => ({ name: w.name, wedge: w.wedge }))).toEqual([
      { name: "alpha", wedge: "ok" },
      { name: "bravo", wedge: "suspected" },
      { name: "charlie", wedge: "confirmed" },
    ]);
  });
});
