import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWell, type WellRecord } from "./registry.ts";
import {
  validateImageName,
  imageDiskPath,
  imageExists,
  imageMeta,
  listAliases,
  listImages,
  removeAlias,
  removeImage,
  resolveImageName,
  saveImage,
  setAlias,
} from "./imageStore.ts";
import { ImageResource } from "./schemas.ts";
import { Value } from "@sinclair/typebox/value";

const sampleWell = (name: string): WellRecord => ({
  name,
  uuid: "u-" + name,
  created_at: "2026-05-06T12:00:00Z",
  cpu: 4,
  memory: "4GB",
  disk_size: "50GB",
});

describe("validateImageName", () => {
  test("accepts well-formed names", () => {
    expect(() => validateImageName("ubuntu-base")).not.toThrow();
    expect(() => validateImageName("a")).not.toThrow();
    expect(() => validateImageName("a-b-c-1")).not.toThrow();
    // Canonical baked images carry the release in the name (W.72 alias
    // setup needs this to resolve).
    expect(() => validateImageName("ubuntu-25.10-base")).not.toThrow();
  });

  test("rejects bad shapes", () => {
    expect(() => validateImageName("")).toThrow();
    expect(() => validateImageName("-leading")).toThrow();
    expect(() => validateImageName("trailing-")).toThrow();
    expect(() => validateImageName(".leading")).toThrow();
    expect(() => validateImageName("trailing.")).toThrow();
    expect(() => validateImageName("UPPER")).toThrow();
    expect(() => validateImageName("under_score")).toThrow();
    expect(() => validateImageName("a".repeat(64))).toThrow();
  });
});

describe("imageStore", () => {
  let stateDir: string;
  let lumeDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "wells-images-state-"));
    lumeDir = await mkdtemp(join(tmpdir(), "wells-images-lume-"));
    process.env.WELL_STATE_DIR = stateDir;
    process.env.WELL_LUME_STORAGE = lumeDir;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
    await rm(stateDir, { recursive: true, force: true });
    await rm(lumeDir, { recursive: true, force: true });
  });

  test("listImages is empty when no images dir", async () => {
    expect(await listImages()).toEqual([]);
  });

  test("imageExists returns false for missing", async () => {
    expect(await imageExists("nope")).toBe(false);
    expect(await imageMeta("nope")).toBeNull();
  });

  test("saveImage clones a stopped well's disk into the store", async () => {
    await addWell(sampleWell("src"));
    const bundleDir = join(lumeDir, "src");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), "PRETEND_DISK_BYTES");

    const meta = await saveImage({
      fromWell: "src",
      imageName: "snap-1",
      notes: "first save",
    });

    expect(meta.name).toBe("snap-1");
    expect(meta.from_well).toBe("src");
    expect(meta.from_disk_size).toBe("50GB");
    expect(meta.notes).toBe("first save");
    expect(typeof meta.created_at).toBe("string");

    const cloned = await readFile(imageDiskPath("snap-1"), "utf-8");
    expect(cloned).toBe("PRETEND_DISK_BYTES");
  });

  test("saveImage refuses to overwrite an existing image", async () => {
    await addWell(sampleWell("src"));
    const bundleDir = join(lumeDir, "src");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), "x");

    await saveImage({ fromWell: "src", imageName: "dup" });
    await expect(
      saveImage({ fromWell: "src", imageName: "dup" }),
    ).rejects.toThrow(/already exists/);
  });

  test("saveImage fails when source well isn't registered", async () => {
    await expect(
      saveImage({ fromWell: "ghost", imageName: "snap" }),
    ).rejects.toThrow(/not found/);
  });

  test("saveImage fails when source well has no bundle disk", async () => {
    await addWell(sampleWell("src"));
    await expect(
      saveImage({ fromWell: "src", imageName: "snap" }),
    ).rejects.toThrow(/no bundle disk/);
  });

  test("saveImage rejects an invalid image name", async () => {
    await addWell(sampleWell("src"));
    await expect(
      saveImage({ fromWell: "src", imageName: "Bad_Name" }),
    ).rejects.toThrow(/invalid image name/);
  });

  test("listImages returns all images sorted by name", async () => {
    await addWell(sampleWell("src"));
    const bundleDir = join(lumeDir, "src");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), "x");

    await saveImage({ fromWell: "src", imageName: "zeta" });
    await saveImage({ fromWell: "src", imageName: "alpha" });
    await saveImage({ fromWell: "src", imageName: "mu" });

    const list = await listImages();
    expect(list.map((i) => i.name)).toEqual(["alpha", "mu", "zeta"]);
  });

  test("listImages skips image dirs without meta.json (malformed)", async () => {
    // Bake script + saveImage both write meta.json. A dir without
    // one is malformed; imageMeta returns null and listImages
    // skips it rather than synthesizing a fake record.
    const dir = join(stateDir, "images", "no-meta");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "disk.img"), "fake-image");

    const list = await listImages();
    expect(list).toHaveLength(0);
  });

  test("removeImage deletes the image dir, returns false on miss", async () => {
    await addWell(sampleWell("src"));
    const bundleDir = join(lumeDir, "src");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), "x");

    await saveImage({ fromWell: "src", imageName: "to-rm" });
    expect(await imageExists("to-rm")).toBe(true);

    expect(await removeImage("to-rm")).toBe(true);
    expect(await imageExists("to-rm")).toBe(false);
    expect(await removeImage("to-rm")).toBe(false);
  });

  test("listImages tolerates partial-shape meta.json (W.25 — cells team unblock)", async () => {
    // Pre-fix, ANY image whose meta.json was missing a required field
    // (or had an early-version shape) caused the welld GET endpoint
    // to return 500 — wiping the entire list and breaking cells's
    // bake conflict detection. Filter applies per-entry: malformed
    // entries get dropped + logged, valid ones are returned.
    await addWell(sampleWell("src"));
    const bundleDir = join(lumeDir, "src");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), "x");
    await saveImage({ fromWell: "src", imageName: "good" });

    // Hand-craft a malformed image: disk.img exists, meta.json is
    // missing the required `from_disk_size` field.
    const badDir = join(stateDir, "images", "partial-shape");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "disk.img"), "y");
    await writeFile(join(badDir, "meta.json"), JSON.stringify({
      name: "partial-shape",
      from_well: null,
      // from_disk_size missing — schema requires it
      created_at: "2026-05-10T08:00:00Z",
    }));

    const list = await listImages();
    // Both come back from listImages (it doesn't schema-validate).
    expect(list.map((i) => i.name).sort()).toEqual(["good", "partial-shape"]);

    // Per-entry filter (mirrors handleListImages welld-side logic):
    const valid = list.filter((m) => Value.Check(ImageResource, m));
    expect(valid.map((i) => i.name)).toEqual(["good"]);
  });

  test("imageMeta records size_bytes on disk", async () => {
    await addWell(sampleWell("src"));
    const bundleDir = join(lumeDir, "src");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), "0123456789");

    await saveImage({ fromWell: "src", imageName: "sized" });
    const m = await imageMeta("sized");
    expect(m).not.toBeNull();
    expect(typeof m!.size_bytes).toBe("number");
  });
});

describe("image aliases", () => {
  let stateDir: string;
  let lumeDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "wells-alias-state-"));
    lumeDir = await mkdtemp(join(tmpdir(), "wells-alias-lume-"));
    process.env.WELL_STATE_DIR = stateDir;
    process.env.WELL_LUME_STORAGE = lumeDir;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
    await rm(stateDir, { recursive: true, force: true });
    await rm(lumeDir, { recursive: true, force: true });
  });

  async function seedImage(name: string): Promise<void> {
    await addWell(sampleWell(`src-${name}`));
    const bundleDir = join(lumeDir, `src-${name}`);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "disk.img"), `BYTES-${name}`);
    await saveImage({ fromWell: `src-${name}`, imageName: name });
  }

  test("resolveImageName returns input verbatim when no alias", async () => {
    await seedImage("concrete");
    expect(await resolveImageName("concrete")).toBe("concrete");
    expect(await resolveImageName("unknown")).toBe("unknown");
  });

  test("setAlias + resolveImageName round-trips", async () => {
    await seedImage("ubuntu-25-10-base");
    await setAlias("ubuntu-base", "ubuntu-25-10-base");
    expect(await resolveImageName("ubuntu-base")).toBe("ubuntu-25-10-base");
  });

  test("imageExists follows aliases", async () => {
    await seedImage("ubuntu-25-10-base");
    await setAlias("ubuntu-base", "ubuntu-25-10-base");
    expect(await imageExists("ubuntu-base")).toBe(true);
    expect(await imageExists("ubuntu-25-10-base")).toBe(true);
    expect(await imageExists("nonexistent-alias")).toBe(false);
  });

  test("imageMeta resolves through aliases and returns the target meta", async () => {
    await seedImage("ubuntu-25-10-base");
    await setAlias("ubuntu-base", "ubuntu-25-10-base");
    const m = await imageMeta("ubuntu-base");
    expect(m).not.toBeNull();
    expect(m!.name).toBe("ubuntu-25-10-base");
  });

  test("setAlias refuses target that doesn't exist on disk", async () => {
    await expect(setAlias("ubuntu-base", "nonexistent")).rejects.toThrow(
      /does not exist on disk/,
    );
  });

  test("setAlias refuses alias-of-alias (single-level rule)", async () => {
    await seedImage("ubuntu-25-10-base");
    await setAlias("ubuntu-base", "ubuntu-25-10-base");
    await expect(setAlias("ubuntu", "ubuntu-base")).rejects.toThrow(
      /itself an alias/,
    );
  });

  test("setAlias overwrites an existing alias atomically", async () => {
    await seedImage("ubuntu-25-10-base");
    await seedImage("ubuntu-25-12-base");
    await setAlias("ubuntu-base", "ubuntu-25-10-base");
    await setAlias("ubuntu-base", "ubuntu-25-12-base");
    expect(await resolveImageName("ubuntu-base")).toBe("ubuntu-25-12-base");
    expect((await listAliases())["ubuntu-base"]).toBe("ubuntu-25-12-base");
  });

  test("removeAlias drops the mapping", async () => {
    await seedImage("ubuntu-25-10-base");
    await setAlias("ubuntu-base", "ubuntu-25-10-base");
    expect(await removeAlias("ubuntu-base")).toBe(true);
    expect(await resolveImageName("ubuntu-base")).toBe("ubuntu-base"); // back to itself
    expect(await imageExists("ubuntu-base")).toBe(false);
    expect(await removeAlias("ubuntu-base")).toBe(false); // already gone
  });

  test("listImages returns concrete images only (aliases not duplicated)", async () => {
    await seedImage("img-a");
    await seedImage("img-b");
    await setAlias("alias-a", "img-a");
    const names = (await listImages()).map((m) => m.name).sort();
    expect(names).toEqual(["img-a", "img-b"]);
  });

  test("setAlias validates the alias name shape", async () => {
    await seedImage("img");
    await expect(setAlias("BAD ALIAS", "img")).rejects.toThrow();
    await expect(setAlias("-bad", "img")).rejects.toThrow();
  });
});
