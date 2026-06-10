import { describe, expect, test } from "bun:test";
import {
  handlePutService,
  handleDeleteService,
  handleGetService,
  handleListServices,
  handleApplyServices,
  type PutServiceDeps,
  type DeleteServiceDeps,
  type GetServiceDeps,
  type ListServicesDeps,
  type ApplyServicesDeps,
} from "./service.ts";

function jsonReq(body: unknown): Request {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-length": String(s.length) },
    body: s,
  });
}

function validServiceDef(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cmd: "bash",
    args: ["-lc", "echo hi"],
    workdir: "/home/well",
    ...over,
  };
}

function validServiceResource(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "svc1",
    well: "pete",
    definition: validServiceDef(),
    created_at: "2026-05-12T00:00:00Z",
    ...over,
  };
}

// ──────────────────────────── Put ────────────────────────────

function makePutDeps(over: Partial<PutServiceDeps> = {}): PutServiceDeps {
  return {
    findWell: async (n) => ({ name: n }),
    ensureRunning: async () => {},
    putService: async () => validServiceResource(),
    ...over,
  };
}

describe("handlePutService", () => {
  test("404 when well not found", async () => {
    const deps = makePutDeps({ findWell: async () => null });
    const res = await handlePutService(
      "ghost",
      "svc1",
      jsonReq(validServiceDef()),
      deps,
    );
    expect(res.status).toBe(404);
  });

  test("504 wake_failed when ensureRunning throws", async () => {
    const deps = makePutDeps({
      ensureRunning: async () => {
        throw new Error("wake timed out");
      },
    });
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq(validServiceDef()),
      deps,
    );
    expect(res.status).toBe(504);
  });

  test("400 bad_json", async () => {
    const deps = makePutDeps();
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq("not-json{"),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_json");
  });

  test("400 bad_request on schema fail", async () => {
    const deps = makePutDeps();
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq({}),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("'invalid' error → 400 service_apply_failed (message-based routing)", async () => {
    const deps = makePutDeps({
      putService: async () => {
        throw new Error("invalid cmd: shell quoting broken");
      },
    });
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq(validServiceDef()),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service_apply_failed");
  });

  test("other error → 500 service_apply_failed", async () => {
    const deps = makePutDeps({
      putService: async () => {
        throw new Error("ssh handshake failed");
      },
    });
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq(validServiceDef()),
      deps,
    );
    expect(res.status).toBe(500);
  });

  test("success: 200 with resource", async () => {
    const deps = makePutDeps();
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq(validServiceDef()),
      deps,
    );
    expect(res.status).toBe(200);
  });

  test("500 when putService returns bad shape", async () => {
    const deps = makePutDeps({
      putService: async () => ({ id: "wrong-shape" }),
    });
    const res = await handlePutService(
      "pete",
      "svc1",
      jsonReq(validServiceDef()),
      deps,
    );
    expect(res.status).toBe(500);
  });
});

// ──────────────────────────── Delete ────────────────────────────

function makeDeleteDeps(over: Partial<DeleteServiceDeps> = {}): DeleteServiceDeps {
  return {
    findWell: async (n) => ({ name: n }),
    ensureRunning: async () => {},
    deleteService: async () => true,
    ...over,
  };
}

describe("handleDeleteService", () => {
  test("404 when well not found", async () => {
    const deps = makeDeleteDeps({ findWell: async () => null });
    const res = await handleDeleteService("ghost", "svc1", deps);
    expect(res.status).toBe(404);
  });

  test("504 wake_failed", async () => {
    const deps = makeDeleteDeps({
      ensureRunning: async () => {
        throw new Error("wake timed out");
      },
    });
    const res = await handleDeleteService("pete", "svc1", deps);
    expect(res.status).toBe(504);
  });

  test("500 on deleteService throw", async () => {
    const deps = makeDeleteDeps({
      deleteService: async () => {
        throw new Error("systemctl failed");
      },
    });
    const res = await handleDeleteService("pete", "svc1", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service_delete_failed");
  });

  test("success found=true", async () => {
    const deps = makeDeleteDeps({ deleteService: async () => true });
    const res = await handleDeleteService("pete", "svc1", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; well: string; found: boolean };
    expect(body.id).toBe("svc1");
    expect(body.well).toBe("pete");
    expect(body.found).toBe(true);
  });

  test("success found=false (idempotent miss)", async () => {
    const deps = makeDeleteDeps({ deleteService: async () => false });
    const res = await handleDeleteService("pete", "ghost", deps);
    const body = await res.json() as { found: boolean };
    expect(body.found).toBe(false);
  });
});

// ──────────────────────────── Get ────────────────────────────

describe("handleGetService", () => {
  test("404 when well not found", async () => {
    const deps: GetServiceDeps = {
      findWell: async () => null,
      getService: async () => null,
    };
    const res = await handleGetService("ghost", "svc1", deps);
    expect(res.status).toBe(404);
  });

  test("404 when service not found", async () => {
    const deps: GetServiceDeps = {
      findWell: async (n) => ({ name: n }),
      getService: async () => null,
    };
    const res = await handleGetService("pete", "missing", deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("missing");
  });

  test("400 bad_request on getService throw", async () => {
    const deps: GetServiceDeps = {
      findWell: async (n) => ({ name: n }),
      getService: async () => {
        throw new Error("invalid service id");
      },
    };
    const res = await handleGetService("pete", "bad!id", deps);
    expect(res.status).toBe(400);
  });

  test("success: 200 with resource", async () => {
    const deps: GetServiceDeps = {
      findWell: async (n) => ({ name: n }),
      getService: async () => validServiceResource(),
    };
    const res = await handleGetService("pete", "svc1", deps);
    expect(res.status).toBe(200);
  });

  test("500 on bad shape", async () => {
    const deps: GetServiceDeps = {
      findWell: async (n) => ({ name: n }),
      getService: async () => ({ wrong: "shape" }),
    };
    const res = await handleGetService("pete", "svc1", deps);
    expect(res.status).toBe(500);
  });
});

// ──────────────────────────── List ────────────────────────────

describe("handleListServices", () => {
  test("404 when well not found", async () => {
    const deps: ListServicesDeps = {
      findWell: async () => null,
      listServices: async () => [],
    };
    const res = await handleListServices("ghost", deps);
    expect(res.status).toBe(404);
  });

  test("empty list → 200", async () => {
    const deps: ListServicesDeps = {
      findWell: async (n) => ({ name: n }),
      listServices: async () => [],
    };
    const res = await handleListServices("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { services: unknown[] };
    expect(body.services).toEqual([]);
  });

  test("non-empty list passes through", async () => {
    const deps: ListServicesDeps = {
      findWell: async (n) => ({ name: n }),
      listServices: async () => [
        validServiceResource({ id: "a" }),
        validServiceResource({ id: "b" }),
      ],
    };
    const res = await handleListServices("pete", deps);
    const body = await res.json() as { services: Array<{ id: string }> };
    expect(body.services.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

// ──────────────────────────── Apply ────────────────────────────

describe("handleApplyServices", () => {
  test("404 when well not found", async () => {
    const deps: ApplyServicesDeps = {
      findWell: async () => null,
      ensureRunning: async () => ({}),
      applyPersistedServices: async () => ({ applied: [], failed: [] }),
    };
    const res = await handleApplyServices("ghost", deps);
    expect(res.status).toBe(404);
  });

  test("504 wake_failed when ensureRunning throws", async () => {
    const deps: ApplyServicesDeps = {
      findWell: async (n) => ({ name: n }),
      ensureRunning: async () => {
        throw new Error("wake timeout after 10000ms");
      },
      applyPersistedServices: async () => ({ applied: [], failed: [] }),
    };
    const res = await handleApplyServices("pete", deps);
    expect(res.status).toBe(504);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("wake_failed");
  });

  test("500 service_apply_failed when apply itself throws", async () => {
    const deps: ApplyServicesDeps = {
      findWell: async (n) => ({ name: n }),
      ensureRunning: async () => ({}),
      applyPersistedServices: async () => {
        throw new Error("services dir unreadable");
      },
    };
    const res = await handleApplyServices("pete", deps);
    expect(res.status).toBe(500);
  });

  test("200 with per-service status, partial failure included", async () => {
    const deps: ApplyServicesDeps = {
      findWell: async (n) => ({ name: n }),
      ensureRunning: async () => ({}),
      applyPersistedServices: async (well) => ({
        applied: ["site"],
        failed: [{ id: "agent", error: `ssh apply failed on ${well}` }],
      }),
    };
    const res = await handleApplyServices("mother", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      well: string;
      applied: string[];
      failed: Array<{ id: string; error: string }>;
    };
    expect(body.well).toBe("mother");
    expect(body.applied).toEqual(["site"]);
    expect(body.failed).toEqual([
      { id: "agent", error: "ssh apply failed on mother" },
    ]);
  });

  test("200 empty result when no defs persisted", async () => {
    const deps: ApplyServicesDeps = {
      findWell: async (n) => ({ name: n }),
      ensureRunning: async () => ({}),
      applyPersistedServices: async () => ({ applied: [], failed: [] }),
    };
    const res = await handleApplyServices("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: string[]; failed: unknown[] };
    expect(body.applied).toEqual([]);
    expect(body.failed).toEqual([]);
  });
});
