// Pure handler for POST /v1/wells/<name>/seal. Mirrors hibernation.ts
// shape: deps injection so welld.ts wires the real sealWell + the
// tests stub.
//
// Contract:
//
// - findWell returns null → 404 "not_found".
// - sealWell throws SealError code well_already_sealed → 409.
// - sealWell throws SealError code well_not_running → 409.
// - sealWell throws plain Error → 500 "seal_failed".
// - Returns 200 with { ok: true, name, sealed_at, elapsed_ms, ip }.

import { apiError } from "../apiResponse.ts";

export interface SealResultShape {
  sealed_at: string;
  elapsed_ms: number;
  ip: string;
}

export interface SealingDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  sealWell(name: string): Promise<SealResultShape>;
}

export async function handleSeal(
  name: string,
  deps: SealingDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    const result = await deps.sealWell(name);
    return new Response(
      JSON.stringify({
        ok: true,
        name,
        sealed_at: result.sealed_at,
        elapsed_ms: result.elapsed_ms,
        ip: result.ip,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.code === "well_already_sealed") {
      return apiError(409, "well_already_sealed", err.message);
    }
    if (err.code === "well_not_running") {
      return apiError(409, "well_not_running", err.message);
    }
    return apiError(500, "seal_failed", err.message);
  }
}
