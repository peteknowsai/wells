// Welld HTTP client. Used by the CLI (and anyone else who wants to talk
// to a local welld from JS). Resolves URL + token, hands back parsed JSON,
// emits friendly errors when welld isn't reachable.
//
// URL: WELL_API_URL (default http://127.0.0.1:7878).
// Token: WELL_TOKEN, or ~/.wells/token.

import { readToken } from "./token.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function resolveAuth(): Promise<{ baseUrl: string; token: string }> {
  const baseUrl = process.env.WELL_API_URL ?? "http://127.0.0.1:7878";
  const token = process.env.WELL_TOKEN ?? (await readToken());
  if (!token) {
    throw new Error(
      "no wells token (set WELL_TOKEN or run welld once to auto-generate ~/.wells/token)",
    );
  }
  return { baseUrl, token };
}

export async function apiFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { baseUrl, token } = await resolveAuth();
  let r: Response;
  try {
    r = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `cannot reach welld at ${baseUrl} — is it running? (${(e as Error).message})`,
    );
  }
  const text = await r.text();
  if (!r.ok) {
    let code = "http_error";
    let msg = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === "string") code = parsed.error;
      if (typeof parsed?.message === "string") msg = parsed.message;
    } catch {
      // body wasn't JSON — keep the raw slice
    }
    throw new ApiError(r.status, code, msg);
  }
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
