import { describe, expect, test } from "bun:test";
import { handleCreateWell, type CreateWellDeps } from "./createWell.ts";

// Biggest of the extracted welld handlers. Covers:
// - body parse + schema validation (400 envelopes)
// - from_image + from_thaw mutual exclusion
// - the create-vs-thaw fork (and that env/sizing flow into createWell)
// - failure-path lease release (cells team 2026-05-11 lease leak fix)
// - vanished race (resource gone post-create)
// - 201 status + response routing

interface MockCall {
  fn: string;
  args: unknown[];
}

function makeDeps(overrides: Partial<CreateWellDeps> = {}): {
  deps: CreateWellDeps;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const deps: CreateWellDeps = {
    createWell: async (opts) => {
      calls.push({ fn: "createWell", args: [opts] });
      return undefined;
    },
    thawFrom: async (opts) => {
      calls.push({ fn: "thawFrom", args: [opts] });
      return undefined;
    },
    clearLastTouched: (name) => {
      calls.push({ fn: "clearLastTouched", args: [name] });
    },
    releaseLeaseBestEffort: async (name) => {
      calls.push({ fn: "releaseLeaseBestEffort", args: [name] });
    },
    buildWellResource: async (name) => {
      calls.push({ fn: "buildWellResource", args: [name] });
      return { name, status: "running" };
    },
    wellResourceResponse: (body, _route, status = 200) =>
      Response.json(body, { status }),
    ...overrides,
  };
  return { deps, calls };
}

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/v1/wells", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleCreateWell", () => {
  test("400 bad_json on malformed body", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateWell(jsonReq("not-json{"), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_json");
  });

  test("400 bad_request when schema fails (missing name)", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateWell(jsonReq({ cpu: 2 }), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("400 bad_request on from_image + from_thaw collision", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleCreateWell(
      jsonReq({ name: "x", from_image: "img", from_thaw: "src" }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("mutually exclusive");
    expect(calls.find((c) => c.fn === "createWell")).toBeUndefined();
    expect(calls.find((c) => c.fn === "thawFrom")).toBeUndefined();
  });

  test("default path → createWell, 201 with resource", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleCreateWell(jsonReq({ name: "pete" }), deps);
    expect(res.status).toBe(201);
    const body = await res.json() as { name: string; status: string };
    expect(body.name).toBe("pete");
    const create = calls.find((c) => c.fn === "createWell");
    expect(create).toBeDefined();
    expect((create!.args[0] as { name: string }).name).toBe("pete");
  });

  test("from_thaw → thawFrom (not createWell)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleCreateWell(
      jsonReq({ name: "clone", from_thaw: "src" }),
      deps,
    );
    expect(res.status).toBe(201);
    const thaw = calls.find((c) => c.fn === "thawFrom");
    expect(thaw).toBeDefined();
    expect(thaw!.args[0]).toEqual({ srcName: "src", newName: "clone" });
    expect(calls.find((c) => c.fn === "createWell")).toBeUndefined();
  });

  test("createWell opts include from_image when provided", async () => {
    const { deps, calls } = makeDeps();
    await handleCreateWell(
      jsonReq({ name: "x", from_image: "ubuntu-base" }),
      deps,
    );
    const opts = calls.find((c) => c.fn === "createWell")!.args[0] as {
      fromImage?: string;
    };
    expect(opts.fromImage).toBe("ubuntu-base");
  });

  test("createWell opts omit fromImage when not provided", async () => {
    const { deps, calls } = makeDeps();
    await handleCreateWell(jsonReq({ name: "x" }), deps);
    const opts = calls.find((c) => c.fn === "createWell")!.args[0] as {
      fromImage?: string;
    };
    expect("fromImage" in opts).toBe(false);
  });

  test("createWell opts pass cpu/memory/disk/env when provided", async () => {
    const { deps, calls } = makeDeps();
    await handleCreateWell(
      jsonReq({
        name: "x",
        cpu: 4,
        memory: "2GB",
        disk: "20GB",
        env: { FOO: "bar" },
      }),
      deps,
    );
    const opts = calls.find((c) => c.fn === "createWell")!.args[0] as {
      cpu: number;
      memory: string;
      disk: string;
      env: Record<string, string>;
    };
    expect(opts.cpu).toBe(4);
    expect(opts.memory).toBe("2GB");
    expect(opts.disk).toBe("20GB");
    expect(opts.env).toEqual({ FOO: "bar" });
  });

  test("createWell opts pass hibernateReady when hibernate_ready is set", async () => {
    const { deps, calls } = makeDeps();
    await handleCreateWell(
      jsonReq({ name: "x", hibernate_ready: true }),
      deps,
    );
    const opts = calls.find((c) => c.fn === "createWell")!.args[0] as {
      hibernateReady?: boolean;
    };
    expect(opts.hibernateReady).toBe(true);
  });

  test("clearLastTouched fires before createWell (stale-entry hygiene)", async () => {
    const { deps, calls } = makeDeps();
    await handleCreateWell(jsonReq({ name: "x" }), deps);
    const clearIdx = calls.findIndex((c) => c.fn === "clearLastTouched");
    const createIdx = calls.findIndex((c) => c.fn === "createWell");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(clearIdx);
  });

  test("createWell throws → 400 create_failed + lease release", async () => {
    const { deps, calls } = makeDeps({
      createWell: async () => {
        throw new Error("lume rejected: name conflict");
      },
    });
    const res = await handleCreateWell(jsonReq({ name: "x" }), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("create_failed");
    expect(body.message).toContain("lume rejected");
    const release = calls.find((c) => c.fn === "releaseLeaseBestEffort");
    expect(release).toBeDefined();
    expect(release!.args).toEqual(["x"]);
  });

  test("thawFrom throws → 400 create_failed + lease release", async () => {
    const { deps, calls } = makeDeps({
      thawFrom: async () => {
        throw new Error("source not hibernating");
      },
    });
    const res = await handleCreateWell(
      jsonReq({ name: "clone", from_thaw: "src" }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("create_failed");
    expect(calls.find((c) => c.fn === "releaseLeaseBestEffort")).toBeDefined();
  });

  test("vanished: buildWellResource returns null post-create → 500", async () => {
    const { deps } = makeDeps({ buildWellResource: async () => null });
    const res = await handleCreateWell(jsonReq({ name: "x" }), deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("vanished");
    expect(body.message).toContain("missing post-create");
  });

  test("wellResourceResponse receives route + 201 status", async () => {
    let capturedRoute = "";
    let capturedStatus: number | undefined;
    const { deps } = makeDeps({
      wellResourceResponse: (body, route, status) => {
        capturedRoute = route;
        capturedStatus = status;
        return Response.json(body, { status });
      },
    });
    await handleCreateWell(jsonReq({ name: "x" }), deps);
    expect(capturedRoute).toBe("/v1/wells");
    expect(capturedStatus).toBe(201);
  });

  test("when createWell throws, buildWellResource is NOT called", async () => {
    const { deps, calls } = makeDeps({
      createWell: async () => {
        throw new Error("boom");
      },
    });
    await handleCreateWell(jsonReq({ name: "x" }), deps);
    expect(calls.find((c) => c.fn === "buildWellResource")).toBeUndefined();
  });
});
