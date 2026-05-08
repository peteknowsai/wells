import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSshKey } from "./sshKey.ts";

describe("ensureSshKey", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-sshkey-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("creates ed25519 keypair and returns public key", async () => {
    const priv = join(tmp, "id");
    const pub = await ensureSshKey(priv, "test@wells");
    expect(pub).toMatch(/^ssh-ed25519 \S+ test@wells$/);

    const privStat = await stat(priv);
    expect(privStat.isFile()).toBe(true);
    expect(privStat.mode & 0o777).toBe(0o600);

    const pubFromDisk = (await readFile(`${priv}.pub`, "utf-8")).trim();
    expect(pubFromDisk).toBe(pub);
  });

  test("idempotent — second call returns same key without re-keygen", async () => {
    const priv = join(tmp, "id");
    const first = await ensureSshKey(priv, "first@wells");
    const second = await ensureSshKey(priv, "ignored@wells");
    expect(second).toBe(first);
  });

  test("creates parent directories if missing", async () => {
    const priv = join(tmp, "deep", "nested", "id");
    const pub = await ensureSshKey(priv, "deep@wells");
    expect(pub).toMatch(/^ssh-ed25519 /);
    expect((await stat(priv)).isFile()).toBe(true);
  });
});
