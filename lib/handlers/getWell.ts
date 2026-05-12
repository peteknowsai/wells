// Pure handler for GET /v1/wells/<name>. The simplest of the welld
// handlers — one dep, two paths. Extracted to lib/handlers/ to follow
// the pattern set by lifecycle.ts and hibernation.ts.
//
// Note: GET /v1/wells/<name>* also triggers a watchdog touch in the
// daemon's request dispatcher (daemon/welld.ts:469 — touchMatch regex),
// not in this handler. Touch is a side effect of routing, not of the
// resource read. Documented in findings-scenario-coverage.md.

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
