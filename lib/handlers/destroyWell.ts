// Pure handler for DELETE /v1/wells/<name>. Idempotent — destroyWell
// itself handles the missing-pieces case. The handler's job is the
// in-memory state cleanup (idle tracker, watchdog failure counter)
// that the daemon module owns and that destroyWell can't reach.
//
// Stale lastTouched cleanup is critical: cells team 2026-05-10 hit a
// case where ck-pi-gpt55 got auto-hibernated 6s after recreate because
// the watchdog inherited the prior instance's 7-min-old touch.

import { apiError, destroyResponse } from "../apiResponse.ts";

export interface DestroyResult {
  found: boolean;
  removedRegistry: boolean;
  removedStateDir: boolean;
  removedBundle: boolean;
}

export interface DestroyWellDeps {
  destroyWell(name: string): Promise<DestroyResult>;
  clearLastTouched(name: string): void;
  clearWatchdogFailures(name: string): void;
  destroyResponse?: typeof destroyResponse;
}

export async function handleDestroyWell(
  name: string,
  deps: DestroyWellDeps,
): Promise<Response> {
  let r: DestroyResult;
  try {
    r = await deps.destroyWell(name);
  } catch (e) {
    return apiError(500, "destroy_failed", (e as Error).message);
  }
  deps.clearLastTouched(name);
  deps.clearWatchdogFailures(name);
  const body = {
    name,
    found: r.found,
    removed_registry: r.removedRegistry,
    removed_state_dir: r.removedStateDir,
    removed_bundle: r.removedBundle,
  };
  const respond = deps.destroyResponse ?? destroyResponse;
  return respond(body, `/v1/wells/${name}`);
}
