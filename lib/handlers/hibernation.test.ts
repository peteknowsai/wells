import { describe, expect, test } from "bun:test";
import { handleHibernation, type HibernationDeps } from "./hibernation.ts";

// Companion to lifecycle.test.ts — same shape, smaller dep surface.
// This is the cells team's wake-on-traffic path: POST /v1/wells/<n>/wake
// fires when a hibernated cell receives traffic, and POST .../hibernate
// is what the watchdog drives (or operators invoke for explicit sleep).

interface MockCall {
  fn: string;
  args: unknown[];
}

function makeDeps(overrides: Partial<HibernationDeps> = {}): {
  deps: HibernationDeps;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const deps: HibernationDeps = {
    findWell: async (name) => {
      calls.push({ fn: "findWell", args: [name] });
      return { name };
    },
    transitionWell: async (name, verb) => {
      calls.push({ fn: "transitionWell", args: [name, verb] });
      return undefined;
    },
    buildWellResource: async (name) => {
      calls.push({ fn: "buildWellResource", args: [name] });
      return { name, status: "running" };
    },
    wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    ...overrides,
  };
  return { deps, calls };
}

describe("handleHibernation", () => {
  test("404 when findWell returns null (hibernate verb)", async () => {
    const { deps } = makeDeps({ findWell: async () => null });
    const res = await handleHibernation("ghost", "hibernate", deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("404 when findWell returns null (wake verb)", async () => {
    const { deps } = makeDeps({ findWell: async () => null });
    const res = await handleHibernation("ghost", "wake", deps);
    expect(res.status).toBe(404);
  });

  test("hibernate: calls transitionWell('hibernate'), returns 200", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleHibernation("pete", "hibernate", deps);
    expect(res.status).toBe(200);
    const trans = calls.find((c) => c.fn === "transitionWell");
    expect(trans).toBeDefined();
    expect(trans!.args).toEqual(["pete", "hibernate"]);
  });

  test("wake: calls transitionWell('wake'), returns 200", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleHibernation("pete", "wake", deps);
    expect(res.status).toBe(200);
    const trans = calls.find((c) => c.fn === "transitionWell");
    expect(trans).toBeDefined();
    expect(trans!.args).toEqual(["pete", "wake"]);
  });

  test("hibernate failure → 500 hibernate_failed", async () => {
    const { deps } = makeDeps({
      transitionWell: async () => {
        throw new Error("save-state refused: VM in error state");
      },
    });
    const res = await handleHibernation("pete", "hibernate", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("hibernate_failed");
    expect(body.message).toContain("save-state refused");
  });

  test("HibernateNotReadyError → 409 well_not_hibernate_ready", async () => {
    // The handler tags 409 to errors carrying code === "well_not_hibernate_ready",
    // separating "well isn't sealed yet, caller's fault" from generic 500
    // hibernate_failed. Matches the documented refusal code in
    // docs/cells-pool-builder-primitives.md.
    class FakeErr extends Error {
      code = "well_not_hibernate_ready" as const;
    }
    const { deps } = makeDeps({
      transitionWell: async () => {
        throw new FakeErr("well 'pete' is not sealed (hibernate_ready=false)");
      },
    });
    const res = await handleHibernation("pete", "hibernate", deps);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("well_not_hibernate_ready");
    expect(body.message).toContain("not sealed");
  });

  test("wake failure → 500 wake_failed", async () => {
    const { deps } = makeDeps({
      transitionWell: async () => {
        throw new Error("restore-state recipe drift");
      },
    });
    const res = await handleHibernation("pete", "wake", deps);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("wake_failed");
  });

  test("vanished error message names the verb", async () => {
    const { deps } = makeDeps({ buildWellResource: async () => null });
    const wake = await handleHibernation("pete", "wake", deps);
    expect(wake.status).toBe(500);
    const wakeBody = await wake.json() as { error: string; message: string };
    expect(wakeBody.error).toBe("vanished");
    expect(wakeBody.message).toContain("mid-wake");
  });

  test("success: response body comes from buildWellResource", async () => {
    const { deps } = makeDeps({
      buildWellResource: async (n) => ({ name: n, status: "stopped" }),
    });
    const res = await handleHibernation("pete", "hibernate", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; status: string };
    expect(body.name).toBe("pete");
    expect(body.status).toBe("stopped");
  });

  test("when transitionWell throws, buildWellResource is NOT called", async () => {
    const { deps, calls } = makeDeps({
      transitionWell: async () => {
        throw new Error("nope");
      },
    });
    await handleHibernation("pete", "wake", deps);
    expect(calls.find((c) => c.fn === "buildWellResource")).toBeUndefined();
  });

  test("ordering: transitionWell precedes buildWellResource on success", async () => {
    const { deps, calls } = makeDeps();
    await handleHibernation("pete", "wake", deps);
    const transIdx = calls.findIndex((c) => c.fn === "transitionWell");
    const buildIdx = calls.findIndex((c) => c.fn === "buildWellResource");
    expect(transIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(transIdx);
  });
});
