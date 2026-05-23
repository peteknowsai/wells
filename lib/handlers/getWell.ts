// Pure handler for GET /v1/wells/<name>. The simplest of the welld
// handlers — one dep, two paths. Extracted to lib/handlers/ to follow
// the pattern set by lifecycle.ts and hibernation.ts.
//
// Note: GET /v1/wells/<name>* does NOT touch the watchdog (per
// 2026-05-23 fix in daemon/welld.ts). GET is inspection, not use —
// polling status shouldn't keep a well awake. Activity-implying paths
// (exec, proxy, WS) touch via their own handlers.

import { apiError, wellResourceResponse } from "../apiResponse.ts";

export interface GetWellDeps {
  buildWellResource(name: string): Promise<unknown | null>;
  wellResourceResponse?: typeof wellResourceResponse;
}

export async function handleGetWell(
  name: string,
  deps: GetWellDeps,
): Promise<Response> {
  const body = await deps.buildWellResource(name);
  if (!body) return apiError(404, "not_found", `well '${name}' not found`);
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(body, `/v1/wells/${name}`);
}
