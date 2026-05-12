import { describe, expect, test } from "bun:test";
import { handleLifecycle, type LifecycleDeps } from "./lifecycle.ts";

// Daemon test scaffolding pilot. The first welld handler extracted to a
// pure orchestrator with deps-injection. Tests substitute mocks for
// every external call so the branching surface (404 / verb dispatch /
// error mapping / vanished race) is exercised without spinning welld
// + lume.
//
// If this pattern proves clean, the rest of the welld.ts handlers can
// follow.

interface MockCall {
  fn: string;
  args: unknown[];
}

function makeDeps(overrides: Partial<LifecycleDeps> = {}): {
  deps: LifecycleDeps;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const record = (fn: string) =>
    async (...args: unknown[]) => {
      calls.push({ fn, args });
      return undefined as never;
    };
  const deps: LifecycleDeps = {
    findWell: async (name) => {
      calls.push({ fn: "findWell", args: [name] });
      return { name };
    },
    ensureRunning: record("ensureRunning"),
    transitionWell: record("transitionWell"),
    buildWellResource: async (name) => {
      calls.push({ fn: "buildWellResource", args: [name] });
      return { name, status: "running" };
    },
    wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    ...overrides,
  };
  return { deps, calls };
}

describe("handleLifecycle", () => {
  test("404 when findWell returns null (start verb)", async () => {
    const { deps, calls } = makeDeps({ findWell: async () => null });
    const res = await handleLifecycle("ghost", "start", deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
    // We did NOT call ensureRunning after the 404
    expect(calls.find((c) => c.fn === "ensureRunning")).toBeUndefined();
  });

  test("404 when findWell returns null (stop verb)", async () => {
    const { deps } = makeDeps({ findWell: async () => null });
    const res = await handleLifecycle("ghost", "stop", deps);
    expect(res.status).toBe(404);
  });

  test("404 when findWell returns undefined", async () => {
    const { deps } = makeDeps({ findWell: async () => undefined });
    const res = await handleLifecycle("ghost", "start", deps);
    expect(res.status).toBe(404);
  });

  test("start: calls ensureRunning with the configured timeout, returns 200", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleLifecycle("pete", "start", deps);
    expect(res.status).toBe(200);
    const ensure = calls.find((c) => c.fn === "ensureRunning");
    expect(ensure).toBeDefined();
    expect(ensure!.args).toEqual(["pete", 60_000]);
    // Stop path should NOT have fired
    expect(calls.find((c) => c.fn === "transitionWell")).toBeUndefined();
  });

  test("stop: calls transitionWell('stop'), not ensureRunning, returns 200", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleLifecycle("pete", "stop", deps);
    expect(res.status).toBe(200);
    const trans = calls.find((c) => c.fn === "transitionWell");
    expect(trans).toBeDefined();
    expect(trans!.args).toEqual(["pete", "stop"]);
    expect(calls.find((c) => c.fn === "ensureRunning")).toBeUndefined();
  });

  test("start: ensureRunning throws → 500 start_failed with the throw message", async () => {
    const { deps } = makeDeps({
      ensureRunning: async () => {
        throw new Error("lume serve unreachable");
      },
    });
    const res = await handleLifecycle("pete", "start", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("start_failed");
    expect(body.message).toContain("lume serve unreachable");
  });

  test("stop: transitionWell throws → 500 stop_failed", async () => {
    const { deps } = makeDeps({
      transitionWell: async () => {
        throw new Error("VZ refused requestStop");
      },
    });
    const res = await handleLifecycle("pete", "stop", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("stop_failed");
    expect(body.message).toContain("VZ refused requestStop");
  });

  test("post-action buildWellResource null → 500 vanished (mid-call destroy race)", async () => {
    const { deps } = makeDeps({ buildWellResource: async () => null });
    const res = await handleLifecycle("pete", "start", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("vanished");
    expect(body.message).toContain("pete");
    expect(body.message).toContain("mid-start");
  });

  test("vanished error message names the right verb (stop case)", async () => {
    const { deps } = makeDeps({ buildWellResource: async () => null });
    const res = await handleLifecycle("pete", "stop", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("mid-stop");
  });

  test("success: response body comes from buildWellResource", async () => {
    const { deps } = makeDeps({
      buildWellResource: async (n) => ({ name: n, status: "running", ip: "192.168.64.50" }),
    });
    const res = await handleLifecycle("pete", "start", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; status: string; ip: string };
    expect(body.name).toBe("pete");
    expect(body.status).toBe("running");
    expect(body.ip).toBe("192.168.64.50");
  });

  test("findWell is the short-circuit — no other deps called when it returns null", async () => {
    // Ordering: 404 short-circuit must happen before we waste an
    // ensureRunning / transitionWell / buildWellResource call.
    const { deps, calls } = makeDeps({ findWell: async () => null });
    await handleLifecycle("ghost", "start", deps);
    // Override didn't record itself; just confirm none of the dependent
    // actions fired.
    expect(calls.find((c) => c.fn === "ensureRunning")).toBeUndefined();
    expect(calls.find((c) => c.fn === "transitionWell")).toBeUndefined();
    expect(calls.find((c) => c.fn === "buildWellResource")).toBeUndefined();
  });

  test("buildWellResource happens AFTER ensureRunning (start)", async () => {
    const { deps, calls } = makeDeps();
    await handleLifecycle("pete", "start", deps);
    const ensureIdx = calls.findIndex((c) => c.fn === "ensureRunning");
    const buildIdx = calls.findIndex((c) => c.fn === "buildWellResource");
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(ensureIdx);
  });

  test("buildWellResource happens AFTER transitionWell (stop)", async () => {
    const { deps, calls } = makeDeps();
    await handleLifecycle("pete", "stop", deps);
    const transIdx = calls.findIndex((c) => c.fn === "transitionWell");
    const buildIdx = calls.findIndex((c) => c.fn === "buildWellResource");
    expect(transIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(transIdx);
  });

  test("when action throws, buildWellResource is NOT called (no need to fetch state)", async () => {
    const { deps, calls } = makeDeps({
      ensureRunning: async () => {
        throw new Error("nope");
      },
    });
    await handleLifecycle("pete", "start", deps);
    expect(calls.find((c) => c.fn === "buildWellResource")).toBeUndefined();
  });
});
