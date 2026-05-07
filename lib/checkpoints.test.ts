import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { addSplite, type R2Config } from "./registry.ts";
import {
  createCheckpoint,
  ensureCheckpointLocal,
  listCheckpoints,
} from "./checkpoints.ts";

const R2: R2Config = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  bucket: "test",
  access_key_id: "ak",
  secret_access_key: "sk",
};

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

  test("R2 — no upload attempted when splite has no r2 config", async () => {
    let called = false;
    await createCheckpoint(FIXTURE, {
      r2Upload: async () => {
        called = true;
        return { key: "x", bytes: 0, durationMs: 0 };
      },
    });
    expect(called).toBe(false);
  });

  test("R2 — successful upload writes r2_uploaded fields into meta", async () => {
    const fxR2 = `splite-test-r2-${randomUUID().slice(0, 8)}`;
    await addSplite({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.SPLITES_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.SPLITES_LUME_STORAGE!, fxR2, "disk.img"), "x");

    const cp = await createCheckpoint(fxR2, {
      r2Upload: async (cfg, n, id) => {
        expect(cfg).toEqual(R2);
        expect(n).toBe(fxR2);
        return {
          key: `splites/${n}/checkpoints/${id}/disk.img`,
          bytes: 1,
          durationMs: 1,
        };
      },
    });
    expect(cp.r2_uploaded).toBe(true);
    expect(cp.r2_key).toBe(`splites/${fxR2}/checkpoints/${cp.id}/disk.img`);

    // meta.json on disk should reflect the same fields.
    const metaPath = join(
      process.env.SPLITES_STATE_DIR!,
      "vms",
      fxR2,
      "checkpoints",
      cp.id,
      "meta.json",
    );
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    expect(meta.r2_uploaded).toBe(true);
    expect(typeof meta.r2_uploaded_at).toBe("string");
  });

  test("ensureCheckpointLocal — local exists, no fetch attempted", async () => {
    const cp = await createCheckpoint(FIXTURE);
    let called = false;
    const path = await ensureCheckpointLocal(FIXTURE, cp.id, {
      r2Download: async () => {
        called = true;
        return { bytes: 0, durationMs: 0 };
      },
    });
    expect(called).toBe(false);
    expect(path).toContain(`/${cp.id}/disk.img`);
  });

  test("ensureCheckpointLocal — fromR2=true forces a fetch even with local present", async () => {
    const fxR2 = `splite-test-r2dl-${randomUUID().slice(0, 8)}`;
    await addSplite({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.SPLITES_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.SPLITES_LUME_STORAGE!, fxR2, "disk.img"), "x");
    const cp = await createCheckpoint(fxR2, {
      r2Upload: async (cfg, n, id) => ({
        key: `splites/${n}/checkpoints/${id}/disk.img`,
        bytes: 1,
        durationMs: 1,
      }),
    });

    let calledWith: { name: string; id: string; localPath: string } | null = null;
    await ensureCheckpointLocal(fxR2, cp.id, {
      fromR2: true,
      r2Download: async (_cfg, n, id, localPath) => {
        calledWith = { name: n, id, localPath };
        // Simulate the download by writing fresh bytes — overwrites local.
        await writeFile(localPath, "freshFromR2");
        return { bytes: "freshFromR2".length, durationMs: 1 };
      },
    });
    expect(calledWith?.name).toBe(fxR2);
    expect(calledWith?.id).toBe(cp.id);
  });

  test("ensureCheckpointLocal — local missing, splite has R2: implicit fetch", async () => {
    const fxR2 = `splite-test-r2hyd-${randomUUID().slice(0, 8)}`;
    await addSplite({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    let called = false;
    await ensureCheckpointLocal(fxR2, "1234567890", {
      r2Download: async (_cfg, _n, _id, localPath) => {
        called = true;
        await writeFile(localPath, "downloadedBytes");
        return { bytes: "downloadedBytes".length, durationMs: 1 };
      },
    });
    expect(called).toBe(true);
  });

  test("ensureCheckpointLocal — fromR2 with no R2 config errors clearly", async () => {
    await expect(
      ensureCheckpointLocal(FIXTURE, "9999999", { fromR2: true }),
    ).rejects.toThrow(/no R2 config/);
  });

  test("R2 — failed upload doesn't fail checkpoint create", async () => {
    const fxR2 = `splite-test-r2err-${randomUUID().slice(0, 8)}`;
    await addSplite({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.SPLITES_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.SPLITES_LUME_STORAGE!, fxR2, "disk.img"), "x");

    const cp = await createCheckpoint(fxR2, {
      r2Upload: async () => {
        throw new Error("network down");
      },
    });
    // Local checkpoint still exists; r2_uploaded stays falsy.
    expect(cp.id).toMatch(/^\d+$/);
    expect(cp.r2_uploaded).toBeFalsy();
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
