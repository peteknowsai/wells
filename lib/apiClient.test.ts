import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, apiFetch } from "./apiClient.ts";

// apiClient.ts is the CLI's only path to welld. Bugs in error parsing
// or token resolution surface as cryptic CLI errors, so test every
// branch directly against a real Bun.serve.

interface FakeServer {
  port: number;
  stop: () => void;
}

let server: FakeServer | null = null;
const savedEnv: { url?: string; token?: string } = {};

function startServer(
  handler: (req: Request) => Response | Promise<Response>,
): FakeServer {
  const s = Bun.serve({ port: 0, fetch: handler });
  return {
    port: s.port,
    stop: () => s.stop(true),
  };
}

beforeEach(() => {
  savedEnv.url = process.env.WELL_API_URL;
  savedEnv.token = process.env.WELL_TOKEN;
  process.env.WELL_TOKEN = "test-token-deadbeef";
});

afterEach(() => {
  if (server) {
    server.stop();
    server = null;
  }
  if (savedEnv.url === undefined) delete process.env.WELL_API_URL;
  else process.env.WELL_API_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.WELL_TOKEN;
  else process.env.WELL_TOKEN = savedEnv.token;
});

describe("apiFetch — happy paths", () => {
  test("returns parsed JSON on 200 with JSON body", async () => {
    server = startServer(() =>
      Response.json({ name: "well-1", status: "running" }),
    );
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    const result = await apiFetch<{ name: string; status: string }>(
      "GET",
      "/v1/wells/well-1",
    );
    expect(result.name).toBe("well-1");
    expect(result.status).toBe("running");
  });

  test("returns undefined when response body is empty (204-style)", async () => {
    server = startServer(() => new Response(null, { status: 200 }));
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    const result = await apiFetch("DELETE", "/v1/wells/anything");
    expect(result).toBeUndefined();
  });

  test("returns text when body is non-JSON", async () => {
    server = startServer(() => new Response("plain text body", { status: 200 }));
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    const result = await apiFetch<string>("GET", "/v1/healthz");
    expect(result).toBe("plain text body");
  });

  test("sends Authorization: Bearer <token> header", async () => {
    let received: string | null = null;
    server = startServer((req) => {
      received = req.headers.get("authorization");
      return Response.json({ ok: true });
    });
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    await apiFetch("GET", "/v1/wells");
    expect(received).toBe("Bearer test-token-deadbeef");
  });

  test("sends JSON body + Content-Type when body provided", async () => {
    let receivedBody = "";
    let receivedType: string | null = null;
    server = startServer(async (req) => {
      receivedType = req.headers.get("content-type");
      receivedBody = await req.text();
      return Response.json({ ok: true });
    });
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    await apiFetch("POST", "/v1/wells", { name: "well-1", cpu: 4 });
    expect(receivedType).toBe("application/json");
    expect(JSON.parse(receivedBody)).toEqual({ name: "well-1", cpu: 4 });
  });

  test("does NOT send Content-Type header when body is undefined", async () => {
    let receivedType: string | null = null;
    server = startServer((req) => {
      receivedType = req.headers.get("content-type");
      return Response.json({ ok: true });
    });
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    await apiFetch("GET", "/v1/wells");
    expect(receivedType).toBeNull();
  });
});

describe("apiFetch — error paths", () => {
  test("4xx with JSON error body throws ApiError with code + message", async () => {
    server = startServer(() =>
      Response.json(
        { error: "not_found", message: "well 'ghost' not found" },
        { status: 404 },
      ),
    );
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    try {
      await apiFetch("GET", "/v1/wells/ghost");
      throw new Error("expected ApiError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(404);
      expect(err.errorCode).toBe("not_found");
      expect(err.message).toBe("well 'ghost' not found");
    }
  });

  test("4xx with non-JSON body keeps a raw slice as the message", async () => {
    server = startServer(() => new Response("plain server error\n", { status: 400 }));
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    try {
      await apiFetch("POST", "/v1/wells", {});
      throw new Error("expected ApiError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(400);
      expect(err.errorCode).toBe("http_error");
      expect(err.message).toBe("plain server error\n");
    }
  });

  test("5xx with JSON error parses errorCode + message", async () => {
    server = startServer(() =>
      Response.json(
        { error: "internal", message: "lume serve gone" },
        { status: 500 },
      ),
    );
    process.env.WELL_API_URL = `http://127.0.0.1:${server.port}`;
    try {
      await apiFetch("GET", "/v1/wells");
      throw new Error("expected ApiError");
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(500);
      expect(err.errorCode).toBe("internal");
      expect(err.message).toBe("lume serve gone");
    }
  });

  test("unreachable URL throws a friendly error mentioning the URL", async () => {
    process.env.WELL_API_URL = "http://127.0.0.1:1"; // port 1, not bound
    try {
      await apiFetch("GET", "/v1/wells");
      throw new Error("expected fetch error");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("cannot reach welld");
      expect(msg).toContain("http://127.0.0.1:1");
    }
  });

  test("missing token throws when WELL_TOKEN env not set + no on-disk token", async () => {
    // readToken() reads from PATHS.token() which is derived from
    // WELL_STATE_DIR. Point it at a nonexistent dir so readToken
    // returns null, and clear WELL_TOKEN so apiClient has to fall
    // through to it.
    delete process.env.WELL_TOKEN;
    const savedStateDir = process.env.WELL_STATE_DIR;
    process.env.WELL_STATE_DIR = "/nonexistent/wells-test-dir-xyz";
    try {
      await apiFetch("GET", "/v1/wells");
      throw new Error("expected token error");
    } catch (e) {
      expect((e as Error).message).toContain("no wells token");
    } finally {
      if (savedStateDir === undefined) delete process.env.WELL_STATE_DIR;
      else process.env.WELL_STATE_DIR = savedStateDir;
    }
  });
});
