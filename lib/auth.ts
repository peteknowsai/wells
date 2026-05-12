// Bearer-token auth for welld's HTTP API + WebSocket upgrades.
//
// Two delivery paths:
//   1. `Authorization: Bearer <token>` header (the canonical sprites
//      shape; what cells's apiClient + CLI both use).
//   2. `?token=<token>` query string (the WS upgrade fallback —
//      browsers can't set custom headers on WebSocket handshakes).
//
// Both are accepted; sprites does the same. The comparison uses
// `timingSafeEqual` from node:crypto to defeat timing-based oracle
// attacks. Length-mismatched candidates are rejected before any byte
// comparison (timingSafeEqual throws on length mismatch).

import { timingSafeEqual } from "./timingSafe.ts";

const BEARER_RE = /^bearer\s+(\S+)\s*$/i;

export function isAuthorized(
  req: Request,
  token: string,
  urlForQuery?: URL,
): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = BEARER_RE.exec(header);
  if (m && timingSafeEqual(m[1]!, token)) return true;
  const q = urlForQuery?.searchParams.get("token");
  if (q && timingSafeEqual(q, token)) return true;
  return false;
}
