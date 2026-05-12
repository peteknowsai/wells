import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWell,
  findWell,
  listWells,
  loadRegistry,
  lumeNameOf,
  removeWell,
  resolveLumeName,
  updateWellAuth,
  updateWellAutoSleep,
  type WellRecord,
} from "./registry.ts";

const sample = (name: string, uuid = "u-" + name): WellRecord => ({
  name,
  uuid,
  created_at: "2026-05-06T12:00:00Z",
  cpu: 4,
  memory: "4GB",
  disk_size: "50GB",
});

describe("registry", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-registry-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("empty when file absent", async () => {
    const reg = await loadRegistry();
    expect(reg.wells).toEqual([]);
  });

  test("addWell + findWell round-trips", async () => {
    const r = sample("pete");
    await addWell(r);
    expect(await findWell("pete")).toEqual(r);
  });

  test("addWell rejects duplicates", async () => {
    await addWell(sample("pete"));
    await expect(addWell(sample("pete"))).rejects.toThrow(/already exists/);
  });

  test("removeWell returns true on removal, false on miss", async () => {
    await addWell(sample("pete"));
    expect(await removeWell("pete")).toBe(true);
    expect(await removeWell("pete")).toBe(false);
    expect(await findWell("pete")).toBeUndefined();
  });

  test("listWells returns all in insertion order", async () => {
    await addWell(sample("a"));
    await addWell(sample("b"));
    await addWell(sample("c"));
    const all = await listWells();
    expect(all.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  test("registry file is mode 0600 (private)", async () => {
    await addWell(sample("pete"));
    const s = await stat(join(tmp, "registry.json"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("findWell returns undefined for missing", async () => {
    expect(await findWell("nope")).toBeUndefined();
  });
});

// A.1.4.c.iv — pool-adopted wells keep their `pool-XXXX` lume bundle
// name across adoption (Apple's VZ saved-state encodes absolute paths
// to nvram.bin etc., so renaming the lume dir breaks restore). Every
// lume-side caller must funnel through these helpers so wells with
// lume_name set route lume calls correctly.
describe("lume_name resolution", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-lumename-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("lumeNameOf returns name when lume_name is unset (fresh-create)", () => {
    const r: WellRecord = sample("freshie");
    expect(lumeNameOf(r)).toBe("freshie");
  });

  test("lumeNameOf returns lume_name when set (adopted)", () => {
    const r: WellRecord = { ...sample("petes-cell"), lume_name: "pool-deadbeef" };
    expect(lumeNameOf(r)).toBe("pool-deadbeef");
  });

  test("resolveLumeName falls back to input when no record exists", async () => {
    expect(await resolveLumeName("orphan")).toBe("orphan");
  });

  test("resolveLumeName returns operator name for fresh-create wells", async () => {
    await addWell(sample("freshie"));
    expect(await resolveLumeName("freshie")).toBe("freshie");
  });

  test("resolveLumeName returns lume_name for adopted wells", async () => {
    const r: WellRecord = { ...sample("petes-cell"), lume_name: "pool-deadbeef" };
    await addWell(r);
    expect(await resolveLumeName("petes-cell")).toBe("pool-deadbeef");
  });

  describe("updateWellAuth", () => {
    test("sparse-updates auth on an existing well, returns the updated record", async () => {
      await addWell(sample("pete"));
      const updated = await updateWellAuth("pete", "public");
      expect(updated?.name).toBe("pete");
      expect(updated?.auth).toBe("public");
      const persisted = await findWell("pete");
      expect(persisted?.auth).toBe("public");
    });

    test("returns undefined when well does not exist (no-op)", async () => {
      const result = await updateWellAuth("ghost", "public");
      expect(result).toBeUndefined();
    });

    test("auth flip 'public' → 'well' is persisted", async () => {
      const rec: WellRecord = { ...sample("flipper"), auth: "public" };
      await addWell(rec);
      await updateWellAuth("flipper", "well");
      const after = await findWell("flipper");
      expect(after?.auth).toBe("well");
    });

    test("only the target well's auth changes (siblings untouched)", async () => {
      await addWell(sample("a"));
      await addWell(sample("b"));
      await updateWellAuth("a", "public");
      expect((await findWell("a"))?.auth).toBe("public");
      expect((await findWell("b"))?.auth).toBeUndefined();
    });
  });

  describe("updateWellAutoSleep", () => {
    test("sets a positive number override and returns the updated record", async () => {
      await addWell(sample("pete"));
      const updated = await updateWellAutoSleep("pete", 600);
      expect(updated?.auto_sleep_seconds).toBe(600);
      expect((await findWell("pete"))?.auto_sleep_seconds).toBe(600);
    });

    test("sets null override (never sleep)", async () => {
      await addWell(sample("pete"));
      await updateWellAutoSleep("pete", null);
      // null is meaningful (distinct from undefined "use default").
      // Round-trip through JSON preserves null.
      const after = await findWell("pete");
      expect(after).toBeDefined();
      expect(after?.auto_sleep_seconds).toBeNull();
    });

    test("overwrites a previously-set value", async () => {
      await addWell(sample("pete"));
      await updateWellAutoSleep("pete", 600);
      await updateWellAutoSleep("pete", 60);
      expect((await findWell("pete"))?.auto_sleep_seconds).toBe(60);
    });

    test("returns undefined when well does not exist", async () => {
      const result = await updateWellAutoSleep("ghost", 60);
      expect(result).toBeUndefined();
    });

    test("only the target well's override changes (siblings untouched)", async () => {
      await addWell(sample("a"));
      await addWell({ ...sample("b"), auto_sleep_seconds: 300 });
      await updateWellAutoSleep("a", null);
      expect((await findWell("a"))?.auto_sleep_seconds).toBeNull();
      expect((await findWell("b"))?.auto_sleep_seconds).toBe(300);
    });
  });
});
