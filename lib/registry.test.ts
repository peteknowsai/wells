import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWell,
  findWell,
  listWells,
  loadRegistry,
  removeWell,
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
