// Pure handler for POST /v1/wells/<name>/(hibernate|wake). Parallel
// structure to lib/handlers/lifecycle.ts — both verbs route through
// transitionWell which lock + dispatch + actuate + write runtime.
//
// Contract:
//
// - findWell returns null → 404 "not_found".
// - transitionWell handles the verb (B.0.7.g): hibernate-on-hibernating
//   and wake-on-running are documented no-op successes, so callers
//   don't have to branch on current state.
// - transitionWell throws → 500 "<verb>_failed".
// - Post-action buildWellResource null → 500 "vanished".
// - Otherwise → 200 with sprite-shaped resource.

import { apiError, wellResourceResponse } from "../apiResponse.ts";

export type HibernationVerb = "hibernate" | "wake";

export interface HibernationDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  transitionWell(name: string, verb: HibernationVerb): Promise<unknown>;
  buildWellResource(name: string): Promise<unknown | null>;
  wellResourceResponse?: typeof wellResourceResponse;
}

export async function handleHibernation(
  name: string,
  verb: HibernationVerb,
  deps: HibernationDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    await deps.transitionWell(name, verb);
  } catch (e) {
    return apiError(500, `${verb}_failed`, (e as Error).message);
  }

  const body = await deps.buildWellResource(name);
  if (!body) return apiError(500, "vanished", `well '${name}' disappeared mid-${verb}`);
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(body, `/v1/wells/${name}/${verb}`);
}
