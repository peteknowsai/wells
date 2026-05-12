import { describe, expect, test } from "bun:test";
import {
  buildUpstreamWsInit,
  extractWellFromHost,
  publicBase,
  upstreamWsUrl,
  type ProxyTarget,
} from "./proxy.ts";

describe("extractWellFromHost", () => {
  const base = "wells.cells.md";

  test("extracts a single-label well name", () => {
    expect(extractWellFromHost("pete.wells.cells.md", base)).toBe("pete");
  });

  test("strips a port from the Host header", () => {
    expect(extractWellFromHost("pete.wells.cells.md:443", base)).toBe("pete");
  });

  test("is case-insensitive", () => {
    expect(extractWellFromHost("Pete.WELLS.cells.md", base)).toBe("pete");
  });

  test("rejects multi-label prefixes (no smuggling via attacker.com)", () => {
    expect(
      extractWellFromHost("pete.attacker.com.wells.cells.md", base),
    ).toBeNull();
  });

  test("rejects bare base", () => {
    expect(extractWellFromHost("wells.cells.md", base)).toBeNull();
  });

  test("rejects unrelated domains", () => {
    expect(extractWellFromHost("pete.cells.md", base)).toBeNull();
    expect(extractWellFromHost("pete.example.com", base)).toBeNull();
  });

  test("rejects null host", () => {
    expect(extractWellFromHost(null, base)).toBeNull();
  });
});

describe("buildUpstreamWsInit", () => {
  function mkReq(headers: Record<string, string>): Request {
    return new Request("http://127.0.0.1:7878/agent", { headers });
  }

  test("forwards Authorization, Cookie, Origin, custom X-* headers", () => {
    const init = buildUpstreamWsInit(
      mkReq({
        authorization: "Bearer secret",
        cookie: "sid=abc",
        origin: "https://app.example.com",
        "x-trace-id": "t-123",
        "user-agent": "cells-talk/1.0",
      }),
    );
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(init.headers.cookie).toBe("sid=abc");
    expect(init.headers.origin).toBe("https://app.example.com");
    expect(init.headers["x-trace-id"]).toBe("t-123");
    expect(init.headers["user-agent"]).toBe("cells-talk/1.0");
  });

  test("strips Host so Bun can compute it from the upstream URL", () => {
    const init = buildUpstreamWsInit(
      mkReq({ host: "smoke-8.wells.cells.md", authorization: "Bearer x" }),
    );
    expect(init.headers.host).toBeUndefined();
    expect(init.headers.authorization).toBe("Bearer x");
  });

  test("strips WS control headers Bun manages itself", () => {
    const init = buildUpstreamWsInit(
      mkReq({
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "abc==",
        "sec-websocket-version": "13",
        "sec-websocket-extensions": "permessage-deflate",
        authorization: "Bearer x",
      }),
    );
    expect(init.headers.connection).toBeUndefined();
    expect(init.headers.upgrade).toBeUndefined();
    expect(init.headers["sec-websocket-key"]).toBeUndefined();
    expect(init.headers["sec-websocket-version"]).toBeUndefined();
    expect(init.headers["sec-websocket-extensions"]).toBeUndefined();
    expect(init.headers.authorization).toBe("Bearer x");
  });

  test("extracts Sec-WebSocket-Protocol into protocols and removes from headers", () => {
    const init = buildUpstreamWsInit(
      mkReq({ "sec-websocket-protocol": "graphql-ws, mqtt" }),
    );
    expect(init.protocols).toEqual(["graphql-ws", "mqtt"]);
    expect(init.headers["sec-websocket-protocol"]).toBeUndefined();
  });

  test("omits protocols when client didn't request any", () => {
    const init = buildUpstreamWsInit(mkReq({ authorization: "Bearer x" }));
    expect(init.protocols).toBeUndefined();
  });

  test("ignores empty Sec-WebSocket-Protocol values from sloppy clients", () => {
    const init = buildUpstreamWsInit(
      mkReq({ "sec-websocket-protocol": " , graphql-ws , " }),
    );
    expect(init.protocols).toEqual(["graphql-ws"]);
  });
});

// End-to-end check that Bun's client WebSocket actually honors the
// init shape we hand it. This is the load-bearing contract for the
// 1011-fix on the welld vhost proxy — if Bun ignores `headers`, the
// upstream cell still sees a naked handshake and the bug recurs.
describe("buildUpstreamWsInit + Bun WebSocket end-to-end", () => {
  test("Authorization + Cookie + custom headers reach the upstream WS", async () => {
    let captured: Record<string, string | null> = {};
    const upstream = Bun.serve({
      port: 0,
      async fetch(req, srv) {
        captured = {
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          "x-trace-id": req.headers.get("x-trace-id"),
          host: req.headers.get("host"),
        };
        const ok = srv.upgrade(req);
        if (ok) return undefined;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: { open() {}, message() {} },
    });
    try {
      const init = buildUpstreamWsInit(
        new Request("http://127.0.0.1:7878/agent", {
          headers: {
            authorization: "Bearer secret-xyz",
            cookie: "sid=abc",
            "x-trace-id": "trace-1",
            host: "smoke-8.wells.cells.md",
          },
        }),
      );
      const url = `ws://127.0.0.1:${upstream.port}/`;
      const out = new WebSocket(url, init);
      await new Promise<void>((resolve, reject) => {
        out.addEventListener("open", () => resolve(), { once: true });
        out.addEventListener("error", () =>
          reject(new Error("upstream WS errored before open")), { once: true });
        setTimeout(() => reject(new Error("upstream WS open timeout")), 2000);
      });
      out.close();
      expect(captured.authorization).toBe("Bearer secret-xyz");
      expect(captured.cookie).toBe("sid=abc");
      expect(captured["x-trace-id"]).toBe("trace-1");
      // Host should be the upstream's host:port, NOT the smuggled vhost name.
      expect(captured.host).toBe(`127.0.0.1:${upstream.port}`);
    } finally {
      upstream.stop(true);
    }
  });

  // Subprotocol forwarding is wired (extracted into init.protocols, passed
  // to Bun's WebSocket constructor), but a full negotiation round-trip via
  // Bun.serve's upgrade() didn't reliably bring the chosen protocol back to
  // the client in 1.3.4 — left untested here pending a real cells-side
  // need. The unit-test coverage of buildUpstreamWsInit confirms the input
  // half (we hand Bun the right shape).
});

describe("upstreamWsUrl", () => {
  const target: ProxyTarget = { ip: "192.168.64.21", auth: "well" };

  test("rewrites the request URL to ws://<well-ip>:8080/<path>", () => {
    const reqUrl = new URL("https://ck-pi-gpt55.cells.md/agent");
    expect(upstreamWsUrl(target, reqUrl)).toBe("ws://192.168.64.21:8080/agent");
  });

  test("preserves query string", () => {
    const reqUrl = new URL("https://ck-pi-gpt55.cells.md/agent?room=main&t=42");
    expect(upstreamWsUrl(target, reqUrl)).toBe(
      "ws://192.168.64.21:8080/agent?room=main&t=42",
    );
  });

  test("handles root path", () => {
    const reqUrl = new URL("https://ck-pi-gpt55.cells.md/");
    expect(upstreamWsUrl(target, reqUrl)).toBe("ws://192.168.64.21:8080/");
  });

  test("flips wss → ws (we proxy off-TLS on the bridge)", () => {
    const reqUrl = new URL("wss://ck-pi-gpt55.cells.md/agent");
    expect(upstreamWsUrl(target, reqUrl)).toBe("ws://192.168.64.21:8080/agent");
  });

  test("ignores the upstream-port-on-request (always forces 8080)", () => {
    // If a request somehow arrives with an explicit port, we override.
    const reqUrl = new URL("https://ck-pi-gpt55.cells.md:9999/agent");
    expect(upstreamWsUrl(target, reqUrl)).toBe("ws://192.168.64.21:8080/agent");
  });
});

describe("publicBase", () => {
  test("returns null when WELL_PUBLIC_BASE is unset", () => {
    const prev = process.env.WELL_PUBLIC_BASE;
    delete process.env.WELL_PUBLIC_BASE;
    expect(publicBase()).toBeNull();
    if (prev !== undefined) process.env.WELL_PUBLIC_BASE = prev;
  });

  test("trims whitespace and returns the value", () => {
    process.env.WELL_PUBLIC_BASE = "  wells.cells.md  ";
    expect(publicBase()).toBe("wells.cells.md");
    delete process.env.WELL_PUBLIC_BASE;
  });

  test("returns null on empty string", () => {
    process.env.WELL_PUBLIC_BASE = "";
    expect(publicBase()).toBeNull();
    delete process.env.WELL_PUBLIC_BASE;
  });
});
