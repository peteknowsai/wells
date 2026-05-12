// Pure handlers for the /v1/wells/pool endpoints. Pool depth visibility,
// idempotent refill kick, and selective drain.

import { Value } from "@sinclair/typebox/value";
import { apiError } from "../apiResponse.ts";
import { PoolListResponse, type PoolMemberResource } from "../schemas.ts";
import { log } from "../log.ts";

export interface PoolMemberView {
  name: string;
  source_image: string;
  cpu: number;
  memory: string;
  disk_size: string;
  state: string;
  created_at: string;
  ready_at?: string;
}

export interface ListPoolDeps {
  listPoolMembers(): Promise<PoolMemberView[]>;
  loadDefaults(): Promise<{ pool_size: number }>;
}

export async function handleListPool(deps: ListPoolDeps): Promise<Response> {
  const [members, defaults] = await Promise.all([
    deps.listPoolMembers(),
    deps.loadDefaults(),
  ]);
  const resourceMembers: PoolMemberResource[] = members.map((m) => ({
    name: m.name,
    source_image: m.source_image,
    cpu: m.cpu,
    memory: m.memory,
    disk_size: m.disk_size,
    state: m.state as PoolMemberResource["state"],
    created_at: m.created_at,
    ...(m.ready_at ? { ready_at: m.ready_at } : {}),
  }));
  const body = {
    members: resourceMembers,
    target_size: defaults.pool_size,
    ready_count: members.filter((m) => m.state === "ready").length,
  };
  if (!Value.Check(PoolListResponse, body)) {
    log.error("response shape failed validation", { route: "GET /v1/wells/pool" });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

export interface RefillPoolDeps {
  triggerFillIfNeeded(): void;
}

export function handleRefillPool(deps: RefillPoolDeps): Response {
  deps.triggerFillIfNeeded();
  return Response.json({
    ok: true,
    message: "fill triggered (no-op if depth at target or fill in flight)",
  });
}

export interface DrainPoolDeps {
  drainAllPoolMembers(): Promise<number>;
  drainReadyPoolMembers(): Promise<number>;
}

export async function handleDrainPool(
  all: boolean,
  deps: DrainPoolDeps,
): Promise<Response> {
  const count = all
    ? await deps.drainAllPoolMembers()
    : await deps.drainReadyPoolMembers();
  const message = all
    ? `drained ${count} member(s) (all states); set defaults.pool_size=0 first if you want to keep depth at zero`
    : `drained ${count} ready member(s); set defaults.pool_size=0 first if you want to keep depth at zero`;
  return Response.json({ ok: true, message, count });
}

// apiError re-export for tests that need to assert on the envelope; not
// used by these handlers directly (no error paths in the current shape).
export { apiError };
