// NOTE: this file mutates `process.env.WELL_STATE_DIR` and
// `process.env.WELL_LUME_STORAGE` in beforeEach. Bun's default test
// mode is per-file sequential, which is fine — but `bun test
// --concurrent` will trample these envs across tests in the same
// describe and fail. See `docs/findings-w15-test-isolation.md`.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { addWell, type R2Config } from "./registry.ts";
import {
  createCheckpoint,
  ensureCheckpointLocal,
  expireCheckpoint,
  gcOldCheckpoints,
  listCheckpoints,
  parseDuration,
} from "./checkpoints.ts";

const R2: R2Config = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  bucket: "test",
  access_key_id: "ak",
  secret_access_key: "sk",
};

// Fixture name must not collide with any real lume VM — see destroy.test.ts.
const FIXTURE = `well-test-fixture-${randomUUID().slice(0, 8)}`;

describe("checkpoints", () => {
  let tmpState: string;
  let tmpLume: string;

  beforeEach(async () => {
    tmpState = await mkdtemp(join(tmpdir(), "wells-cp-state-"));
    tmpLume = await mkdtemp(join(tmpdir(), "wells-cp-lume-"));
    process.env.WELL_STATE_DIR = tmpState;
    process.env.WELL_LUME_STORAGE = tmpLume;

    await addWell({
      name: FIXTURE,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
    });
    // Stand-in bundle disk under WELL_LUME_STORAGE. This is what
    // bundleDiskPath() resolves to for our code; the real lume serve
    // doesn't know about FIXTURE so lume.info() returns null, skipping
    // the running-well sync path inside createCheckpoint.
    await mkdir(join(tmpLume, FIXTURE), { recursive: true });
    await writeFile(join(tmpLume, FIXTURE, "disk.img"), "diskbytes");
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
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

  test("create errors when well isn't in registry", async () => {
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

  test("R2 — no upload attempted when well has no r2 config", async () => {
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
    const fxR2 = `well-test-r2-${randomUUID().slice(0, 8)}`;
    await addWell({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.WELL_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.WELL_LUME_STORAGE!, fxR2, "disk.img"), "x");

    const cp = await createCheckpoint(fxR2, {
      r2Upload: async (cfg, n, id) => {
        expect(cfg).toEqual(R2);
        expect(n).toBe(fxR2);
        return {
          key: `wells/${n}/checkpoints/${id}/disk.img`,
          bytes: 1,
          durationMs: 1,
        };
      },
    });
    expect(cp.r2_uploaded).toBe(true);
    expect(cp.r2_key).toBe(`wells/${fxR2}/checkpoints/${cp.id}/disk.img`);

    // meta.json on disk should reflect the same fields.
    const metaPath = join(
      process.env.WELL_STATE_DIR!,
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
    const fxR2 = `well-test-r2dl-${randomUUID().slice(0, 8)}`;
    await addWell({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.WELL_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.WELL_LUME_STORAGE!, fxR2, "disk.img"), "x");
    const cp = await createCheckpoint(fxR2, {
      r2Upload: async (cfg, n, id) => ({
        key: `wells/${n}/checkpoints/${id}/disk.img`,
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

  test("ensureCheckpointLocal — local missing, well has R2: implicit fetch", async () => {
    const fxR2 = `well-test-r2hyd-${randomUUID().slice(0, 8)}`;
    await addWell({
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
    const fxR2 = `well-test-r2err-${randomUUID().slice(0, 8)}`;
    await addWell({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.WELL_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.WELL_LUME_STORAGE!, fxR2, "disk.img"), "x");

    const cp = await createCheckpoint(fxR2, {
      r2Upload: async () => {
        throw new Error("network down");
      },
    });
    // Local checkpoint still exists; r2_uploaded stays falsy.
    expect(cp.id).toMatch(/^\d+$/);
    expect(cp.r2_uploaded).toBeFalsy();
  });

  test("parseDuration handles all unit forms", () => {
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("30m")).toBe(30 * 60);
    expect(parseDuration("12h")).toBe(12 * 3600);
    expect(parseDuration("7d")).toBe(7 * 86400);
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration("foo")).toBeUndefined();
    expect(parseDuration("100")).toBeUndefined();
    expect(parseDuration("5w")).toBeUndefined();
  });

  test("retention TTL — expired checkpoints get GC'd regardless of count", async () => {
    const cp1 = await createCheckpoint(FIXTURE, { retainForSeconds: 1 });
    expect(cp1.expires_at).toBeDefined();
    expect(cp1.retain_for_seconds).toBe(1);

    // Walk the clock forward past the TTL.
    const future = Date.parse(cp1.expires_at!) + 1000;
    const removed = await gcOldCheckpoints(FIXTURE, { nowMs: future });
    expect(removed).toEqual([cp1.id]);
    expect(await listCheckpoints(FIXTURE)).toEqual([]);
  });

  test("retention TTL — TTL doesn't grant immortality; count GC still applies", async () => {
    // 7 creates with TTLs in the distant future → internal gc on each
    // create keeps last-5; TTLs far in the future don't save the oldest.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const cp = await createCheckpoint(FIXTURE, { retainForSeconds: 86400 });
      ids.push(cp.id);
      await Bun.sleep(2);
    }
    const surviving = await listCheckpoints(FIXTURE);
    expect(surviving.length).toBe(5);
    expect(surviving.map((c) => c.id)).toEqual(ids.slice(2));
  });

  test("expireCheckpoint removes the directory and reports removed=true", async () => {
    const cp = await createCheckpoint(FIXTURE);
    const dir = join(tmpState, "vms", FIXTURE, "checkpoints", cp.id);
    expect(existsSync(dir)).toBe(true);
    const r = await expireCheckpoint(FIXTURE, cp.id);
    expect(r).toEqual({ removed: true });
    expect(existsSync(dir)).toBe(false);
  });

  test("expireCheckpoint on missing id reports removed=false", async () => {
    const r = await expireCheckpoint(FIXTURE, "nonexistent");
    expect(r).toEqual({ removed: false });
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

  test("R2 GC — rotated checkpoints with r2_uploaded also get deleted from R2", async () => {
    const fxR2 = `well-test-gc-r2-${randomUUID().slice(0, 8)}`;
    await addWell({
      name: fxR2,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      r2: R2,
    });
    await mkdir(join(process.env.WELL_LUME_STORAGE!, fxR2), { recursive: true });
    await writeFile(join(process.env.WELL_LUME_STORAGE!, fxR2, "disk.img"), "x");

    const r2DeleteCalls: { name: string; id: string }[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const cp = await createCheckpoint(fxR2, {
        r2Upload: async (_cfg, n, id) => ({
          key: `wells/${n}/checkpoints/${id}/disk.img`,
          bytes: 1,
          durationMs: 1,
        }),
        r2Delete: async (_cfg, n, id) => {
          r2DeleteCalls.push({ name: n, id });
        },
      });
      ids.push(cp.id);
      await Bun.sleep(2);
    }

    expect(r2DeleteCalls).toEqual([
      { name: fxR2, id: ids[0]! },
      { name: fxR2, id: ids[1]! },
    ]);
    const surviving = await listCheckpoints(fxR2);
    expect(surviving.map((c) => c.id)).toEqual(ids.slice(2));
  });

  test("R2 GC — well with no R2 config skips r2Delete during rotation", async () => {
    let r2DeleteCalls = 0;
    for (let i = 0; i < 7; i++) {
      await createCheckpoint(FIXTURE, {
        r2Delete: async () => {
          r2DeleteCalls++;
        },
      });
      await Bun.sleep(2);
    }
    expect(r2DeleteCalls).toBe(0);
    expect((await listCheckpoints(FIXTURE)).length).toBe(5);
  });
});
