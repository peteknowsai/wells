import { describe, expect, test } from "bun:test";
import { buildUpstreamWsInit, extractWellFromHost, publicBase } from "./proxy.ts";

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
