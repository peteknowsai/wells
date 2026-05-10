import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainAllPoolMembers, prunePoolZombies, shouldFill } from "./poolFiller.ts";
import { addPoolMember, listPoolMembers, type PoolMember } from "./poolRegistry.ts";

// `shouldFill` is the gap-detection logic at the heart of the filler.
// Pure helper — covers the matrix without spinning up a live filler.
describe("shouldFill", () => {
  test("pool_size=0 disables the filler regardless of state", () => {
    expect(shouldFill(0, 0, false)).toBe(false);
    expect(shouldFill(0, 0, true)).toBe(false);
    expect(shouldFill(0, 5, false)).toBe(false);
  });

  test("negative pool_size also disables (defensive against bad config)", () => {
    expect(shouldFill(-1, 0, false)).toBe(false);
  });

  test("inflight blocks fill regardless of gap", () => {
    expect(shouldFill(2, 0, true)).toBe(false);
    expect(shouldFill(4, 1, true)).toBe(false);
  });

  test("ready < target + no inflight → fill", () => {
    expect(shouldFill(1, 0, false)).toBe(true);
    expect(shouldFill(4, 3, false)).toBe(true);
  });

  test("ready === target → no fill (steady state)", () => {
    expect(shouldFill(2, 2, false)).toBe(false);
  });

  test("ready > target → no fill (over-pooled, no shrink)", () => {
    // Over-pool can happen if pool_size was lowered after fill. We
    // don't shrink — drain is a separate operator action.
    expect(shouldFill(2, 5, false)).toBe(false);
  });
});

// W.23 (cells team) — pool zombies (registry entries pointing at lume
// bundles that don't exist on disk) + drain --all (nuke every state).
const sampleMember = (name: string, state: PoolMember["state"]): PoolMember => ({
  name,
  uuid: "u-" + name,
  created_at: "2026-05-10T08:00:00Z",
  source_image: "ubuntu-25.10-base",
  cpu: 4,
  memory: "1GB",
  disk_size: "50GB",
  state,
});

describe("prunePoolZombies + drainAllPoolMembers", () => {
  let stateDir: string;
  let lumeDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "wells-pool-prune-state-"));
    lumeDir = await mkdtemp(join(tmpdir(), "wells-pool-prune-lume-"));
    process.env.WELL_STATE_DIR = stateDir;
    process.env.WELL_LUME_STORAGE = lumeDir;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(lumeDir, { recursive: true, force: true });
    delete process.env.WELL_STATE_DIR;
    delete process.env.WELL_LUME_STORAGE;
  });

  test("prunePoolZombies drops members whose lume bundle is missing", async () => {
    // Three members: two with bundles on disk, one zombie.
    await addPoolMember(sampleMember("pool-real1", "ready"));
    await addPoolMember(sampleMember("pool-real2", "warming"));
    await addPoolMember(sampleMember("pool-zombie", "adopting"));
    await mkdir(join(lumeDir, "pool-real1"), { recursive: true });
    await mkdir(join(lumeDir, "pool-real2"), { recursive: true });
    // No lume dir for pool-zombie — that's the zombie shape.

    const pruned = await prunePoolZombies();
    expect(pruned).toEqual(["pool-zombie"]);

    const remaining = (await listPoolMembers()).map((m) => m.name).sort();
    expect(remaining).toEqual(["pool-real1", "pool-real2"]);
  });

  test("prunePoolZombies is a no-op when every member has a bundle", async () => {
    await addPoolMember(sampleMember("pool-a", "ready"));
    await mkdir(join(lumeDir, "pool-a"), { recursive: true });

    const pruned = await prunePoolZombies();
    expect(pruned).toEqual([]);
    expect((await listPoolMembers())).toHaveLength(1);
  });

  test("drainAllPoolMembers nukes every state, not just ready", async () => {
    await addPoolMember(sampleMember("pool-a", "ready"));
    await addPoolMember(sampleMember("pool-b", "warming"));
    await addPoolMember(sampleMember("pool-c", "adopting"));
    await addPoolMember(sampleMember("pool-d", "provisioning"));
    // Bundles for all four (drain doesn't gate on bundle presence).
    for (const n of ["pool-a", "pool-b", "pool-c", "pool-d"]) {
      await mkdir(join(lumeDir, n), { recursive: true });
    }

    const count = await drainAllPoolMembers();
    expect(count).toBe(4);
    expect(await listPoolMembers()).toEqual([]);
  });
});
