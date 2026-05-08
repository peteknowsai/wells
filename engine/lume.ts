// Typed wrapper around lume's HTTP API. Lume serve listens on 127.0.0.1:7777
// by default; the daemon supervises that process. This module only speaks HTTP.

const DEFAULT_BASE = "http://127.0.0.1:7777";

export type VMSummary = {
  name: string;
  state?: string;
  os?: string;
  // Lume returns more fields per VM; keep this loose for now.
  [k: string]: unknown;
};

export type CreateOpts = {
  name: string;
  os?: "linux" | "macOS";
  ipsw?: string;
  cpu?: number;
  memory?: string;
  diskSize?: string;
  storage?: string;
  display?: string;
  [k: string]: unknown;
};

export type CloneOpts = {
  name: string;
  newName: string;
  sourceLocation?: string;
  destLocation?: string;
};

export type RunOpts = {
  noDisplay?: boolean;
  sharedDir?: string;
  recoveryMode?: boolean;
  storage?: string;
  vncPort?: number;
};

export type PullOpts = {
  image: string;
  name?: string;
  registry?: string;
  organization?: string;
  storage?: string;
};

export class LumeClient {
  constructor(private baseUrl: string = DEFAULT_BASE) {}

  async list(storage?: string): Promise<VMSummary[]> {
    const qs = storage ? `?storage=${encodeURIComponent(storage)}` : "";
    return this.request<VMSummary[]>("GET", `/lume/vms${qs}`);
  }

  async info(name: string, storage?: string): Promise<VMSummary> {
    const qs = storage ? `?storage=${encodeURIComponent(storage)}` : "";
    return this.request<VMSummary>(
      "GET",
      `/lume/vms/${encodeURIComponent(name)}${qs}`,
    );
  }

  async create(opts: CreateOpts): Promise<unknown> {
    return this.request("POST", "/lume/vms", opts);
  }

  async clone(opts: CloneOpts): Promise<unknown> {
    return this.request("POST", "/lume/vms/clone", opts);
  }

  async start(name: string, opts: RunOpts = {}): Promise<unknown> {
    return this.request(
      "POST",
      `/lume/vms/${encodeURIComponent(name)}/run`,
      opts,
    );
  }

  async stop(name: string, storage?: string): Promise<unknown> {
    return this.request(
      "POST",
      `/lume/vms/${encodeURIComponent(name)}/stop`,
      storage ? { storage } : undefined,
    );
  }

  // wells: hot-tier — pause/resume against the patched lume. Requires
  // the VM to be in lume serve's SharedVM cache (i.e. started via
  // /lume/vms/:name/run, not spawned externally).
  async pause(name: string): Promise<unknown> {
    return this.request("POST", `/lume/vms/${encodeURIComponent(name)}/pause`);
  }

  async resume(name: string): Promise<unknown> {
    return this.request("POST", `/lume/vms/${encodeURIComponent(name)}/resume`);
  }

  async delete(name: string, storage?: string): Promise<unknown> {
    const qs = storage ? `?storage=${encodeURIComponent(storage)}` : "";
    return this.request(
      "DELETE",
      `/lume/vms/${encodeURIComponent(name)}${qs}`,
    );
  }

  async pull(opts: PullOpts): Promise<unknown> {
    return this.request("POST", "/lume/pull", opts);
  }

  async waitForStatus(
    name: string,
    expected: string | string[],
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<VMSummary> {
    const targets = Array.isArray(expected) ? expected : [expected];
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let last: VMSummary | undefined;
    while (Date.now() < deadline) {
      last = await this.info(name);
      if (typeof last.status === "string" && targets.includes(last.status)) {
        return last;
      }
      await Bun.sleep(intervalMs);
    }
    throw new Error(
      `lume vm '${name}' did not reach status [${targets.join("|")}] within ${timeoutMs}ms; last=${last?.status ?? "unknown"}`,
    );
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers:
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    const r = await fetch(this.baseUrl + path, init);
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`lume ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    }
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

export const lume = new LumeClient();
