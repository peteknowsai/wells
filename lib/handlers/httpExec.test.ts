import { describe, expect, test } from "bun:test";
import {
  handleHttpExec,
  type HttpExecDeps,
  type ExecRunResult,
} from "./httpExec.ts";

function jsonReq(body: unknown): Request {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-length": String(s.length) },
    body: s,
  });
}

function makeDeps(over: Partial<HttpExecDeps> = {}): HttpExecDeps {
  return {
    findWell: async (n) => ({ name: n }),
    ensureRunning: async () => {},
    resolveWellIp: async () => "192.168.65.10",
    runExec: async (): Promise<ExecRunResult> => ({
      exit_code: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
    }),
    capBytes: 4 * 1024 * 1024,
    ...over,
  };
}

describe("handleHttpExec", () => {
  test("404 when well not found", async () => {
    const deps = makeDeps({ findWell: async () => null });
    const res = await handleHttpExec("ghost", jsonReq({ command: ["ls"] }), deps);
    expect(res.status).toBe(404);
  });

  test("504 wake_failed when ensureRunning throws", async () => {
    const deps = makeDeps({
      ensureRunning: async () => {
        throw new Error("wake timed out");
      },
    });
    const res = await handleHttpExec("pete", jsonReq({ command: ["ls"] }), deps);
    expect(res.status).toBe(504);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("wake_failed");
  });

  test("400 bad_json on malformed body", async () => {
    const deps = makeDeps();
    const res = await handleHttpExec("pete", jsonReq("not-json{"), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_json");
  });

  test("400 bad_request on schema fail (missing command)", async () => {
    const deps = makeDeps();
    const res = await handleHttpExec("pete", jsonReq({}), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("400 bad_request on empty command array", async () => {
    const deps = makeDeps();
    const res = await handleHttpExec("pete", jsonReq({ command: [] }), deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("must not be empty");
  });

  test("409 no_lease when resolveWellIp returns null", async () => {
    const deps = makeDeps({ resolveWellIp: async () => null });
    const res = await handleHttpExec("pete", jsonReq({ command: ["ls"] }), deps);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("no_lease");
  });

  test("success: 200 with exec result fields", async () => {
    const deps = makeDeps();
    const res = await handleHttpExec("pete", jsonReq({ command: ["echo", "hi"] }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { exit_code: number; stdout: string; stderr: string };
    expect(body.exit_code).toBe(0);
    expect(body.stdout).toBe("hi\n");
  });

  test("truncated: true is forwarded when runExec returns truncated", async () => {
    const deps = makeDeps({
      runExec: async () => ({
        exit_code: 0,
        stdout: "lots of output",
        stderr: "",
        truncated: true,
      }),
    });
    const res = await handleHttpExec("pete", jsonReq({ command: ["yes"] }), deps);
    const body = await res.json() as { truncated?: boolean };
    expect(body.truncated).toBe(true);
  });

  test("truncated: false → field absent (sprites lean shape)", async () => {
    const deps = makeDeps();
    const res = await handleHttpExec("pete", jsonReq({ command: ["ls"] }), deps);
    const body = await res.json() as Record<string, unknown>;
    expect("truncated" in body).toBe(false);
  });

  test("non-zero exit code passes through", async () => {
    const deps = makeDeps({
      runExec: async () => ({ exit_code: 42, stdout: "", stderr: "boom\n", truncated: false }),
    });
    const res = await handleHttpExec("pete", jsonReq({ command: ["false"] }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { exit_code: number; stderr: string };
    expect(body.exit_code).toBe(42);
    expect(body.stderr).toBe("boom\n");
  });

  test("user defaults to 'root' when body.user is absent", async () => {
    let captured: string | undefined;
    const deps = makeDeps({
      runExec: async (opts) => {
        captured = opts.user;
        return { exit_code: 0, stdout: "", stderr: "", truncated: false };
      },
    });
    await handleHttpExec("pete", jsonReq({ command: ["ls"] }), deps);
    expect(captured).toBe("root");
  });

  test("user override flows into runExec", async () => {
    let captured: string | undefined;
    const deps = makeDeps({
      runExec: async (opts) => {
        captured = opts.user;
        return { exit_code: 0, stdout: "", stderr: "", truncated: false };
      },
    });
    await handleHttpExec("pete", jsonReq({ command: ["ls"], user: "cell" }), deps);
    expect(captured).toBe("cell");
  });

  test("command + ip flow into runExec", async () => {
    let opts: { name: string; ip: string; command: string[] } | undefined;
    const deps = makeDeps({
      runExec: async (o) => {
        opts = o;
        return { exit_code: 0, stdout: "", stderr: "", truncated: false };
      },
    });
    await handleHttpExec(
      "pete",
      jsonReq({ command: ["bash", "-lc", "echo hi"] }),
      deps,
    );
    expect(opts?.name).toBe("pete");
    expect(opts?.ip).toBe("192.168.65.10");
    expect(opts?.command).toEqual(["bash", "-lc", "echo hi"]);
  });
});
