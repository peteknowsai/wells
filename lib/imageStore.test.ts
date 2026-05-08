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
  listImages,
  saveImage,
  removeImage,
} from "./imageStore.ts";

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
  });

  test("rejects bad shapes", () => {
    expect(() => validateImageName("")).toThrow();
    expect(() => validateImageName("-leading")).toThrow();
    expect(() => validateImageName("trailing-")).toThrow();
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

  test("listImages synthesizes meta for legacy images without meta.json", async () => {
    const dir = join(stateDir, "images", "ubuntu-25.10-base");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "disk.img"), "fake-base-image");

    const list = await listImages();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("ubuntu-25.10-base");
    expect(list[0]!.from_well).toBeNull();
    expect(list[0]!.created_at).toBe("unknown");
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
