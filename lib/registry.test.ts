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
});
