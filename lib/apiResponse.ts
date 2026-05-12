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
