// Pure handler for POST /v1/wells/<name>/(start|stop). Extracted from
// daemon/welld.ts so the orchestration is unit-testable without
// spinning up welld + lume. Production wiring in daemon/welld.ts
// (handleLifecycle calls this with real deps); tests pass in mocks.
//
// The handler's contract:
//
// - findWell returns null → 404 "not_found".
// - verb=start → ensureRunning. Idempotent across stopped/paused/
//   hibernating/running (cells team wake-on-traffic contract, B.0.7).
// - verb=stop → transitionWell("stop"). Idempotent on already-stopped.
// - Either step throws → 500 with verb-specific error code.
// - Post-action buildWellResource returns null → 500 "vanished"
//   (mid-call destroy or other state-drift edge).
// - Otherwise → 200 with sprite-shaped resource.

import { apiError, wellResourceResponse } from "../apiResponse.ts";

export type LifecycleVerb = "start" | "stop";

// Minimal dep surface — every external call the handler makes is
// passed in so tests can substitute. `unknown` for the return of
// ensureRunning/transitionWell is fine: handleLifecycle only cares
// whether they threw, not what they returned.
export interface LifecycleDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  ensureRunning(name: string, timeoutMs: number): Promise<unknown>;
  transitionWell(name: string, verb: "stop"): Promise<unknown>;
  buildWellResource(name: string): Promise<unknown | null>;
  // Allow the response-shape validator to be injected too; production
  // uses lib/apiResponse.ts:wellResourceResponse which checks the
  // TypeBox shape, but tests can pass a passthrough if they're not
  // exercising the validator branch.
  wellResourceResponse?: typeof wellResourceResponse;
}

export const START_TIMEOUT_MS = 60_000;

export async function handleLifecycle(
  name: string,
  verb: LifecycleVerb,
  deps: LifecycleDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    if (verb === "start") {
      await deps.ensureRunning(name, START_TIMEOUT_MS);
    } else {
      await deps.transitionWell(name, "stop");
    }
  } catch (e) {
    return apiError(500, `${verb}_failed`, (e as Error).message);
  }

  const body = await deps.buildWellResource(name);
  if (!body) return apiError(500, "vanished", `well '${name}' disappeared mid-${verb}`);
  const respond = deps.wellResourceResponse ?? wellResourceResponse;
  return respond(body, `/v1/wells/${name}/${verb}`);
}
