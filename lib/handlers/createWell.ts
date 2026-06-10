// Pure handler for POST /v1/wells. Largest welld handler — handles
// body parse, schema validation, from_image/from_thaw mutual exclusion,
// the create-or-thaw fork, failure-path lease cleanup, and response
// wiring. Same deps-injection pattern as lifecycle/hibernation/getWell.
//
// The two write paths:
// - from_thaw: clone an already-running (hibernating) source. Sizing
//   and env are IGNORED because src's saved state encodes its own.
// - default (incl. from_image): boot a fresh well via createWell, with
//   optional hibernate-ready warming sequence.
//
// Failure path: createWell/thawFrom can throw AFTER lume has already
// issued a DHCP lease. The lease is released best-effort before the
// 400 returns so /var/db/dhcpd_leases doesn't bloat with aborted-create
// zombies (cells team 2026-05-11).

import { Value } from "@sinclair/typebox/value";
import { apiError, wellResourceResponse } from "../apiResponse.ts";
import { CreateWellRequest } from "../schemas.ts";
import type { CreateOptions } from "../createWell.ts";
import { log } from "../log.ts";

export interface CreateWellDeps {
  createWell(opts: CreateOptions): Promise<unknown>;
  thawFrom(opts: { srcName: string; newName: string }): Promise<unknown>;
  clearLastTouched(name: string): void;
  releaseLeaseBestEffort(name: string): Promise<void>;
  buildWellResource(name: string): Promise<unknown | null>;
  // Re-materialize persisted service defs onto the fresh guest. Defs
  // are name-keyed and survive destroy; without this hook a same-name
  // re-create silently loses its units (mother's 18-day reply drop,
  // cells incident review 2026-06-10). Optional so handler tests that
  // don't care about services stay minimal.
  applyPersistedServices?(
    well: string,
  ): Promise<{ applied: string[]; failed: { id: string; error: string }[] }>;
  wellResourceResponse?: typeof wellResourceResponse;
}

export async function handleCreateWell(
  req: Request,
  deps: CreateWellDeps,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(CreateWellRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(CreateWellRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as CreateWellRequest;

  if (body.from_image && body.from_thaw) {
    return apiError(400, "bad_request", "from_image and from_thaw are mutually exclusive");
  }

  // Belt-and-suspenders: wipe any stale lastTouched entry for this
  // name before create. Destroy clears it too, but stale entries can
  // survive welld crashes or out-of-band cleanup.
  deps.clearLastTouched(body.name);

  try {
    if (body.from_thaw) {
      await deps.thawFrom({ srcName: body.from_thaw, newName: body.name });
    } else {
      await deps.createWell({
        name: body.name,
        cpu: body.cpu,
        memory: body.memory,
        disk: body.disk,
        ...(body.r2 ? { r2: body.r2 } : {}),
        ...(body.env ? { env: body.env } : {}),
        ...(body.from_image ? { fromImage: body.from_image } : {}),
      });
    }
  } catch (e) {
    await deps.releaseLeaseBestEffort(body.name);
    return apiError(400, "create_failed", (e as Error).message);
  }

  // The well is booted and SSH-ready here (createWell's waitForSshReady
  // gate / thaw's wake). Converge any persisted service defs onto the
  // fresh guest. Failures are loud in the log but never fail the
  // create — a poisoned def must not brick every re-create of this
  // name; cells doctor sees residual drift and can POST services/apply.
  if (deps.applyPersistedServices) {
    try {
      const r = await deps.applyPersistedServices(body.name);
      if (r.applied.length > 0) {
        log.info("create: re-applied persisted services", {
          well: body.name,
          applied: r.applied,
        });
      }
      for (const f of r.failed) {
        log.error("create: persisted service re-apply failed", {
          well: body.name,
          id: f.id,
          error: f.error,
        });
      }
    } catch (e) {
      log.error("create: persisted service re-apply threw", {
        well: body.name,
        error: (e as Error).message,
      });
    }
  }

  const resource = await deps.buildWellResource(body.name);
  if (!resource) {
    return apiError(500, "vanished", `well '${body.name}' missing post-create`);
  }
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(resource, "/v1/wells", 201);
}
