// Pure handler for POST /v1/wells/<n>/exec — synchronous HTTP exec.
// (The WS variant lives in daemon/welld.ts because it does Bun.upgrade
// and ties to the daemon's WS lifecycle.)
//
// Branches:
// - findWell null → 404
// - ensureRunning throws → 504 wake_failed
// - body parse fail → 400 bad_json
// - schema fail → 400 bad_request
// - empty command → 400 bad_request
// - no DHCP lease → 409 no_lease
// - runExec returns truncated → response carries truncated: true
// - normal completion → 200 with exit_code/stdout/stderr

import { Value } from "@sinclair/typebox/value";
import { apiError } from "../apiResponse.ts";
import { ExecRequest, type ExecResponse } from "../schemas.ts";

export interface ExecRunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ExecRunOpts {
  name: string;
  ip: string;
  user: string;
  command: string[];
  capBytes: number;
}

export interface HttpExecDeps {
  findWell(name: string): Promise<{ name: string } | null | undefined>;
  ensureRunning(name: string, timeoutMs: number): Promise<unknown>;
  resolveWellIp(name: string): Promise<string | null>;
  runExec(opts: ExecRunOpts): Promise<ExecRunResult>;
  capBytes: number;
}

export async function handleHttpExec(
  name: string,
  req: Request,
  deps: HttpExecDeps,
): Promise<Response> {
  const record = await deps.findWell(name);
  if (!record) return apiError(404, "not_found", `well '${name}' not found`);

  try {
    await deps.ensureRunning(name, 10_000);
  } catch (err) {
    return apiError(504, "wake_failed", (err as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(ExecRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(ExecRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as ExecRequest;
  if (body.command.length === 0) {
    return apiError(400, "bad_request", "command must not be empty");
  }

  const ip = await deps.resolveWellIp(name);
  if (!ip) {
    return apiError(409, "no_lease", `well '${name}' has no DHCP lease — start it first`);
  }

  const user = body.user ?? "well";
  const result = await deps.runExec({
    name,
    ip,
    user,
    command: body.command,
    capBytes: deps.capBytes,
  });

  const response: ExecResponse = {
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.truncated ? { truncated: true } : {}),
  };
  return Response.json(response);
}
