// Pure handlers for /v1/wells/<name>/checkpoints/* endpoints.
//
// Create gates on a running well (filesystem sync requires it), with
// wake-on-demand. List + Expire just need the well to exist. Restore
// routes the well-not-found message to 404 by sniffing the error text,
// preserving the existing API contract.

import { Value } from "@sinclair/typebox/value";
import { apiError, wellResourceResponse } from "../apiResponse.ts";
import {
  CheckpointResource,
  CheckpointsListResponse,
} from "../schemas.ts";
import { log } from "../log.ts";

export interface ListedCheckpointLike {
  id: string;
  [key: string]: unknown;
}

export interface CheckpointCreateResult {
  id: string;
}

export interface CreateCheckpointDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  ensureRunning(name: string, timeoutMs: number): Promise<unknown>;
  createCheckpoint(
    name: string,
    opts: { comment?: string; retainForSeconds?: number },
  ): Promise<CheckpointCreateResult>;
  listCheckpoints(name: string): Promise<ListedCheckpointLike[]>;
  parseDuration(s: string): number | undefined;
}

export async function handleCreateCheckpoint(
  name: string,
  req: Request,
  deps: CreateCheckpointDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  try {
    await deps.ensureRunning(name, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }
  let comment: string | undefined;
  let retainForSeconds: number | undefined;
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    try {
      const body = await req.json() as { comment?: unknown; retain_for?: unknown };
      if (typeof body?.comment === "string") comment = body.comment;
      if (typeof body?.retain_for === "string") {
        const parsed = deps.parseDuration(body.retain_for);
        if (parsed === undefined) {
          return apiError(
            400,
            "bad_request",
            `invalid retain_for: '${body.retain_for}' (expected e.g. 7d, 12h, 30m, 45s)`,
          );
        }
        retainForSeconds = parsed;
      }
    } catch {
      // Treat unparseable body as no comment — sprites is lenient here.
    }
  }
  let cp: CheckpointCreateResult;
  try {
    cp = await deps.createCheckpoint(name, {
      ...(comment !== undefined ? { comment } : {}),
      ...(retainForSeconds !== undefined ? { retainForSeconds } : {}),
    });
  } catch (e) {
    return apiError(500, "checkpoint_failed", (e as Error).message);
  }
  const all = await deps.listCheckpoints(name);
  const fresh = all.find((c) => c.id === cp.id);
  if (!fresh) {
    return apiError(500, "checkpoint_vanished", `checkpoint '${cp.id}' missing post-create`);
  }
  if (!Value.Check(CheckpointResource, fresh)) {
    log.error("response shape failed validation", {
      route: `POST /v1/wells/${name}/checkpoints`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(fresh, { status: 201 });
}

export interface ListCheckpointsDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  listCheckpoints(name: string): Promise<unknown[]>;
}

export async function handleListCheckpoints(
  name: string,
  deps: ListCheckpointsDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  const checkpoints = await deps.listCheckpoints(name);
  const body = { checkpoints };
  if (!Value.Check(CheckpointsListResponse, body)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/${name}/checkpoints`,
      errors: [...Value.Errors(CheckpointsListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

export interface ExpireCheckpointDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  expireCheckpoint(name: string, id: string): Promise<{ removed: boolean }>;
}

export async function handleExpireCheckpoint(
  name: string,
  id: string,
  deps: ExpireCheckpointDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  const r = await deps.expireCheckpoint(name, id);
  return Response.json({ id, removed: r.removed });
}

export interface RestoreCheckpointDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  restoreCheckpoint(
    name: string,
    id: string,
    opts: { fromR2: boolean },
  ): Promise<unknown>;
  buildWellResource(name: string): Promise<unknown | null>;
  wellResourceResponse?: typeof wellResourceResponse;
}

export async function handleRestoreCheckpoint(
  name: string,
  id: string,
  fromR2: boolean,
  deps: RestoreCheckpointDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  try {
    await deps.restoreCheckpoint(name, id, { fromR2 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /not found/i.test(msg) ? 404 : 500;
    return apiError(status, "restore_failed", msg);
  }
  const body = await deps.buildWellResource(name);
  if (!body) return apiError(500, "vanished", `well '${name}' missing post-restore`);
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(body, `POST /v1/wells/${name}/checkpoints/${id}/restore`);
}
