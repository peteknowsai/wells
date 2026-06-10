import { describe, expect, test } from "bun:test";
import {
  handleNetworkPolicy,
  handleGetNetworkPolicy,
  handlePatchWell,
  handleUpdateUrl,
  type SetNetworkPolicyDeps,
  type GetNetworkPolicyDeps,
  type PatchWellDeps,
  type UpdateUrlDeps,
} from "./wellMeta.ts";

function jsonReq(body: unknown): Request {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-length": String(s.length) },
    body: s,
  });
}

// ──────────────────────────── Network policy: POST ────────────────────────────

describe("handleNetworkPolicy", () => {
  test("404 when well not found", async () => {
    const deps: SetNetworkPolicyDeps = {
      findWell: async () => null,
      writePolicy: async () => {},
    };
    const res = await handleNetworkPolicy(
      "ghost",
      jsonReq({ rules: [] }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  test("400 bad_json on malformed body", async () => {
    const deps: SetNetworkPolicyDeps = {
      findWell: async (n) => ({ name: n }),
      writePolicy: async () => {},
    };
    const res = await handleNetworkPolicy(
      "pete",
      jsonReq("not-json{"),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_json");
  });

  test("400 bad_request on schema fail", async () => {
    const deps: SetNetworkPolicyDeps = {
      findWell: async (n) => ({ name: n }),
      writePolicy: async () => {},
    };
    const res = await handleNetworkPolicy("pete", jsonReq({}), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("success: writePolicy called, response says accepted=true enforced=false", async () => {
    let wrote: { name: string; rules: unknown[] } | undefined;
    const deps: SetNetworkPolicyDeps = {
      findWell: async (n) => ({ name: n }),
      writePolicy: async (name, rules) => {
        wrote = { name, rules };
      },
    };
    const res = await handleNetworkPolicy(
      "pete",
      jsonReq({ rules: [{ action: "allow", domain: "api.example" }] }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(wrote?.name).toBe("pete");
    expect(wrote?.rules).toHaveLength(1);
    const body = await res.json() as { accepted: boolean; enforced: boolean };
    expect(body.accepted).toBe(true);
    expect(body.enforced).toBe(false);
  });
});

// ──────────────────────────── Network policy: GET ────────────────────────────

describe("handleGetNetworkPolicy", () => {
  test("404 when well not found", async () => {
    const deps: GetNetworkPolicyDeps = {
      findWell: async () => null,
      readPolicy: async () => null,
    };
    const res = await handleGetNetworkPolicy("ghost", deps);
    expect(res.status).toBe(404);
  });

  test("readPolicy null → empty rules, 200", async () => {
    const deps: GetNetworkPolicyDeps = {
      findWell: async (n) => ({ name: n }),
      readPolicy: async () => null,
    };
    const res = await handleGetNetworkPolicy("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { rules: unknown[] };
    expect(body.rules).toEqual([]);
  });

  test("readPolicy returns rules → 200 with those rules", async () => {
    const rules = [{ action: "allow" as const, domain: "api.example" }];
    const deps: GetNetworkPolicyDeps = {
      findWell: async (n) => ({ name: n }),
      readPolicy: async () => rules,
    };
    const res = await handleGetNetworkPolicy("pete", deps);
    const body = await res.json() as { rules: typeof rules };
    expect(body.rules).toEqual(rules);
  });
});

// ──────────────────────────── Patch ────────────────────────────

function makePatchDeps(over: Partial<PatchWellDeps> = {}): PatchWellDeps {
  return {
    findWell: async (n) => ({ name: n }),
    updateWellAutoSleep: async (n) => ({ name: n }),
    buildWellResource: async (n) => ({ name: n, status: "running" }),
    wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    ...over,
  };
}

describe("handlePatchWell", () => {
  test("400 bad_json on malformed body", async () => {
    const deps = makePatchDeps();
    const res = await handlePatchWell("pete", jsonReq("not-json{"), deps);
    expect(res.status).toBe(400);
  });

  test("auto_sleep_seconds flows into updateWellAutoSleep", async () => {
    let captured: number | null | undefined;
    const deps = makePatchDeps({
      updateWellAutoSleep: async (n, v) => {
        captured = v;
        return { name: n };
      },
    });
    const res = await handlePatchWell(
      "pete",
      jsonReq({ auto_sleep_seconds: 30 }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(captured).toBe(30);
  });

  test("updateWellAutoSleep returns falsy → 404", async () => {
    const deps = makePatchDeps({ updateWellAutoSleep: async () => undefined });
    const res = await handlePatchWell(
      "ghost",
      jsonReq({ auto_sleep_seconds: 30 }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  test("auto_sleep_seconds=null is valid (never-sleep)", async () => {
    let captured: number | null | undefined;
    const deps = makePatchDeps({
      updateWellAutoSleep: async (n, v) => {
        captured = v;
        return { name: n };
      },
    });
    await handlePatchWell(
      "pete",
      jsonReq({ auto_sleep_seconds: null }),
      deps,
    );
    expect(captured).toBeNull();
  });

  test("empty body → still 404 if well missing (symmetry)", async () => {
    const deps = makePatchDeps({ findWell: async () => null });
    const res = await handlePatchWell("ghost", jsonReq({}), deps);
    expect(res.status).toBe(404);
  });

  test("empty body + existing well → 200 with resource", async () => {
    const deps = makePatchDeps();
    const res = await handlePatchWell("pete", jsonReq({}), deps);
    expect(res.status).toBe(200);
  });

  test("memory flows into resizeWellMemory, 200 on resized", async () => {
    let captured: string | undefined;
    const deps = makePatchDeps({
      resizeWellMemory: async (_n, spec) => {
        captured = spec;
        return { kind: "resized", memory: "2GB", memory_bytes: 2147483648 };
      },
    });
    const res = await handlePatchWell("mother", jsonReq({ memory: "2GB" }), deps);
    expect(res.status).toBe(200);
    expect(captured).toBe("2GB");
  });

  test("memory refusal maps to 409 with the refusal code", async () => {
    const deps = makePatchDeps({
      resizeWellMemory: async () => ({
        kind: "refused",
        code: "well_not_stopped",
        message: "stop it first",
      }),
    });
    const res = await handlePatchWell("mother", jsonReq({ memory: "2GB" }), deps);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("well_not_stopped");
    expect(body.message).toContain("stop it first");
  });

  test("memory not_found → 404", async () => {
    const deps = makePatchDeps({
      resizeWellMemory: async () => ({ kind: "not_found" }),
    });
    const res = await handlePatchWell("ghost", jsonReq({ memory: "2GB" }), deps);
    expect(res.status).toBe(404);
  });

  test("invalid memory spec (resize throws) → 400", async () => {
    const deps = makePatchDeps({
      resizeWellMemory: async () => {
        throw new Error("invalid size 'lots': expected like '4GB' or '512MB'");
      },
    });
    const res = await handlePatchWell("mother", jsonReq({ memory: "lots" }), deps);
    expect(res.status).toBe(400);
  });

  test("memory PATCH without the dep wired → 501", async () => {
    const deps = makePatchDeps();
    delete (deps as { resizeWellMemory?: unknown }).resizeWellMemory;
    const res = await handlePatchWell("mother", jsonReq({ memory: "2GB" }), deps);
    expect(res.status).toBe(501);
  });

  test("memory + auto_sleep in one PATCH both apply", async () => {
    let resized = false;
    let slept: number | null | undefined;
    const deps = makePatchDeps({
      resizeWellMemory: async () => {
        resized = true;
        return { kind: "resized", memory: "2GB", memory_bytes: 2147483648 };
      },
      updateWellAutoSleep: async (n, v) => {
        slept = v;
        return { name: n };
      },
    });
    const res = await handlePatchWell(
      "mother",
      jsonReq({ memory: "2GB", auto_sleep_seconds: 120 }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(resized).toBe(true);
    expect(slept).toBe(120);
  });

  test("vanished post-patch → 500", async () => {
    const deps = makePatchDeps({ buildWellResource: async () => null });
    const res = await handlePatchWell(
      "pete",
      jsonReq({ auto_sleep_seconds: 30 }),
      deps,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("vanished");
  });
});

// ──────────────────────────── Update URL ────────────────────────────

describe("handleUpdateUrl", () => {
  test("400 bad_json on malformed body", async () => {
    const deps: UpdateUrlDeps = {
      updateWellAuth: async (n) => ({ name: n }),
      buildWellResource: async (n) => ({ name: n }),
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    const res = await handleUpdateUrl("pete", jsonReq("not-json{"), deps);
    expect(res.status).toBe(400);
  });

  test("400 bad_request when auth is not a valid mode", async () => {
    const deps: UpdateUrlDeps = {
      updateWellAuth: async (n) => ({ name: n }),
      buildWellResource: async (n) => ({ name: n }),
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    const res = await handleUpdateUrl(
      "pete",
      jsonReq({ auth: "garbage" }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("404 when updateWellAuth returns undefined", async () => {
    const deps: UpdateUrlDeps = {
      updateWellAuth: async () => undefined,
      buildWellResource: async (n) => ({ name: n }),
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    const res = await handleUpdateUrl(
      "ghost",
      jsonReq({ auth: "public" }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  test("auth flows into updateWellAuth", async () => {
    let captured: string | undefined;
    const deps: UpdateUrlDeps = {
      updateWellAuth: async (n, auth) => {
        captured = auth;
        return { name: n };
      },
      buildWellResource: async (n) => ({ name: n, status: "running" }),
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    const res = await handleUpdateUrl(
      "pete",
      jsonReq({ auth: "public" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(captured).toBe("public");
  });

  test("vanished post-update → 500", async () => {
    const deps: UpdateUrlDeps = {
      updateWellAuth: async (n) => ({ name: n }),
      buildWellResource: async () => null,
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    const res = await handleUpdateUrl(
      "pete",
      jsonReq({ auth: "well" }),
      deps,
    );
    expect(res.status).toBe(500);
  });
});
