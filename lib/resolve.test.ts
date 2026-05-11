import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWellPin } from "./resolve.ts";

// readWellPin is the "which well" fallback for CLI commands: when the
// user doesn't pass --well or a positional arg, the CLI reads `.well`
// in the working directory. Bugs here route operations against the
// wrong well silently, so be strict about the failure modes.

async function withTempCwd(
  cb: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wells-resolve-test-"));
  try {
    await cb(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("readWellPin", () => {
  test("returns undefined when .well file does not exist", async () => {
    await withTempCwd(async (dir) => {
      expect(await readWellPin(dir)).toBeUndefined();
    });
  });

  test("returns the pinned well name when .well has {well: 'name'}", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".well"), JSON.stringify({ well: "my-cell" }));
      expect(await readWellPin(dir)).toBe("my-cell");
    });
  });

  test("returns undefined when .well is invalid JSON", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".well"), "{not json");
      expect(await readWellPin(dir)).toBeUndefined();
    });
  });

  test("returns undefined when .well JSON is missing the well field", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".well"), JSON.stringify({ other: "value" }));
      expect(await readWellPin(dir)).toBeUndefined();
    });
  });

  test("returns undefined when .well JSON's well field is not a string", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".well"), JSON.stringify({ well: 42 }));
      expect(await readWellPin(dir)).toBeUndefined();
    });
  });

  test("returns undefined when .well JSON's well field is null", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".well"), JSON.stringify({ well: null }));
      expect(await readWellPin(dir)).toBeUndefined();
    });
  });

  test("ignores extra fields in .well JSON", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".well"),
        JSON.stringify({ well: "main", note: "scratch project" }),
      );
      expect(await readWellPin(dir)).toBe("main");
    });
  });
});
