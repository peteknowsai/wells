import { describe, expect, test } from "bun:test";
import { isAuthorized } from "./auth.ts";

const TOKEN = "test-token-deadbeef";

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", { headers });
}

describe("isAuthorized", () => {
  test("bearer header with correct token → true", () => {
    const req = reqWith({ Authorization: `Bearer ${TOKEN}` });
    expect(isAuthorized(req, TOKEN)).toBe(true);
  });

  test("bearer header is case-insensitive (`Bearer` / `BEARER` / `bearer`)", () => {
    for (const prefix of ["Bearer", "BEARER", "bearer"]) {
      const req = reqWith({ Authorization: `${prefix} ${TOKEN}` });
      expect(isAuthorized(req, TOKEN)).toBe(true);
    }
  });

  test("bearer header with wrong token → false", () => {
    const req = reqWith({ Authorization: "Bearer wrong-token-xxxxx" });
    expect(isAuthorized(req, TOKEN)).toBe(false);
  });

  test("absent Authorization header → false", () => {
    expect(isAuthorized(reqWith(), TOKEN)).toBe(false);
  });

  test("malformed Authorization header (no bearer prefix) → false", () => {
    const req = reqWith({ Authorization: `Basic ${TOKEN}` });
    expect(isAuthorized(req, TOKEN)).toBe(false);
  });

  test("empty bearer value → false", () => {
    const req = reqWith({ Authorization: "Bearer" });
    expect(isAuthorized(req, TOKEN)).toBe(false);
  });

  test("?token= query fallback with correct token → true", () => {
    const url = new URL(`http://localhost/?token=${TOKEN}`);
    expect(isAuthorized(reqWith(), TOKEN, url)).toBe(true);
  });

  test("?token= query fallback with wrong token → false", () => {
    const url = new URL("http://localhost/?token=wrong");
    expect(isAuthorized(reqWith(), TOKEN, url)).toBe(false);
  });

  test("header beats absent query (header path checked first)", () => {
    const req = reqWith({ Authorization: `Bearer ${TOKEN}` });
    expect(isAuthorized(req, TOKEN, new URL("http://localhost/"))).toBe(true);
  });

  test("query token works when header is wrong", () => {
    const req = reqWith({ Authorization: "Bearer wrong" });
    const url = new URL(`http://localhost/?token=${TOKEN}`);
    expect(isAuthorized(req, TOKEN, url)).toBe(true);
  });

  test("length-mismatched candidate → false (no throw)", () => {
    const req = reqWith({ Authorization: "Bearer short" });
    expect(isAuthorized(req, TOKEN)).toBe(false);
  });

  test("urlForQuery omitted → falls through cleanly (no error)", () => {
    expect(isAuthorized(reqWith(), TOKEN)).toBe(false);
  });
});
