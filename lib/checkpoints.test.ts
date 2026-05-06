import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { addSplite } from "./registry.ts";
import { createCheckpoint, listCheckpoints } from "./checkpoints.ts";

// Fixture name must not collide with any real lume VM — see destroy.test.ts.
const FIXTURE = `splite-test-fixture-${randomUUID().slice(0, 8)}`;

describe("checkpoints", () => {
  let tmpState: string;
  let tmpLume: string;

  beforeEach(async () => {
    tmpState = await mkdtemp(join(tmpdir(), "splites-cp-state-"));
    tmpLume = await mkdtemp(join(tmpdir(), "splites-cp-lume-"));
    process.env.SPLITES_STATE_DIR = tmpState;
    process.env.SPLITES_LUME_STORAGE = tmpLume;

    await addSplite({
      name: FIXTURE,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
    });
    // Stand-in bundle disk under SPLITES_LUME_STORAGE. This is what
    // bundleDiskPath() resolves to for our code; the real lume serve
    // doesn't know about FIXTURE so lume.info() returns null, skipping
    // the running-splite sync path inside createCheckpoint.
    await mkdir(join(tmpLume, FIXTURE), { recursive: true });
    await writeFile(join(tmpLume, FIXTURE, "disk.img"), "diskbytes");
  });

  afterEach(async () => {
    delete process.env.SPLITES_STATE_DIR;
    delete process.env.SPLITES_LUME_STORAGE;
    await rm(tmpState, { recursive: true, force: true });
    await rm(tmpLume, { recursive: true, force: true });
  });

  test("create writes disk.img + meta.json under checkpoints/<id>/", async () => {
    const cp = await createCheckpoint(FIXTURE);
    expect(cp.id).toMatch(/^\d+$/);
    expect(cp.size_bytes).toBe("diskbytes".length);
    const dir = join(tmpState, "vms", FIXTURE, "checkpoints", cp.id);
    expect(existsSync(join(dir, "disk.img"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
  });

  test("create errors when splite isn't in registry", async () => {
    await expect(createCheckpoint("nope")).rejects.toThrow(/not found/);
  });

  test("create errors when bundle disk is missing", async () => {
    await rm(join(tmpLume, FIXTURE, "disk.img"));
    await expect(createCheckpoint(FIXTURE)).rejects.toThrow(/no bundle disk/);
  });

  test("list returns nothing when no checkpoints exist", async () => {
    expect(await listCheckpoints(FIXTURE)).toEqual([]);
  });

  test("list returns checkpoints sorted by id", async () => {
    const a = await createCheckpoint(FIXTURE);
    await Bun.sleep(2);
    const b = await createCheckpoint(FIXTURE);
    const all = await listCheckpoints(FIXTURE);
    expect(all.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  test("last-5 retention: 7 creates → only 5 survive (newest)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const cp = await createCheckpoint(FIXTURE);
      ids.push(cp.id);
      await Bun.sleep(2);  // ensure distinct millisecond ids
    }
    const surviving = await listCheckpoints(FIXTURE);
    expect(surviving.length).toBe(5);
    expect(surviving.map((c) => c.id)).toEqual(ids.slice(2));
  });
});
