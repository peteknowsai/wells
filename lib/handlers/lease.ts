// Pure handlers for the lease endpoints.
//
// - releaseLease (POST .../leases/<hostname>/release): single-hostname,
//   maps four helper outcomes (ok / invalid-arg / not-installed / exit)
//   to four error envelopes (200 / 400 / 503 / 500).
// - flushLeases (POST .../leases/flush): orphan-only flush. W.67 — never
//   nuke a lease whose name welld still considers alive. Aborts early
//   if the helper isn't installed (no point continuing).

import { apiError } from "../apiResponse.ts";

export interface HelperResult {
  ok: boolean;
  reason?: "not-installed" | "invalid-arg" | "exec-failed" | "exit-nonzero";
  exitCode?: number;
  stderr?: string;
}

export interface OrphanLeaseView {
  name: string | null;
}

export interface ReleaseLeaseDeps {
  releaseLease(hostname: string): Promise<HelperResult>;
}

export async function handleReleaseLease(
  hostname: string,
  deps: ReleaseLeaseDeps,
): Promise<Response> {
  const r = await deps.releaseLease(hostname);
  if (r.ok) return Response.json({ ok: true, released: hostname });
  if (r.reason === "invalid-arg") {
    return apiError(
      400,
      "bad_request",
      `hostname '${hostname}' has invalid shape (must match well-name regex)`,
    );
  }
  if (r.reason === "not-installed") {
    return apiError(
      503,
      "helper_not_installed",
      "dhcp-helper not installed — run scripts/install-dhcp-helper.sh",
    );
  }
  return apiError(
    500,
    "helper_failed",
    `dhcp-helper exit=${r.exitCode ?? "?"} stderr=${(r.stderr ?? "").slice(0, 200)}`,
  );
}

export interface FlushLeasesDeps {
  computeOrphanLeases(): Promise<OrphanLeaseView[]>;
  releaseLease(hostname: string): Promise<HelperResult>;
}

export async function handleFlushLeases(
  deps: FlushLeasesDeps,
): Promise<Response> {
  const orphans = await deps.computeOrphanLeases();
  const released: string[] = [];
  const failed: Array<{ name: string; reason: string; code?: number }> = [];
  for (const o of orphans) {
    if (o.name === null) continue;
    const r = await deps.releaseLease(o.name);
    if (r.ok) {
      released.push(o.name);
      continue;
    }
    if (r.reason === "not-installed") {
      return apiError(
        503,
        "helper_not_installed",
        "dhcp-helper not installed — run scripts/install-dhcp-helper.sh",
      );
    }
    failed.push({
      name: o.name,
      reason: r.reason ?? "unknown",
      code: r.exitCode,
    });
  }
  return Response.json({
    ok: true,
    released,
    released_count: released.length,
    failed,
    orphan_count: orphans.length,
  });
}
