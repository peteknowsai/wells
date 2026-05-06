import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { LumeClient } from "./lume.ts";

type Recorded = { method: string; path: string; body?: unknown };

describe("LumeClient", () => {
  let server: ReturnType<typeof Bun.serve>;
  let recorded: Recorded[];
  let nextResponse: { status: number; body: unknown };
  let client: LumeClient;

  beforeEach(() => {
    recorded = [];
    nextResponse = { status: 200, body: [] };
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        let body: unknown = undefined;
        if (req.method !== "GET" && req.method !== "DELETE") {
          const text = await req.text();
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }
        }
        recorded.push({
          method: req.method,
          path: url.pathname + url.search,
          body,
        });
        return Response.json(nextResponse.body, { status: nextResponse.status });
      },
    });
    client = new LumeClient(`http://127.0.0.1:${server.port}`);
  });

  afterEach(() => {
    server.stop();
  });

  test("list() → GET /lume/vms", async () => {
    nextResponse = { status: 200, body: [{ name: "pete" }] };
    const result = await client.list();
    expect(recorded).toEqual([
      { method: "GET", path: "/lume/vms", body: undefined },
    ]);
    expect(result).toEqual([{ name: "pete" }]);
  });

  test("list(storage) → GET /lume/vms?storage=X", async () => {
    await client.list("ssd");
    expect(recorded[0]!.path).toBe("/lume/vms?storage=ssd");
  });

  test("info(name) → GET /lume/vms/:name", async () => {
    nextResponse = { status: 200, body: { name: "pete", state: "running" } };
    const result = await client.info("pete");
    expect(recorded).toEqual([
      { method: "GET", path: "/lume/vms/pete", body: undefined },
    ]);
    expect(result).toEqual({ name: "pete", state: "running" });
  });

  test("create() → POST /lume/vms with body", async () => {
    await client.create({ name: "pete", os: "linux", cpu: 4, memory: "4GB" });
    expect(recorded[0]).toEqual({
      method: "POST",
      path: "/lume/vms",
      body: { name: "pete", os: "linux", cpu: 4, memory: "4GB" },
    });
  });

  test("clone() → POST /lume/vms/clone with body", async () => {
    await client.clone({ name: "base", newName: "pete" });
    expect(recorded[0]).toEqual({
      method: "POST",
      path: "/lume/vms/clone",
      body: { name: "base", newName: "pete" },
    });
  });

  test("start(name) → POST /lume/vms/:name/run", async () => {
    await client.start("pete", { noDisplay: true });
    expect(recorded[0]).toEqual({
      method: "POST",
      path: "/lume/vms/pete/run",
      body: { noDisplay: true },
    });
  });

  test("stop(name) → POST /lume/vms/:name/stop", async () => {
    await client.stop("pete");
    expect(recorded[0]!.method).toBe("POST");
    expect(recorded[0]!.path).toBe("/lume/vms/pete/stop");
  });

  test("stop(name, storage) sends storage in body", async () => {
    await client.stop("pete", "ssd");
    expect(recorded[0]!.body).toEqual({ storage: "ssd" });
  });

  test("delete(name) → DELETE /lume/vms/:name", async () => {
    await client.delete("pete");
    expect(recorded[0]).toEqual({
      method: "DELETE",
      path: "/lume/vms/pete",
      body: undefined,
    });
  });

  test("pull() → POST /lume/pull with body", async () => {
    await client.pull({ image: "ghcr.io/trycua/macos:latest", name: "macbase" });
    expect(recorded[0]).toEqual({
      method: "POST",
      path: "/lume/pull",
      body: { image: "ghcr.io/trycua/macos:latest", name: "macbase" },
    });
  });

  test("non-2xx throws with status + body excerpt", async () => {
    nextResponse = { status: 500, body: { error: "boom" } };
    await expect(client.list()).rejects.toThrow(/500/);
  });

  test("urlencodes special name chars", async () => {
    await client.info("name with spaces");
    expect(recorded[0]!.path).toBe("/lume/vms/name%20with%20spaces");
  });
});

describe("LumeClient.waitForStatus", () => {
  let server: ReturnType<typeof Bun.serve>;
  let statusSequence: string[];
  let cursor: number;
  let client: LumeClient;

  beforeEach(() => {
    statusSequence = [];
    cursor = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        const status =
          statusSequence[Math.min(cursor, statusSequence.length - 1)] ??
          "unknown";
        cursor++;
        return Response.json({ name: "pete", status });
      },
    });
    client = new LumeClient(`http://127.0.0.1:${server.port}`);
  });

  afterEach(() => {
    server.stop();
  });

  test("returns immediately when target already matches", async () => {
    statusSequence = ["stopped"];
    const result = await client.waitForStatus("pete", "stopped", {
      intervalMs: 10,
    });
    expect(result.status).toBe("stopped");
    expect(cursor).toBe(1);
  });

  test("polls until target reached", async () => {
    statusSequence = ["provisioning", "provisioning", "stopped"];
    const result = await client.waitForStatus("pete", "stopped", {
      intervalMs: 10,
    });
    expect(result.status).toBe("stopped");
    expect(cursor).toBeGreaterThanOrEqual(3);
  });

  test("accepts multiple target states", async () => {
    statusSequence = ["provisioning", "running"];
    const result = await client.waitForStatus("pete", ["stopped", "running"], {
      intervalMs: 10,
    });
    expect(result.status).toBe("running");
  });

  test("throws on timeout with last-seen status in message", async () => {
    statusSequence = ["provisioning"];
    await expect(
      client.waitForStatus("pete", "stopped", {
        timeoutMs: 50,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/provisioning/);
  });
});
