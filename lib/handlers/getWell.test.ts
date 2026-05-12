import { describe, expect, test } from "bun:test";
import { handleGetWell, type GetWellDeps } from "./getWell.ts";

// Smallest handler in the welld surface — one dep, two paths.
// Coverage primarily validates the 404 envelope and the success
// response wiring. The buildWellResource implementation (which
// composes findWell + lume.info + resolveWellIp + diskUsageBytes)
// is the place where most of the actual logic lives; here we just
// confirm the handler routes its output correctly.

describe("handleGetWell", () => {
  test("404 when buildWellResource returns null", async () => {
    const deps: GetWellDeps = { buildWellResource: async () => null };
    const res = await handleGetWell("ghost", deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("ghost");
  });

  test("200 with the resource shape when buildWellResource returns a body", async () => {
    const deps: GetWellDeps = {
      buildWellResource: async (name) => ({ name, status: "running" }),
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    const res = await handleGetWell("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; status: string };
    expect(body.name).toBe("pete");
    expect(body.status).toBe("running");
  });

  test("buildWellResource is called with the well name", async () => {
    let captured = "";
    const deps: GetWellDeps = {
      buildWellResource: async (name) => {
        captured = name;
        return { name };
      },
      wellResourceResponse: (body) => Response.json(body, { status: 200 }),
    };
    await handleGetWell("pete-x", deps);
    expect(captured).toBe("pete-x");
  });

  test("wellResourceResponse receives the right route", async () => {
    let capturedRoute = "";
    const deps: GetWellDeps = {
      buildWellResource: async (name) => ({ name }),
      wellResourceResponse: (body, route) => {
        capturedRoute = route;
        return Response.json(body, { status: 200 });
      },
    };
    await handleGetWell("pete", deps);
    expect(capturedRoute).toBe("/v1/wells/pete");
  });

  test("404 message is sprite-shaped (error code + message)", async () => {
    const deps: GetWellDeps = { buildWellResource: async () => null };
    const res = await handleGetWell("ghost", deps);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["error", "message"]);
  });
});
