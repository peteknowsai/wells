// Pure handlers for the well-metadata endpoints:
// - POST  /v1/wells/<n>/policy/network  (set network policy)
// - GET   /v1/wells/<n>/policy/network  (read policy)
// - PATCH /v1/wells/<n>                 (sparse update — auto_sleep_seconds)
// - PUT   /v1/wells/<n>/url             (rotate bearer auth)
//
// Policy persistence is currently file-based: write tmp, rename. The
// daemon owns the file path resolution; the handler injects the write
// boundary so tests don't need a tmp dir.

import { Value } from "@sinclair/typebox/value";
import { apiError, wellResourceResponse } from "../apiResponse.ts";
import {
  NetworkPolicyRequest,
  NetworkPolicyResponse,
  PatchWellRequest,
  UrlUpdateRequest,
} from "../schemas.ts";
import { log } from "../log.ts";

// ──────────────────────────── Network policy: POST ────────────────────────────

export interface SetNetworkPolicyDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  writePolicy(name: string, rules: NetworkPolicyRequest["rules"]): Promise<void>;
}

export async function handleNetworkPolicy(
  name: string,
  req: Request,
  deps: SetNetworkPolicyDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(NetworkPolicyRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(NetworkPolicyRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as NetworkPolicyRequest;
  await deps.writePolicy(name, body.rules);

  const response: NetworkPolicyResponse = {
    accepted: true,
    enforced: false,
    rules: body.rules,
  };
  if (!Value.Check(NetworkPolicyResponse, response)) {
    log.error("response shape failed validation", {
      route: `POST /v1/wells/${name}/policy/network`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(response);
}

// ──────────────────────────── Network policy: GET ────────────────────────────

export interface GetNetworkPolicyDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  readPolicy(name: string): Promise<NetworkPolicyRequest["rules"] | null>;
}

export async function handleGetNetworkPolicy(
  name: string,
  deps: GetNetworkPolicyDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);
  const rules = (await deps.readPolicy(name)) ?? [];
  return Response.json({ rules });
}

// ──────────────────────────── Patch well ────────────────────────────

export interface PatchWellDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  updateWellAutoSleep(
    name: string,
    autoSleepSeconds: number | null,
  ): Promise<unknown | null | undefined>;
  buildWellResource(name: string): Promise<unknown | null>;
  wellResourceResponse?: typeof wellResourceResponse;
}

export async function handlePatchWell(
  name: string,
  req: Request,
  deps: PatchWellDeps,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(PatchWellRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(PatchWellRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as PatchWellRequest;

  if ("auto_sleep_seconds" in body) {
    const updated = await deps.updateWellAutoSleep(
      name,
      body.auto_sleep_seconds!,
    );
    if (!updated) return apiError(404, "not_found", `well '${name}' not found`);
  } else {
    const exists = await deps.findWell(name);
    if (!exists) return apiError(404, "not_found", `well '${name}' not found`);
  }

  const resource = await deps.buildWellResource(name);
  if (!resource) return apiError(500, "vanished", `well '${name}' missing post-patch`);
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(resource, `PATCH /v1/wells/${name}`);
}

// ──────────────────────────── Update URL (rotate auth) ────────────────────────────

export interface UpdateUrlDeps {
  updateWellAuth(
    name: string,
    auth: "public" | "well",
  ): Promise<unknown | null | undefined>;
  buildWellResource(name: string): Promise<unknown | null>;
  wellResourceResponse?: typeof wellResourceResponse;
}

export async function handleUpdateUrl(
  name: string,
  req: Request,
  deps: UpdateUrlDeps,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(UrlUpdateRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(UrlUpdateRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as UrlUpdateRequest;
  const updated = await deps.updateWellAuth(name, body.auth);
  if (!updated) return apiError(404, "not_found", `well '${name}' not found`);

  const resource = await deps.buildWellResource(name);
  if (!resource) return apiError(500, "vanished", `well '${name}' missing post-update`);
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(resource, `PUT /v1/wells/${name}/url`);
}
