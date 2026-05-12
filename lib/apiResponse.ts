// Welld's JSON error-response shape. Cells's CLI/client expects this
// `{error: <code>, message: <text>}` envelope on 4xx/5xx; `lib/apiClient.ts`'s
// ApiError unpacks it back into `(status, errorCode, message)` for callers.
// Keep this in sync with the sprites parity contract — see
// `docs/sprites-parity.md` "Quirks wells must honor" for the snake_case
// + tolerant-policy-reads expectations.

export function apiError(
  status: number,
  error: string,
  message: string,
): Response {
  return Response.json({ error, message }, { status });
}

// 401 response with the bearer realm. Browsers + clients use the
// WWW-Authenticate header to decide whether to prompt for credentials.
export function unauthorized(): Response {
  return new Response("unauthorized\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="welld"' },
  });
}

// Validate a sprite-shaped well resource against the TypeBox schema
// before returning it. Defense against silent shape drift — sprites
// clients depend on the field set being exactly what they parse.
// Logs the route + first 3 validator errors when validation fails so
// the operator can trace which handler emitted the bad shape.
import { Value } from "@sinclair/typebox/value";
import { DestroyResponse, WellResource, WellsListResponse } from "./schemas.ts";
import { log } from "./log.ts";

export function wellResourceResponse(
  body: unknown,
  route: string,
  status = 200,
): Response {
  if (!Value.Check(WellResource, body)) {
    log.error("response shape failed validation", {
      route,
      errors: [...Value.Errors(WellResource, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body, { status });
}

// Same shape-drift guard as wellResourceResponse, but for the list endpoint.
// Catches engine→API shape drift early (in dev) and acts as a should-never-fire
// guardrail (in prod).
export function wellsListResponse(body: unknown, route: string): Response {
  if (!Value.Check(WellsListResponse, body)) {
    log.error("response shape failed validation", {
      route,
      errors: [...Value.Errors(WellsListResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}

export function destroyResponse(body: unknown, route: string): Response {
  if (!Value.Check(DestroyResponse, body)) {
    log.error("response shape failed validation", {
      route,
      errors: [...Value.Errors(DestroyResponse, body)].slice(0, 3),
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(body);
}
