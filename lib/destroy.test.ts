import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { addSplite, findSplite } from "./registry.ts";
import { destroySplite } from "./destroy.ts";

// CRITICAL: SPLITES_LUME_STORAGE only redirects OUR code's idea of where the
// bundle lives. The lume serve daemon (running on the host) still owns its
// own ~/.lume/. If a fixture name happens to match a real lume VM, our test
// will tell lume to delete the real one. So fixture names must be globally
// unique — uuid prefix guarantees no collision.
function fixtureName(): string {
  return `splite-test-fixture-${randomUUID().slice(0, 8)}`;
}

describe("destroy", () => {
  let tmpState: string;
  let tmpLume: string;

  beforeEach(async () => {
    tmpState = await mkdtemp(join(tmpdir(), "splites-destroy-state-"));
    tmpLume = await mkdtemp(join(tmpdir(), "splites-destroy-lume-"));
    process.env.SPLITES_STATE_DIR = tmpState;
    process.env.SPLITES_LUME_STORAGE = tmpLume;
  });

  afterEach(async () => {
    delete process.env.SPLITES_STATE_DIR;
    delete process.env.SPLITES_LUME_STORAGE;
    await rm(tmpState, { recursive: true, force: true });
    await rm(tmpLume, { recursive: true, force: true });
  });

  test("destroy of unknown splite reports not found, no errors", async () => {
    const r = await destroySplite(fixtureName());
    expect(r.found).toBe(false);
    expect(r.removedRegistry).toBe(false);
    expect(r.removedStateDir).toBe(false);
    expect(r.removedBundle).toBe(false);
  });

  test("destroy removes registry entry + state dir + stale bundle", async () => {
    const name = fixtureName();
    await addSplite({
      name,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
    });
    const vmDir = join(tmpState, "vms", name);
    await mkdir(vmDir, { recursive: true });
    await writeFile(join(vmDir, "meta.json"), "{}");

    const bundleDirPath = join(tmpLume, name);
    await mkdir(bundleDirPath, { recursive: true });
    await writeFile(join(bundleDirPath, "disk.img"), "x");

    const r = await destroySplite(name);
    expect(r.found).toBe(true);
    expect(r.removedRegistry).toBe(true);
    expect(r.removedStateDir).toBe(true);
    expect(r.removedBundle).toBe(true);
    expect(existsSync(vmDir)).toBe(false);
    expect(existsSync(bundleDirPath)).toBe(false);
    expect(await findSplite(name)).toBeUndefined();
  });

  test("second destroy is idempotent (no errors)", async () => {
    const name = fixtureName();
    await addSplite({
      name,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
    });
    await mkdir(join(tmpState, "vms", name), { recursive: true });
    await destroySplite(name);
    const r = await destroySplite(name);
    expect(r.found).toBe(false);
  });
});
