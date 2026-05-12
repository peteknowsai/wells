import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { addWell, findWell } from "./registry.ts";
import { destroyWell } from "./destroy.ts";

// CRITICAL: WELL_LUME_STORAGE only redirects OUR code's idea of where the
// bundle lives. The lume serve daemon (running on the host) still owns its
// own ~/.lume/. If a fixture name happens to match a real lume VM, our test
// will tell lume to delete the real one. So fixture names must be globally
// unique — uuid prefix guarantees no collision.
function fixtureName(): string {
  return `well-test-fixture-${randomUUID().slice(0, 8)}`;
}

describe("destroy", () => {
  let tmpState: string;
  let tmpLume: string;

  beforeEach(async () => {
    tmpState = await mkdtemp(join(tmpdir(), "wells-destroy-state-"));
    tmpLume = await mkdtemp(join(tmpdir(), "wells-destroy-lume-"));
    process.env.WELL_STATE_DIR = tmpState;
    process.env.WELL_LUME_STORAGE = tmpLume;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
    await rm(tmpState, { recursive: true, force: true });
    await rm(tmpLume, { recursive: true, force: true });
  });

  test("destroy of unknown well reports not found, no errors", async () => {
    const r = await destroyWell(fixtureName());
    expect(r.found).toBe(false);
    expect(r.removedRegistry).toBe(false);
    expect(r.removedStateDir).toBe(false);
    expect(r.removedBundle).toBe(false);
  });

  test("destroy removes registry entry + state dir + stale bundle", async () => {
    const name = fixtureName();
    await addWell({
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

    const r = await destroyWell(name);
    expect(r.found).toBe(true);
    expect(r.removedRegistry).toBe(true);
    expect(r.removedStateDir).toBe(true);
    expect(r.removedBundle).toBe(true);
    expect(existsSync(vmDir)).toBe(false);
    expect(existsSync(bundleDirPath)).toBe(false);
    expect(await findWell(name)).toBeUndefined();
  });

  test("second destroy is idempotent (no errors)", async () => {
    const name = fixtureName();
    await addWell({
      name,
      uuid: "u",
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
    });
    await mkdir(join(tmpState, "vms", name), { recursive: true });
    await destroyWell(name);
    const r = await destroyWell(name);
    expect(r.found).toBe(false);
  });

  // Pool-adopted wells (A.1.4.c.iv): registry's `lume_name` points at
  // the `pool-XXXX` bundle that lume still uses internally. Destroying
  // by the operator-chosen name must walk through lume_name to find the
  // bundle, otherwise we'd leave an orphaned pool-XXXX dir on disk.
  test("pool-adopted well: deletes the pool-XXXX lume bundle (not the operator name)", async () => {
    const name = fixtureName();
    const lumeName = "pool-deadbeef-" + name.slice(-4);
    await addWell({
      name,
      uuid: "u-" + name,
      created_at: "2026-05-06T00:00:00Z",
      cpu: 4,
      memory: "4GB",
      disk_size: "50GB",
      lume_name: lumeName,
    });
    const vmDir = join(tmpState, "vms", name);
    await mkdir(vmDir, { recursive: true });
    await writeFile(join(vmDir, "meta.json"), "{}");

    // Bundle on disk lives at the pool-XXXX path, NOT the operator name.
    const lumeBundlePath = join(tmpLume, lumeName);
    await mkdir(lumeBundlePath, { recursive: true });
    await writeFile(join(lumeBundlePath, "disk.img"), "x");
    // A sibling dir at the operator name should be left alone (it shouldn't
    // exist in practice, but if it did, destroy targets lume_name).
    const operatorBundlePath = join(tmpLume, name);
    await mkdir(operatorBundlePath, { recursive: true });
    await writeFile(join(operatorBundlePath, "stranger.txt"), "x");

    const r = await destroyWell(name);
    expect(r.found).toBe(true);
    expect(r.removedBundle).toBe(true);
    expect(existsSync(lumeBundlePath)).toBe(false);
    // Operator-named sibling is untouched — destroy walked lume_name.
    expect(existsSync(operatorBundlePath)).toBe(true);
    expect(await findWell(name)).toBeUndefined();
  });

  test("stale bundle without a registry record still gets cleaned up", async () => {
    // Failed-create / dirty-shutdown case: bundle exists on disk but
    // never made it into the registry. destroy by name should still
    // remove the bundle.
    const name = fixtureName();
    const bundlePath = join(tmpLume, name);
    await mkdir(bundlePath, { recursive: true });
    await writeFile(join(bundlePath, "disk.img"), "x");

    const r = await destroyWell(name);
    expect(r.removedBundle).toBe(true);
    expect(r.removedRegistry).toBe(false);
    expect(existsSync(bundlePath)).toBe(false);
  });
});
