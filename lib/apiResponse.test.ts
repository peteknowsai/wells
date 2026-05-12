import { describe, expect, test } from "bun:test";
import { apiError, unauthorized } from "./apiResponse.ts";

// Welld's error-response envelope. Cells's CLI (apiClient.ts) reads
// `{error: <code>, message: <text>}` from 4xx/5xx bodies; if we change
// the shape, every wells-touching caller breaks. Tests pin the wire
// format.

describe("apiError", () => {
  test("returns a Response with the requested status", async () => {
    const r = apiError(404, "not_found", "well 'ghost' not found");
    expect(r.status).toBe(404);
  });

  test("body is JSON with {error, message}", async () => {
    const r = apiError(400, "bad_json", "request body is not valid JSON");
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = await r.json();
    expect(body).toEqual({ error: "bad_json", message: "request body is not valid JSON" });
  });

  test("preserves status code variants (5xx, 4xx, edge codes)", async () => {
    expect(apiError(500, "internal", "x").status).toBe(500);
    expect(apiError(503, "unavailable", "x").status).toBe(503);
    expect(apiError(409, "conflict", "x").status).toBe(409);
  });

  test("error + message round-trip verbatim (no escaping, no field-mixing)", async () => {
    const tricky = 'message with "quotes" and \\ backslashes and unicode café';
    const r = apiError(400, "bad_request", tricky);
    const body = await r.json();
    expect(body.message).toBe(tricky);
  });
});

describe("unauthorized", () => {
  test("returns 401", async () => {
    expect(unauthorized().status).toBe(401);
  });

  test("body is text 'unauthorized\\n'", async () => {
    const r = unauthorized();
    expect(await r.text()).toBe("unauthorized\n");
  });

  test("emits WWW-Authenticate: Bearer realm=\"welld\" header", () => {
    const r = unauthorized();
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="welld"');
  });
});
