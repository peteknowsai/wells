#!/usr/bin/env bun
// Smoke for the cells-team-blocking 1011 bug fix.
//
// Stands up two real Bun servers and drives a real WebSocket through them,
// mirroring the welld vhost-dispatch path:
//
//   client (this script)
//     → "welld-like" proxy on 127.0.0.1:<a>  (vhost dispatch + bridge)
//       → "fake cell"   on 127.0.0.1:<b>     (/agent + bearer check)
//
// The proxy uses lib/proxy.ts's buildUpstreamWsInit + the same bridge code
// that lives in daemon/welld.ts (copied inline here so the smoke doesn't
// need a full welld instance + DHCP lease + registered well + alive cell).
//
// Verifies the four observable failures the cells team would have hit:
//   1. Authorization arrives at the cell (the load-bearing fix).
//   2. Custom X-* headers propagate.
//   3. Frames flow client→cell and cell→client.
//   4. Close is clean (1000), NOT the 1011 the cells team saw.
//
// Usage:
//   bun run scripts/smoke-vhost-ws-proxy.ts
//
// Exit 0 on pass, 1 on any failure. Prints a per-check summary.

import {
  buildUpstreamWsInit,
  type UpstreamWsInit,
  upstreamWsUrl,
} from "../lib/proxy.ts";

const SECRET = "smoke-bearer-token-do-not-reuse";
const VHOST = "smoke-cell.wells.cells.md";
const PUBLIC_BASE = "wells.cells.md";

interface CellState {
  upgradeAuth: string | null;
  upgradeXTrace: string | null;
  upgradeHost: string | null;
  framesIn: string[];
  closeCode: number | null;
}

function startFakeCell(): { server: ReturnType<typeof Bun.serve>; state: CellState } {
  const state: CellState = {
    upgradeAuth: null,
    upgradeXTrace: null,
    upgradeHost: null,
    framesIn: [],
    closeCode: null,
  };
  const server = Bun.serve<{}>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/agent") {
        return new Response("not found", { status: 404 });
      }
      state.upgradeAuth = req.headers.get("authorization");
      state.upgradeXTrace = req.headers.get("x-trace-id");
      state.upgradeHost = req.headers.get("host");
      // Bearer check — matches the cells team's site server pattern.
      const m = /^bearer\s+(\S+)$/i.exec(state.upgradeAuth ?? "");
      if (!m || m[1] !== SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const ok = srv.upgrade(req, { data: {} });
      return ok ? undefined : new Response("ws upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send("hello-from-cell");
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        state.framesIn.push(text);
        ws.send(`echo:${text}`);
      },
      close(_ws, code) {
        state.closeCode = code;
      },
    },
  });
  return { server, state };
}

interface ProxySession {
  upstreamUrl: string;
  upstreamInit: UpstreamWsInit;
  upstream: WebSocket | null;
  queue: (string | Buffer)[];
}

// Mirrors daemon/welld.ts vhost dispatch + bridge code. Pinned to a single
// upstream IP so we don't need DHCP or a registered well.
function startProxy(upstreamHost: string, upstreamPort: number): ReturnType<typeof Bun.serve> {
  return Bun.serve<ProxySession>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? "";
      const expectedSuffix = "." + PUBLIC_BASE;
      if (!host.split(":")[0]!.toLowerCase().endsWith(expectedSuffix)) {
        return new Response("vhost mismatch", { status: 400 });
      }
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("not a ws upgrade", { status: 400 });
      }
      const upstreamUrl = upstreamWsUrl(
        { well: "smoke", ip: upstreamHost, auth: "public" },
        url,
      );
      // Override the port to the fake cell's port (upstreamWsUrl forces
      // GUEST_PORT=8080; the smoke binds on a random free port).
      const overridden = new URL(upstreamUrl);
      overridden.port = String(upstreamPort);
      const ok = srv.upgrade(req, {
        data: {
          upstreamUrl: overridden.toString(),
          upstreamInit: buildUpstreamWsInit(req),
          upstream: null,
          queue: [],
        } satisfies ProxySession,
      });
      return ok ? undefined : new Response("ws upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        const d = ws.data;
        const out = new WebSocket(d.upstreamUrl, d.upstreamInit);
        out.binaryType = "arraybuffer";
        out.onopen = () => {
          d.upstream = out;
          for (const f of d.queue) out.send(f);
          d.queue = [];
        };
        out.onmessage = (ev) => {
          try {
            ws.send(ev.data as string | ArrayBuffer | Buffer);
          } catch {}
        };
        out.onclose = (ev) => ws.close(ev.code, ev.reason);
        out.onerror = () => ws.close(1011);
      },
      message(ws, raw) {
        const d = ws.data;
        if (d.upstream && d.upstream.readyState === WebSocket.OPEN) {
          d.upstream.send(raw as string | ArrayBuffer | Buffer);
        } else {
          d.queue.push(raw as string | Buffer);
        }
      },
      close(ws) {
        const d = ws.data;
        try { d.upstream?.close(); } catch {}
      },
    },
  });
}

async function waitOpen(ws: WebSocket, ms = 3000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("client open timeout")), ms);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("client errored before open")); }, { once: true });
  });
}

async function main(): Promise<void> {
  const { server: cell, state } = startFakeCell();
  const proxy = startProxy("127.0.0.1", cell.port);
  console.log(`fake cell  : ws://127.0.0.1:${cell.port}/agent`);
  console.log(`proxy      : ws://127.0.0.1:${proxy.port}/agent  (Host: ${VHOST})`);

  let clientCloseCode: number | null = null;
  const fromCell: string[] = [];

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/agent`, {
      headers: {
        host: VHOST,
        authorization: `Bearer ${SECRET}`,
        "x-trace-id": "smoke-trace-99",
      },
    });
    ws.addEventListener("message", (ev) => {
      fromCell.push(typeof ev.data === "string" ? ev.data : "<binary>");
    });
    ws.addEventListener("close", (ev) => {
      clientCloseCode = ev.code;
    });

    await waitOpen(ws);
    // Wait for the cell→client "hello-from-cell" frame to arrive.
    await new Promise((r) => setTimeout(r, 100));
    ws.send("ping-1");
    await new Promise((r) => setTimeout(r, 100));
    ws.send("ping-2");
    await new Promise((r) => setTimeout(r, 100));
    ws.close(1000, "smoke-done");
    // Settle close on both ends.
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    cell.stop(true);
    proxy.stop(true);
  }

  // Assertions.
  const checks: Array<[string, boolean, string]> = [
    ["Authorization reached cell",
      state.upgradeAuth === `Bearer ${SECRET}`,
      `got: ${state.upgradeAuth}`],
    ["X-Trace-Id reached cell",
      state.upgradeXTrace === "smoke-trace-99",
      `got: ${state.upgradeXTrace}`],
    ["Host on upstream is the cell, not the smuggled vhost",
      state.upgradeHost === `127.0.0.1:${(state.upgradeHost ?? "").split(":")[1] ?? ""}`
        && !(state.upgradeHost ?? "").includes("wells.cells.md"),
      `got: ${state.upgradeHost}`],
    ["Cell→client frame arrived",
      fromCell.includes("hello-from-cell"),
      `got: ${JSON.stringify(fromCell)}`],
    ["Client→cell frames arrived (ping-1, ping-2)",
      state.framesIn.includes("ping-1") && state.framesIn.includes("ping-2"),
      `got: ${JSON.stringify(state.framesIn)}`],
    ["Echo round-trip frames came back",
      fromCell.includes("echo:ping-1") && fromCell.includes("echo:ping-2"),
      `got: ${JSON.stringify(fromCell)}`],
    ["Client close was 1000, NOT 1011",
      clientCloseCode === 1000,
      `got: ${clientCloseCode}`],
  ];

  console.log("\nresults:");
  let failed = false;
  for (const [label, ok, detail] of checks) {
    console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${ok ? "" : " — " + detail}`);
    if (!ok) failed = true;
  }
  if (failed) {
    console.error("\nSMOKE FAILED");
    process.exit(1);
  }
  console.log("\nSMOKE PASSED — vhost-dispatch WS proxy delivers headers + frames cleanly.");
}

await main();
