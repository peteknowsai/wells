import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clonefile } from "./clonefile.ts";

describe("clonefile", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "splites-clonefile-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("copies content from src to dst", async () => {
    const src = join(tmp, "src.bin");
    const dst = join(tmp, "dst.bin");
    await writeFile(src, "hello");
    await clonefile(src, dst);
    expect(await readFile(dst, "utf-8")).toBe("hello");
  });

  test("replaces existing dst", async () => {
    const src = join(tmp, "src.bin");
    const dst = join(tmp, "dst.bin");
    await writeFile(src, "new");
    await writeFile(dst, "old content longer");
    await clonefile(src, dst);
    expect(await readFile(dst, "utf-8")).toBe("new");
  });

  test("CoW — modifying src after clone doesn't affect dst", async () => {
    const src = join(tmp, "src.bin");
    const dst = join(tmp, "dst.bin");
    await writeFile(src, "original");
    await clonefile(src, dst);
    await writeFile(src, "modified");
    expect(await readFile(dst, "utf-8")).toBe("original");
  });

  test("throws when src is missing", async () => {
    const src = join(tmp, "missing.bin");
    const dst = join(tmp, "dst.bin");
    await expect(clonefile(src, dst)).rejects.toThrow();
  });
});
