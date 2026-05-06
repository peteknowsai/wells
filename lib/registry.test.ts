import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSplite,
  findSplite,
  listSplites,
  loadRegistry,
  removeSplite,
  type SpliteRecord,
} from "./registry.ts";

const sample = (name: string, uuid = "u-" + name): SpliteRecord => ({
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
    tmp = await mkdtemp(join(tmpdir(), "splites-registry-test-"));
    process.env.SPLITES_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.SPLITES_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("empty when file absent", async () => {
    const reg = await loadRegistry();
    expect(reg.splites).toEqual([]);
  });

  test("addSplite + findSplite round-trips", async () => {
    const r = sample("pete");
    await addSplite(r);
    expect(await findSplite("pete")).toEqual(r);
  });

  test("addSplite rejects duplicates", async () => {
    await addSplite(sample("pete"));
    await expect(addSplite(sample("pete"))).rejects.toThrow(/already exists/);
  });

  test("removeSplite returns true on removal, false on miss", async () => {
    await addSplite(sample("pete"));
    expect(await removeSplite("pete")).toBe(true);
    expect(await removeSplite("pete")).toBe(false);
    expect(await findSplite("pete")).toBeUndefined();
  });

  test("listSplites returns all in insertion order", async () => {
    await addSplite(sample("a"));
    await addSplite(sample("b"));
    await addSplite(sample("c"));
    const all = await listSplites();
    expect(all.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  test("registry file is mode 0600 (private)", async () => {
    await addSplite(sample("pete"));
    const s = await stat(join(tmp, "registry.json"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("findSplite returns undefined for missing", async () => {
    expect(await findSplite("nope")).toBeUndefined();
  });
});
