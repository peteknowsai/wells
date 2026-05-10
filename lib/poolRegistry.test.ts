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
  poolSummary,
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

describe("reserveReadyMember (criteria filter)", () => {
  // A.1.4.d — createWell only adopts when the pool member's source
  // image + sizing match the operator's request. An ill-matched
  // request must NOT pop a ready member; it falls through to fresh-
  // create. Pool members baked at sizing X are not silently handed
  // out when the caller asked for sizing Y.

  test("rejects on source_image mismatch (default ready member, custom image request)", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready" }));
    const r = await reserveReadyMember({ source_image: "ubuntu-26.04-base" });
    expect(r).toBeUndefined();
    // Member stays ready (not transitioned to adopting).
    const persisted = await findPoolMember("pool-aaaaaaaa");
    expect(persisted?.state).toBe("ready");
  });

  test("rejects on cpu mismatch", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready", cpu: 4 }));
    expect(await reserveReadyMember({ cpu: 8 })).toBeUndefined();
  });

  test("rejects on memory mismatch", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready", memory: "1GB" }));
    expect(await reserveReadyMember({ memory: "2GB" })).toBeUndefined();
  });

  test("rejects on disk_size mismatch", async () => {
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready", disk_size: "50GB" }));
    expect(await reserveReadyMember({ disk_size: "100GB" })).toBeUndefined();
  });

  test("accepts when all criteria match the ready member", async () => {
    await addPoolMember(fixture({
      name: "pool-aaaaaaaa", state: "ready",
      source_image: "ubuntu-25.10-base", cpu: 4, memory: "1GB", disk_size: "50GB",
    }));
    const r = await reserveReadyMember({
      source_image: "ubuntu-25.10-base", cpu: 4, memory: "1GB", disk_size: "50GB",
    });
    expect(r?.name).toBe("pool-aaaaaaaa");
    expect((await findPoolMember("pool-aaaaaaaa"))?.state).toBe("adopting");
  });

  test("partial criteria — only fields present must match (omitted = don't care)", async () => {
    await addPoolMember(fixture({
      name: "pool-aaaaaaaa", state: "ready",
      source_image: "ubuntu-25.10-base", cpu: 4, memory: "1GB", disk_size: "50GB",
    }));
    // Only source_image specified; cpu/memory/disk are don't-care.
    const r = await reserveReadyMember({ source_image: "ubuntu-25.10-base" });
    expect(r?.name).toBe("pool-aaaaaaaa");
  });

  test("picks the matching ready member when several differ in shape", async () => {
    // Three ready members of different sizes; criteria targets the 2GB one.
    await addPoolMember(fixture({ name: "pool-aaaaaaaa", state: "ready", memory: "1GB" }));
    await addPoolMember(fixture({ name: "pool-bbbbbbbb", state: "ready", memory: "2GB" }));
    await addPoolMember(fixture({ name: "pool-cccccccc", state: "ready", memory: "4GB" }));
    const r = await reserveReadyMember({ memory: "2GB" });
    expect(r?.name).toBe("pool-bbbbbbbb");
  });
});

describe("poolSummary", () => {
  test("empty registry returns zeros + caller's target_size", async () => {
    expect(await poolSummary(2)).toEqual({
      target_size: 2,
      ready_count: 0,
      provisioning_count: 0,
      warming_count: 0,
      adopting_count: 0,
    });
  });

  test("counts members by state, ignoring shape (sizing/source-image)", async () => {
    await addPoolMember(fixture({ name: "pool-11111111", state: "ready" }));
    await addPoolMember(fixture({ name: "pool-22222222", state: "ready" }));
    await addPoolMember(fixture({ name: "pool-33333333", state: "warming" }));
    await addPoolMember(fixture({ name: "pool-44444444", state: "provisioning" }));
    await addPoolMember(fixture({ name: "pool-55555555", state: "adopting" }));
    expect(await poolSummary(3)).toEqual({
      target_size: 3,
      ready_count: 2,
      provisioning_count: 1,
      warming_count: 1,
      adopting_count: 1,
    });
  });

  test("target_size is purely passthrough — registry doesn't know defaults", async () => {
    // Caller-supplied target lets the helper stay registry-only and
    // not pull defaults.json itself. Assert the value flows through
    // verbatim regardless of registry contents.
    expect((await poolSummary(0)).target_size).toBe(0);
    expect((await poolSummary(7)).target_size).toBe(7);
  });
});
