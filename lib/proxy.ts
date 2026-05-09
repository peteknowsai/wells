// Reverse proxy for `<name>.wells.cells.md` → guest:8080. The cloudflared
// tunnel terminates TLS and dials this proxy over plain HTTP/WS at 127.0.0.1.
//
// The `<name>` is a single label between the start of the Host header and
// the publicBase suffix (set via `WELL_PUBLIC_BASE`, e.g. "wells.cells.md").
// We don't currently support per-service ports — all proxy traffic targets
// guest:8080 (the sprites convention; cells's site server runs there).

import { readDhcpLease } from "./dhcp.ts";
import { findWell } from "./registry.ts";

export const GUEST_PORT = 8080;

export function publicBase(): string | null {
  const v = process.env.WELL_PUBLIC_BASE?.trim();
  return v && v.length > 0 ? v : null;
}

// "pete.wells.cells.md" + "wells.cells.md" → "pete". Returns null on
// any mismatch (different domain, multi-label prefix, empty prefix).
// Multi-label is rejected so a hostile/foreign Host header can't smuggle
// through (e.g. "pete.attacker.com.wells.cells.md").
export function extractWellFromHost(
  host: string | null,
  base: string,
): string | null {
  if (!host) return null;
  const hostNoPort = host.split(":")[0]!.toLowerCase();
  const suffix = "." + base.toLowerCase();
  if (!hostNoPort.endsWith(suffix)) return null;
  const name = hostNoPort.slice(0, hostNoPort.length - suffix.length);
  if (name.length === 0 || name.includes(".")) return null;
  return name;
}

export interface ProxyTarget {
  well: string;
  ip: string;
  // "well" = require Bearer WELL_TOKEN at the proxy. "public" = no
  // proxy-side auth (the well's own app handles whatever it cares
  // about).
  auth: "public" | "well";
}

export async function resolveProxyTarget(well: string): Promise<ProxyTarget | null> {
  const record = await findWell(well);
  if (!record) return null;
  const ip = await readDhcpLease(well);
  if (!ip) return null;
  return { well, ip, auth: record.auth };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// Forward a plain HTTP request to guest:8080. Returns a 502 if the upstream
// is unreachable (well stopped, no app listening, etc).
export async function proxyHttp(req: Request, target: ProxyTarget): Promise<Response> {
  const upstream = new URL(req.url);
  upstream.protocol = "http:";
  upstream.hostname = target.ip;
  upstream.port = String(GUEST_PORT);

  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
  };
  if (hasBody) init.duplex = "half";

  try {
    return await fetch(upstream.toString(), init);
  } catch (e) {
    return new Response(`bad gateway: ${(e as Error).message}\n`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
}

export function upstreamWsUrl(target: ProxyTarget, reqUrl: URL): string {
  const u = new URL(reqUrl.toString());
  u.protocol = "ws:";
  u.hostname = target.ip;
  u.port = String(GUEST_PORT);
  return u.toString();
}
