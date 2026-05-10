import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPoolMember,
  countReadyMembers,
  findPoolMember,
  generatePoolMemberName,
  listPoolMembers,
  loadPoolRegistry,
  removePoolMember,
  reserveReadyMember,
  setPoolMemberState,
  type PoolMember,
} from "./poolRegistry.ts";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "wells-pool-test-"));
  process.env.WELL_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.WELL_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

function fixture(overrides?: Partial<PoolMember>): PoolMember {
  return {
    name: overrides?.name ?? generatePoolMemberName(),
    uuid: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-05-09T00:00:00Z",
    source_image: "ubuntu-25.10-base",
    cpu: 4,
    memory: "1GB",
    disk_size: "50GB",
    state: "provisioning",
    ...overrides,
  };
}

describe("generatePoolMemberName", () => {
  test("uses pool- prefix + 8 hex chars", () => {
    const n = generatePoolMemberName();
    expect(n).toMatch(/^pool-[0-9a-f]{8}$/);
  });

  test("returns a fresh name each call", () => {
    const a = generatePoolMemberName();
    const b = generatePoolMemberName();
    expect(a).not.toBe(b);
  });
});

describe("pool registry CRUD", () => {
  test("loadPoolRegistry returns empty members when no file exists", async () => {
    const reg = await loadPoolRegistry();
    expect(reg.members).toEqual([]);
  });

  test("listPoolMembers / findPoolMember on empty registry", async () => {
    expect(await listPoolMembers()).toEqual([]);
    expect(await findPoolMember("pool-deadbeef")).toBeUndefined();
  });

  test("addPoolMember persists + findPoolMember retrieves", async () => {
    const m = fixture({ name: "pool-aaaaaaaa" });
    await addPoolMember(m);
    const found = await findPoolMember("pool-aaaaaaaa");
    expect(found?.name).toBe("pool-aaaaaaaa");
    expect(found?.source_image).toBe("ubuntu-25.10-base");
    expect(found?.state).toBe("provisioning");
  });

  test("addPoolMember refuses duplicate name", async () => {
    const m = fixture({ name: "pool-aaaaaaaa" });
    await addPoolMember(m);
    await expect(addPoolMember(m)).rejects.toThrow(/already exists/);
  });

  test("removePoolMember returns true when removed, false when missing", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa" }));
    expect(await removePoolMember("pool-aaaaaaaa")).toBe(true);
    expect(await removePoolMember("pool-aaaaaaaa")).toBe(false);
    expect(await listPoolMembers()).toEqual([]);
  });

  test("setPoolMemberState walks state machine + records ready_at", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa" }));
    let m = await setPoolMemberState("pool-aaaaaaaa", "warming");
    expect(m?.state).toBe("warming");
    m = await setPoolMemberState("pool-aaaaaaaa", "ready", "2026-05-09T01:00:00Z");
    expect(m?.state).toBe("ready");
    expect(m?.ready_at).toBe("2026-05-09T01:00:00Z");
    const persisted = await findPoolMember("pool-aaaaaaaa");
    expect(persisted?.state).toBe("ready");
    expect(persisted?.ready_at).toBe("2026-05-09T01:00:00Z");
  });

  test("setPoolMemberState on missing member returns undefined", async () => {
    const r = await setPoolMemberState("pool-nope", "ready");
    expect(r).toBeUndefined();
  });
});

describe("countReadyMembers", () => {
  test("counts only state=ready members", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready" }));
    await addPoolMember(fixture({ name: "pool-bbbbbbbb", state: "warming" }));
    await addPoolMember(fixture({ name: "pool-cccccccc", state: "ready" }));
    await addPoolMember(fixture({ name: "pool-dddddddd", state: "adopting" }));
    expect(await countReadyMembers()).toBe(2);
  });
});

describe("reserveReadyMember (atomic pop)", () => {
  test("returns undefined when no members", async () => {
    expect(await reserveReadyMember()).toBeUndefined();
  });

  test("returns undefined when no ready members (only provisioning/warming)", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "provisioning" }));
    await addPoolMember(fixture({ name: "pool-bbbbbbbb", state: "warming" }));
    expect(await reserveReadyMember()).toBeUndefined();
  });

  test("transitions reserved member to adopting (guards against double-pop)", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready" }));
    const reserved = await reserveReadyMember();
    expect(reserved?.name).toBe("pool-aaaaaaaa");
    // After reservation, the member is no longer 'ready' so a follow-up
    // reserve gets nothing — this is the load-bearing property that
    // protects against concurrent adopt requests racing on the same
    // pool member.
    const second = await reserveReadyMember();
    expect(second).toBeUndefined();
    const persisted = await findPoolMember("pool-aaaaaaaa");
    expect(persisted?.state).toBe("adopting");
  });

  test("picks a ready member when mixed states present", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "warming" }));
    await addPoolMember(fixture({ name: "pool-bbbbbbbb", state: "ready" }));
    await addPoolMember(fixture({ name: "pool-cccccccc", state: "provisioning" }));
    const reserved = await reserveReadyMember();
    expect(reserved?.name).toBe("pool-bbbbbbbb");
  });
});
