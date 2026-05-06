import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken, readToken } from "./token.ts";

describe("token", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "splites-token-test-"));
    process.env.SPLITES_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.SPLITES_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("ensureToken generates on first call", async () => {
    expect(await readToken()).toBeNull();
    const t = await ensureToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ensureToken is idempotent across calls", async () => {
    const a = await ensureToken();
    const b = await ensureToken();
    expect(a).toBe(b);
  });

  test("token file is mode 0600", async () => {
    await ensureToken();
    const s = await stat(join(tmp, "token"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("readToken returns null when missing or empty", async () => {
    expect(await readToken()).toBeNull();
    await writeFile(join(tmp, "token"), "");
    expect(await readToken()).toBeNull();
  });

  test("trailing whitespace is stripped", async () => {
    await writeFile(join(tmp, "token"), "  abc123  \n");
    expect(await readToken()).toBe("abc123");
  });
});
