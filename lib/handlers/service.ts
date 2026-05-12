// Pure handlers for /v1/wells/<n>/services/* endpoints.
//
// Put/Delete need wake-on-demand: applying or removing a service SSHes
// into the guest to install/uninstall the systemd unit. Get/List read
// the well's local state and only need findWell.

import { Value } from "@sinclair/typebox/value";
import { apiError } from "../apiResponse.ts";
import {
  ServiceDefinition,
  ServiceResource,
  ServicesListResponse,
} from "../schemas.ts";
import { log } from "../log.ts";

// ──────────────────────────── Put ────────────────────────────

export interface PutServiceDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  ensureRunning(name: string, timeoutMs: number): Promise<unknown>;
  putService(
    well: string,
    id: string,
    def: ServiceDefinition,
  ): Promise<unknown>;
}

export async function handlePutService(
  well: string,
  id: string,
  req: Request,
  deps: PutServiceDeps,
): Promise<Response> {
  const record = await deps.findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  try {
    await deps.ensureRunning(well, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(ServiceDefinition, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(ServiceDefinition, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const def = parsed as ServiceDefinition;

  let resource: unknown;
  try {
    resource = await deps.putService(well, id, def);
  } catch (e) {
    const msg = (e as Error).message;
    const status = /invalid/i.test(msg) ? 400 : 500;
    return apiError(status, "service_apply_failed", msg);
  }
  if (!Value.Check(ServiceResource, resource)) {
    log.error("response shape failed validation", {
      route: `PUT /v1/wells/${well}/services/${id}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource);
}

// ──────────────────────────── Delete ────────────────────────────

export interface DeleteServiceDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  ensureRunning(name: string, timeoutMs: number): Promise<unknown>;
  deleteService(well: string, id: string): Promise<boolean>;
}

export async function handleDeleteService(
  well: string,
  id: string,
  deps: DeleteServiceDeps,
): Promise<Response> {
  const record = await deps.findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  try {
    await deps.ensureRunning(well, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }
  let found: boolean;
  try {
    found = await deps.deleteService(well, id);
  } catch (e) {
    return apiError(500, "service_delete_failed", (e as Error).message);
  }
  return Response.json({ id, well, found });
}

// ──────────────────────────── Get ────────────────────────────

export interface GetServiceDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  getService(well: string, id: string): Promise<unknown | null>;
}

export async function handleGetService(
  well: string,
  id: string,
  deps: GetServiceDeps,
): Promise<Response> {
  const record = await deps.findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  let resource: unknown | null;
  try {
    resource = await deps.getService(well, id);
  } catch (e) {
    return apiError(400, "bad_request", (e as Error).message);
  }
  if (!resource) {
    return apiError(404, "not_found", `service '${id}' not found on well '${well}'`);
  }
  if (!Value.Check(ServiceResource, resource)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/${well}/services/${id}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(resource);
}

// ──────────────────────────── List ────────────────────────────

export interface ListServicesDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  listServices(well: string): Promise<unknown[]>;
}

export async function handleListServices(
  well: string,
  deps: ListServicesDeps,
): Promise<Response> {
  const record = await deps.findWell(well);
  if (!record) return apiError(404, "not_found", `well '${well}' not found`);
  const services = await deps.listServices(well);
  const body = { services };
  if (!Value.Check(ServicesListResponse, body)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/${well}/services`,
      errors: [...Value.Errors(ServicesListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}
