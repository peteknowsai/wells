import { describe, expect, test } from "bun:test";
import {
  handleListPool,
  handleRefillPool,
  handleDrainPool,
  type ListPoolDeps,
  type RefillPoolDeps,
  type DrainPoolDeps,
  type PoolMemberView,
} from "./pool.ts";

function poolMember(over: Partial<PoolMemberView> = {}): PoolMemberView {
  return {
    name: "pool-aaaa",
    source_image: "ubuntu-25.10-base",
    cpu: 2,
    memory: "1GB",
    disk_size: "10GB",
    state: "ready",
    created_at: "2026-05-12T00:00:00Z",
    ...over,
  };
}

describe("handleListPool", () => {
  test("empty pool → empty members, target_size + ready_count", async () => {
    const deps: ListPoolDeps = {
      listPoolMembers: async () => [],
      loadDefaults: async () => ({ pool_size: 5 }),
    };
    const res = await handleListPool(deps);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      members: unknown[];
      target_size: number;
      ready_count: number;
    };
    expect(body.members).toEqual([]);
    expect(body.target_size).toBe(5);
    expect(body.ready_count).toBe(0);
  });

  test("ready_count counts only state=ready", async () => {
    const deps: ListPoolDeps = {
      listPoolMembers: async () => [
        poolMember({ name: "a", state: "ready" }),
        poolMember({ name: "b", state: "warming" }),
        poolMember({ name: "c", state: "ready" }),
        poolMember({ name: "d", state: "provisioning" }),
      ],
      loadDefaults: async () => ({ pool_size: 5 }),
    };
    const res = await handleListPool(deps);
    const body = await res.json() as { ready_count: number };
    expect(body.ready_count).toBe(2);
  });

  test("ready_at flows when present, omitted when absent", async () => {
    const deps: ListPoolDeps = {
      listPoolMembers: async () => [
        poolMember({ name: "a", ready_at: "2026-05-12T01:00:00Z" }),
        poolMember({ name: "b" }),
      ],
      loadDefaults: async () => ({ pool_size: 5 }),
    };
    const res = await handleListPool(deps);
    const body = await res.json() as { members: Array<Record<string, unknown>> };
    expect(body.members[0].ready_at).toBe("2026-05-12T01:00:00Z");
    expect("ready_at" in body.members[1]).toBe(false);
  });
});

describe("handleRefillPool", () => {
  test("kicks the filler, returns ok=true with the no-op-safe message", () => {
    let triggered = false;
    const deps: RefillPoolDeps = {
      triggerFillIfNeeded: () => {
        triggered = true;
      },
    };
    const res = handleRefillPool(deps);
    expect(res.status).toBe(200);
    expect(triggered).toBe(true);
  });
});

describe("handleDrainPool", () => {
  test("default scope (all=false) → drainReadyPoolMembers, message says 'ready'", async () => {
    const deps: DrainPoolDeps = {
      drainAllPoolMembers: async () => 99,
      drainReadyPoolMembers: async () => 3,
    };
    const res = await handleDrainPool(false, deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; message: string };
    expect(body.count).toBe(3);
    expect(body.message).toContain("ready member");
  });

  test("all=true → drainAllPoolMembers, message says 'all states'", async () => {
    const deps: DrainPoolDeps = {
      drainAllPoolMembers: async () => 7,
      drainReadyPoolMembers: async () => 99,
    };
    const res = await handleDrainPool(true, deps);
    const body = await res.json() as { count: number; message: string };
    expect(body.count).toBe(7);
    expect(body.message).toContain("all states");
  });
});
