import { describe, expect, test } from "bun:test";
import {
  handleCreateCheckpoint,
  handleListCheckpoints,
  handleExpireCheckpoint,
  handleRestoreCheckpoint,
  type CreateCheckpointDeps,
  type ListCheckpointsDeps,
  type ExpireCheckpointDeps,
  type RestoreCheckpointDeps,
} from "./checkpoint.ts";

function validCheckpoint(over: Record<string, unknown> = {}): { id: string } & Record<string, unknown> {
  return {
    id: "cp-001",
    created_at: "2026-05-12T00:00:00Z",
    size_bytes: 1024,
    physical_bytes: 512,
    ...over,
  };
}

function jsonReq(body: unknown | null = null): Request {
  if (body === null) {
    return new Request("http://localhost/", { method: "POST" });
  }
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-length": String(s.length) },
    body: s,
  });
}

// ──────────────────────────── Create ────────────────────────────

function makeCreateDeps(over: Partial<CreateCheckpointDeps> = {}): CreateCheckpointDeps {
  return {
    findWell: async (n) => ({ name: n }),
    ensureRunning: async () => {},
    createCheckpoint: async () => ({ id: "cp-001" }),
    listCheckpoints: async () => [validCheckpoint()],
    parseDuration: (s) => (s === "7d" ? 604800 : undefined),
    ...over,
  };
}

describe("handleCreateCheckpoint", () => {
  test("404 when well not found", async () => {
    const deps = makeCreateDeps({ findWell: async () => null });
    const res = await handleCreateCheckpoint("ghost", jsonReq(), deps);
    expect(res.status).toBe(404);
  });

  test("504 wake_failed when ensureRunning throws", async () => {
    const deps = makeCreateDeps({
      ensureRunning: async () => {
        throw new Error("wake timed out");
      },
    });
    const res = await handleCreateCheckpoint("pete", jsonReq(), deps);
    expect(res.status).toBe(504);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("wake_failed");
  });

  test("400 bad_request on invalid retain_for", async () => {
    const deps = makeCreateDeps({ parseDuration: () => undefined });
    const res = await handleCreateCheckpoint(
      "pete",
      jsonReq({ retain_for: "garbage" }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("garbage");
  });

  test("comment + retain_for flow into createCheckpoint", async () => {
    let opts: { comment?: string; retainForSeconds?: number } | undefined;
    const deps = makeCreateDeps({
      createCheckpoint: async (_n, o) => {
        opts = o;
        return { id: "cp-001" };
      },
    });
    await handleCreateCheckpoint(
      "pete",
      jsonReq({ comment: "before-deploy", retain_for: "7d" }),
      deps,
    );
    expect(opts?.comment).toBe("before-deploy");
    expect(opts?.retainForSeconds).toBe(604800);
  });

  test("createCheckpoint throws → 500 checkpoint_failed", async () => {
    const deps = makeCreateDeps({
      createCheckpoint: async () => {
        throw new Error("disk full");
      },
    });
    const res = await handleCreateCheckpoint("pete", jsonReq(), deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("checkpoint_failed");
  });

  test("missing from list → 500 checkpoint_vanished", async () => {
    const deps = makeCreateDeps({
      createCheckpoint: async () => ({ id: "cp-999" }),
      listCheckpoints: async () => [validCheckpoint({ id: "cp-001" })],
    });
    const res = await handleCreateCheckpoint("pete", jsonReq(), deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("checkpoint_vanished");
  });

  test("empty body OK (most callers don't send one)", async () => {
    const deps = makeCreateDeps();
    const res = await handleCreateCheckpoint("pete", jsonReq(), deps);
    expect(res.status).toBe(201);
  });

  test("unparseable body → silently treated as empty (sprites lenient)", async () => {
    const deps = makeCreateDeps();
    const res = await handleCreateCheckpoint("pete", jsonReq("not-json{"), deps);
    expect(res.status).toBe(201);
  });
});

// ──────────────────────────── List ────────────────────────────

describe("handleListCheckpoints", () => {
  test("404 when well not found", async () => {
    const deps: ListCheckpointsDeps = {
      findWell: async () => null,
      listCheckpoints: async () => [],
    };
    const res = await handleListCheckpoints("ghost", deps);
    expect(res.status).toBe(404);
  });

  test("empty list → 200 with empty checkpoints", async () => {
    const deps: ListCheckpointsDeps = {
      findWell: async (n) => ({ name: n }),
      listCheckpoints: async () => [],
    };
    const res = await handleListCheckpoints("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { checkpoints: unknown[] };
    expect(body.checkpoints).toEqual([]);
  });

  test("non-empty list passes through", async () => {
    const deps: ListCheckpointsDeps = {
      findWell: async (n) => ({ name: n }),
      listCheckpoints: async () => [
        validCheckpoint({ id: "a" }),
        validCheckpoint({ id: "b" }),
      ],
    };
    const res = await handleListCheckpoints("pete", deps);
    const body = await res.json() as { checkpoints: Array<{ id: string }> };
    expect(body.checkpoints.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

// ──────────────────────────── Expire ────────────────────────────

describe("handleExpireCheckpoint", () => {
  test("404 when well not found", async () => {
    const deps: ExpireCheckpointDeps = {
      findWell: async () => null,
      expireCheckpoint: async () => ({ removed: false }),
    };
    const res = await handleExpireCheckpoint("ghost", "cp-001", deps);
    expect(res.status).toBe(404);
  });

  test("returns id + removed status", async () => {
    const deps: ExpireCheckpointDeps = {
      findWell: async (n) => ({ name: n }),
      expireCheckpoint: async () => ({ removed: true }),
    };
    const res = await handleExpireCheckpoint("pete", "cp-001", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; removed: boolean };
    expect(body.id).toBe("cp-001");
    expect(body.removed).toBe(true);
  });
});

// ──────────────────────────── Restore ────────────────────────────

function makeRestoreDeps(over: Partial<RestoreCheckpointDeps> = {}): RestoreCheckpointDeps {
  return {
    findWell: async (n) => ({ name: n }),
    restoreCheckpoint: async () => {},
    buildWellResource: async (n) => ({ name: n, status: "running" }),
    wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    ...over,
  };
}

describe("handleRestoreCheckpoint", () => {
  test("404 when well not found", async () => {
    const deps = makeRestoreDeps({ findWell: async () => null });
    const res = await handleRestoreCheckpoint("ghost", "cp-001", false, deps);
    expect(res.status).toBe(404);
  });

  test("'not found' error → 404 restore_failed", async () => {
    const deps = makeRestoreDeps({
      restoreCheckpoint: async () => {
        throw new Error("checkpoint 'cp-001' not found");
      },
    });
    const res = await handleRestoreCheckpoint("pete", "cp-001", false, deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("restore_failed");
  });

  test("other error → 500 restore_failed", async () => {
    const deps = makeRestoreDeps({
      restoreCheckpoint: async () => {
        throw new Error("clonefile failed");
      },
    });
    const res = await handleRestoreCheckpoint("pete", "cp-001", false, deps);
    expect(res.status).toBe(500);
  });

  test("fromR2 flag flows to restoreCheckpoint", async () => {
    let captured: { fromR2: boolean } | undefined;
    const deps = makeRestoreDeps({
      restoreCheckpoint: async (_n, _id, opts) => {
        captured = opts;
      },
    });
    await handleRestoreCheckpoint("pete", "cp-001", true, deps);
    expect(captured?.fromR2).toBe(true);
  });

  test("buildWellResource returns null → 500 vanished", async () => {
    const deps = makeRestoreDeps({ buildWellResource: async () => null });
    const res = await handleRestoreCheckpoint("pete", "cp-001", false, deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("vanished");
  });

  test("success → 200 with well resource", async () => {
    const deps = makeRestoreDeps();
    const res = await handleRestoreCheckpoint("pete", "cp-001", false, deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; status: string };
    expect(body.name).toBe("pete");
  });
});
