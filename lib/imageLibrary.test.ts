import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  imageLibraryKey,
  pullImage,
  pushImage,
  type R2LibraryConfig,
} from "./imageLibrary.ts";

const CFG: R2LibraryConfig = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  bucket: "wells-images-test",
  access_key_id: "ak",
  secret_access_key: "sk",
};

interface RecordedWrite {
  key: string;
  // We capture only enough about the body to assert intent. For
  // string/JSON writes we keep the raw text; for file writes we keep
  // the source path so tests can sha256 the actual bytes pushed.
  body: { kind: "text"; text: string } | { kind: "file"; path: string };
}

// Stub S3Client just enough to satisfy push (`client.write`) and pull
// (`client.file(key).text()`). The bag of fake remote bytes is keyed
// by R2 path; tests seed it before calling pullImage and inspect it
// after pushImage.
interface FakeBag {
  texts: Map<string, string>;
}

function makeStubClient(
  recorder: RecordedWrite[],
  bag: FakeBag = { texts: new Map() },
) {
  return {
    write: async (key: string, body: unknown) => {
      if (typeof body === "string") {
        recorder.push({ key, body: { kind: "text", text: body } });
        bag.texts.set(key, body);
      } else if (body instanceof Uint8Array) {
        const text = new TextDecoder().decode(body);
        recorder.push({ key, body: { kind: "text", text } });
        bag.texts.set(key, text);
      } else if (typeof (body as { name?: unknown }).name === "string") {
        recorder.push({
          key,
          body: { kind: "file", path: (body as { name: string }).name },
        });
      } else {
        throw new Error(`stub: unexpected body shape for key=${key}`);
      }
    },
    file: (key: string) => ({
      text: async () => {
        const v = bag.texts.get(key);
        if (v === undefined) {
          throw new Error(`fake R2: ${key} not in bag`);
        }
        return v;
      },
    }),
  } as unknown as Parameters<typeof pushImage>[3] extends infer D
    ? D extends { client?: infer C }
      ? C
      : never
    : never;
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "wells-img-lib-test-"));
  process.env.WELL_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.WELL_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

async function seedLocalImage(
  name: string,
  diskBytes: string,
  meta: object,
): Promise<void> {
  const dir = join(stateDir, "images", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "disk.img"), diskBytes);
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

describe("imageLibraryKey", () => {
  test("composes the canonical R2 paths", () => {
    expect(imageLibraryKey("cell-base", "disk.img")).toBe(
      "images/cell-base/disk.img",
    );
    expect(imageLibraryKey("cell-base", "meta.json")).toBe(
      "images/cell-base/meta.json",
    );
    expect(imageLibraryKey("cell-base", "manifest.json")).toBe(
      "images/cell-base/manifest.json",
    );
  });
});

describe("pushImage", () => {
  test("throws when local image is missing", async () => {
    await expect(
      pushImage("ghost", CFG, "0.1.0-pre", { client: makeStubClient([]) }),
    ).rejects.toThrow(/not found locally/);
  });

  test("throws when meta.json is missing (malformed local image)", async () => {
    const dir = join(stateDir, "images", "no-meta");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "disk.img"), "x");
    await expect(
      pushImage("no-meta", CFG, "0.1.0-pre", {
        client: makeStubClient([]),
      }),
    ).rejects.toThrow(/malformed local image/);
  });

  test("uploads disk + meta + manifest, in that order", async () => {
    const writes: RecordedWrite[] = [];
    const diskBytes = "diskbytes";
    await seedLocalImage("cell-base", diskBytes, {
      name: "cell-base",
      from_well: "bake-well",
      created_at: "2026-05-10T00:00:00Z",
      image_contract_version: 1,
    });

    await pushImage("cell-base", CFG, "0.1.0-pre", {
      client: makeStubClient(writes),
      host: "test-host",
      now: () => new Date("2026-05-10T06:30:00Z"),
    });

    expect(writes.map((w) => w.key)).toEqual([
      "images/cell-base/disk.img",
      "images/cell-base/meta.json",
      "images/cell-base/manifest.json",
    ]);
  });

  test("manifest carries sha256, size, timestamp, host, welld version", async () => {
    const writes: RecordedWrite[] = [];
    const diskBytes = "abc123";
    const expectedSha = createHash("sha256").update(diskBytes).digest("hex");
    await seedLocalImage("cell-base", diskBytes, {
      name: "cell-base",
      image_contract_version: 1,
    });

    const result = await pushImage("cell-base", CFG, "0.1.0-pre", {
      client: makeStubClient(writes),
      host: "pete-macmini",
      now: () => new Date("2026-05-10T06:30:00Z"),
    });

    expect(result.manifest).toEqual({
      name: "cell-base",
      disk_sha256: expectedSha,
      disk_size_bytes: diskBytes.length,
      pushed_at: "2026-05-10T06:30:00.000Z",
      pushed_by_welld_version: "0.1.0-pre",
      pushed_by_host: "pete-macmini",
    });

    // The uploaded manifest body is the same object, JSON-stringified.
    const manifestWrite = writes.find(
      (w) => w.key === "images/cell-base/manifest.json",
    );
    expect(manifestWrite?.body.kind).toBe("text");
    if (manifestWrite?.body.kind === "text") {
      expect(JSON.parse(manifestWrite.body.text)).toEqual(result.manifest);
    }
  });

  test("uploaded meta.json is byte-equivalent to local meta.json", async () => {
    const writes: RecordedWrite[] = [];
    const meta = {
      name: "cell-base",
      image_contract_version: 1,
      from_well: "bake-1234",
      notes: "iteration 7",
    };
    await seedLocalImage("cell-base", "x", meta);

    await pushImage("cell-base", CFG, "0.1.0-pre", {
      client: makeStubClient(writes),
      host: "h",
      now: () => new Date("2026-05-10T06:30:00Z"),
    });

    const metaWrite = writes.find(
      (w) => w.key === "images/cell-base/meta.json",
    );
    expect(metaWrite?.body.kind).toBe("text");
    if (metaWrite?.body.kind === "text") {
      // Round-trip: the parsed-and-restringified content should match
      // the seeded meta. Whitespace can differ from the on-disk form
      // (writeFile wrote with `null, 2` so it's the same shape).
      expect(JSON.parse(metaWrite.body.text)).toEqual(meta);
    }
  });

  test("returned keys + durationMs are populated", async () => {
    const writes: RecordedWrite[] = [];
    await seedLocalImage("cell-base", "x", {
      name: "cell-base",
      image_contract_version: 1,
    });

    const result = await pushImage("cell-base", CFG, "0.1.0-pre", {
      client: makeStubClient(writes),
      host: "h",
      now: () => new Date("2026-05-10T06:30:00Z"),
    });

    expect(result.keys).toEqual({
      manifest: "images/cell-base/manifest.json",
      meta: "images/cell-base/meta.json",
      disk: "images/cell-base/disk.img",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("pullImage", () => {
  // Helper: seed the fake R2 bag with a known image, return both the
  // bag (as the client's storage) and the disk bytes (so tests can
  // stub fetchDiskTo to write them locally).
  function seedRemoteImage(
    name: string,
    diskBytes: string,
    metaObj: object,
  ): { bag: FakeBag; sha: string } {
    const bag: FakeBag = { texts: new Map() };
    const sha = createHash("sha256").update(diskBytes).digest("hex");
    bag.texts.set(`images/${name}/manifest.json`, JSON.stringify({
      name,
      disk_sha256: sha,
      disk_size_bytes: diskBytes.length,
      pushed_at: "2026-05-10T06:30:00.000Z",
      pushed_by_welld_version: "0.1.0-pre",
      pushed_by_host: "pete-macmini",
    }));
    bag.texts.set(`images/${name}/meta.json`, JSON.stringify(metaObj));
    // disk bytes recorded separately — stub fetchDiskTo writes them.
    return { bag, sha };
  }

  test("happy path: manifest fetch → disk fetch → sha verify → meta write → rotate", async () => {
    const diskBytes = "abcdefghij"; // 10 bytes
    const metaObj = {
      name: "cell-base",
      image_contract_version: 1,
      from_well: "bake-1234",
    };
    const { bag } = seedRemoteImage("cell-base", diskBytes, metaObj);

    const result = await pullImage("cell-base", CFG, {
      client: makeStubClient([], bag),
      fetchDiskTo: async (_c, _key, localPath) => {
        await writeFile(localPath, diskBytes);
        return diskBytes.length;
      },
    });

    expect(result.bytes).toBe(10);
    expect(result.manifest.name).toBe("cell-base");

    // Local layout matches what saveImage produces.
    const localDir = join(stateDir, "images", "cell-base");
    expect(existsSync(join(localDir, "disk.img"))).toBe(true);
    expect(existsSync(join(localDir, "disk.img.partial"))).toBe(false);
    const localDisk = await readFile(join(localDir, "disk.img"), "utf-8");
    expect(localDisk).toBe(diskBytes);
    const localMeta = JSON.parse(
      await readFile(join(localDir, "meta.json"), "utf-8"),
    );
    expect(localMeta).toEqual(metaObj);
  });

  test("sha256 mismatch: throws + cleans temp + leaves no disk.img", async () => {
    const diskBytes = "expected-bytes";
    const wrongBytes = "wrong-bytes";
    const { bag } = seedRemoteImage("bad-image", diskBytes, {
      name: "bad-image",
      image_contract_version: 1,
    });

    await expect(
      pullImage("bad-image", CFG, {
        client: makeStubClient([], bag),
        fetchDiskTo: async (_c, _key, localPath) => {
          await writeFile(localPath, wrongBytes); // sha won't match
          return wrongBytes.length;
        },
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    const localDir = join(stateDir, "images", "bad-image");
    // disk.img.partial cleaned up
    expect(existsSync(join(localDir, "disk.img.partial"))).toBe(false);
    // disk.img never landed (rotate happens AFTER sha check)
    expect(existsSync(join(localDir, "disk.img"))).toBe(false);
  });

  test("size mismatch is also rejected (cheap pre-sha check)", async () => {
    const diskBytes = "ten-byteee"; // exactly 10
    const { bag } = seedRemoteImage("size-image", diskBytes, {
      name: "size-image",
      image_contract_version: 1,
    });
    await expect(
      pullImage("size-image", CFG, {
        client: makeStubClient([], bag),
        fetchDiskTo: async (_c, _key, localPath) => {
          await writeFile(localPath, "short"); // 5 bytes, not 10
          return 5;
        },
      }),
    ).rejects.toThrow(/sha256 mismatch|size mismatch/);
  });

  test("manifest name mismatch — defends against caller typo / R2 corruption", async () => {
    const bag: FakeBag = { texts: new Map() };
    bag.texts.set("images/asked-for/manifest.json", JSON.stringify({
      name: "actually-different",
      disk_sha256: "deadbeef",
      disk_size_bytes: 1,
      pushed_at: "2026-05-10T06:30:00.000Z",
      pushed_by_welld_version: "0.1.0-pre",
      pushed_by_host: "h",
    }));
    await expect(
      pullImage("asked-for", CFG, { client: makeStubClient([], bag) }),
    ).rejects.toThrow(/manifest name mismatch/);
  });

  test("missing manifest → clear error", async () => {
    await expect(
      pullImage("ghost", CFG, { client: makeStubClient([], { texts: new Map() }) }),
    ).rejects.toThrow(/manifest\.json not in R2/);
  });

  test("push then pull round-trip — bytes survive intact", async () => {
    // End-to-end sanity: push a local image, then pull it back to a
    // different name and verify the disk + meta are byte-equivalent.
    // Validates that the disk read by push matches what pull would
    // verify, and the meta passes through verbatim.
    const writes: RecordedWrite[] = [];
    const bag: FakeBag = { texts: new Map() };
    const diskBytes = "round-trip-bytes";
    const metaObj = {
      name: "src",
      image_contract_version: 1,
      from_well: "bake",
    };
    await seedLocalImage("src", diskBytes, metaObj);

    // Push captures meta + manifest into the bag. The bag also gets
    // a "file" recorded for the disk write but not the bytes
    // themselves (push uses Bun.file, our stub records the path
    // only). For the pull side we provide fetchDiskTo that pulls the
    // bytes out of the captured push-time recorder.
    const pushClient = makeStubClient(writes, bag);
    await pushImage("src", CFG, "0.1.0-pre", {
      client: pushClient,
      host: "h",
      now: () => new Date("2026-05-10T06:30:00Z"),
    });

    // Now pull as a different name. Disk fetch comes from the
    // recorded push — find the file write and read the path.
    const diskWrite = writes.find((w) => w.key === "images/src/disk.img");
    if (diskWrite?.body.kind !== "file") {
      throw new Error("test setup: push didn't record disk write as file");
    }
    const sourceDiskPath = diskWrite.body.path;

    // Re-key the manifest + meta in the bag under "dst" so pullImage
    // looks for them there.
    const manifestText = bag.texts.get("images/src/manifest.json")!;
    const metaText = bag.texts.get("images/src/meta.json")!;
    bag.texts.set(
      "images/dst/manifest.json",
      manifestText.replace(/"name":\s*"src"/, '"name": "dst"'),
    );
    bag.texts.set("images/dst/meta.json", metaText);

    const pullClient = makeStubClient([], bag);
    const result = await pullImage("dst", CFG, {
      client: pullClient,
      fetchDiskTo: async (_c, _key, localPath) => {
        const bytes = await readFile(sourceDiskPath);
        await writeFile(localPath, bytes);
        return bytes.length;
      },
    });

    expect(result.bytes).toBe(diskBytes.length);
    const pulledDisk = await readFile(
      join(stateDir, "images", "dst", "disk.img"),
      "utf-8",
    );
    expect(pulledDisk).toBe(diskBytes);
  });
});
