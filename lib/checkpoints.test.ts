import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSplite } from "./registry.ts";
import { createCheckpoint, listCheckpoints } from "./checkpoints.ts";

describe("checkpoints", () => {
  let tmpState: string;
  let tmpLume: string;

  beforeEach(async () => {
    tmpState = await mkdtemp(join(tmpdir(), "splites-cp-state-"));
    tmpLume = await mkdtemp(join(tmpdir(), "splites-cp-lume-"));
    process.env.SPLITES_STATE_DIR = tmpState;
    process.env.SPLITES_LUME_STORAGE = tmpLume;

    await addSplite({
      name: "pete",
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
    });
    // Stand-in bundle disk under SPLITES_LUME_STORAGE.
    await mkdir(join(tmpLume, "pete"), { recursive: true });
    await writeFile(join(tmpLume, "pete", "disk.img"), "diskbytes");
  });

  afterEach(async () => {
    delete process.env.SPLITES_STATE_DIR;
    delete process.env.SPLITES_LUME_STORAGE;
    await rm(tmpState, { recursive: true, force: true });
    await rm(tmpLume, { recursive: true, force: true });
  });

  test("create writes disk.img + meta.json under checkpoints/<id>/", async () => {
    const cp = await createCheckpoint("pete");
    expect(cp.id).toMatch(/^\d+$/);
    expect(cp.size_bytes).toBe("diskbytes".length);
    const dir = join(tmpState, "vms", "pete", "checkpoints", cp.id);
    expect(existsSync(join(dir, "disk.img"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
  });

  test("create errors when splite isn't in registry", async () => {
    await expect(createCheckpoint("nope")).rejects.toThrow(/not found/);
  });

  test("create errors when bundle disk is missing", async () => {
    await rm(join(tmpLume, "pete", "disk.img"));
    await expect(createCheckpoint("pete")).rejects.toThrow(/no bundle disk/);
  });

  test("list returns nothing when no checkpoints exist", async () => {
    expect(await listCheckpoints("pete")).toEqual([]);
  });

  test("list returns checkpoints sorted by id", async () => {
    const a = await createCheckpoint("pete");
    await Bun.sleep(2);
    const b = await createCheckpoint("pete");
    const all = await listCheckpoints("pete");
    expect(all.map((c) => c.id)).toEqual([a.id, b.id]);
  });
});
