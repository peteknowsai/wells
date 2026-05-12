import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS, ensureStateDirs, ensureVmDir, stateRoot } from "./state.ts";

describe("state paths", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-test-"));
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    delete process.env.WELL_STATE_DIR;
    await rm(tmp, { recursive: true, force: true });
  });

  test("stateRoot honors WELL_STATE_DIR", () => {
    expect(stateRoot()).toBe(tmp);
  });

  test("PATHS getters compose under stateRoot", () => {
    expect(PATHS.registry()).toBe(join(tmp, "registry.json"));
    expect(PATHS.vmDir("pete")).toBe(join(tmp, "vms", "pete"));
    expect(PATHS.vmDisk("pete")).toBe(join(tmp, "vms", "pete", "disk.img"));
    expect(PATHS.vmCheckpoint("pete", "abc")).toBe(
      join(tmp, "vms", "pete", "checkpoints", "abc"),
    );
    expect(PATHS.wellServicesDir("pete")).toBe(join(tmp, "services", "pete"));
    expect(PATHS.serviceFile("pete", "site")).toBe(
      join(tmp, "services", "pete", "site.json"),
    );
  });

  test("ensureStateDirs creates the standard top-level dirs", async () => {
    await ensureStateDirs();
    expect((await stat(PATHS.root())).isDirectory()).toBe(true);
    expect((await stat(PATHS.images())).isDirectory()).toBe(true);
    expect((await stat(PATHS.vms())).isDirectory()).toBe(true);
    expect((await stat(PATHS.services())).isDirectory()).toBe(true);
  });

  test("ensureStateDirs is idempotent", async () => {
    await ensureStateDirs();
    await ensureStateDirs();
    expect((await stat(PATHS.root())).isDirectory()).toBe(true);
  });

  test("ensureVmDir creates per-VM bundle and checkpoints dir", async () => {
    await ensureStateDirs();
    const d = await ensureVmDir("pete");
    expect(d).toBe(PATHS.vmDir("pete"));
    expect((await stat(PATHS.vmDir("pete"))).isDirectory()).toBe(true);
    expect((await stat(PATHS.vmCheckpoints("pete"))).isDirectory()).toBe(true);
  });
});
