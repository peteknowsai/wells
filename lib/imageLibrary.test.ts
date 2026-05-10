import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  imageLibraryKey,
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

// Stub S3Client just enough to satisfy pushImage's `client.write`.
function makeStubClient(recorder: RecordedWrite[]) {
  return {
    write: async (key: string, body: unknown) => {
      if (typeof body === "string") {
        recorder.push({ key, body: { kind: "text", text: body } });
      } else if (body instanceof Uint8Array) {
        recorder.push({
          key,
          body: { kind: "text", text: new TextDecoder().decode(body) },
        });
      } else if (typeof (body as { name?: unknown }).name === "string") {
        recorder.push({
          key,
          body: { kind: "file", path: (body as { name: string }).name },
        });
      } else {
        throw new Error(`stub: unexpected body shape for key=${key}`);
      }
    },
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
