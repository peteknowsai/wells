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
  // Path to a read-only disk image to mount at boot (e.g. cidata.iso for
  // cloud-init seed). Wells uses this on first boot of a freshly-created
  // well so the VM lands in lume serve's SharedVM cache from birth and
  // pause/resume work without a stop+restart cycle. Requires the lume
  // patch in vendor/lume.patches/swift/0001-add-mount-to-RunVMRequest.
  mount?: string;
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

  // wells: hibernation — save/restore VM state to a file. Welld owns
  // the path; lume just reads/writes there. After saveState the VM is
  // stopped (RAM released); after restoreState the VM is alive again
  // at exactly the pre-save point.
  async saveState(name: string, path: string): Promise<unknown> {
    return this.request(
      "POST",
      `/lume/vms/${encodeURIComponent(name)}/save-state`,
      { path },
    );
  }

  async restoreState(
    name: string,
    path: string,
    mount?: string,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/lume/vms/${encodeURIComponent(name)}/restore-state`,
      mount ? { path, mount } : { path },
    );
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

    // Retry on connect errors — lume serve has a known crash pattern
    // during destroy/create that causes it to exit mid-request. Welld's
    // supervisor (engine/lumeProcess.ts) takes up to 30s to detect lume
    // is down (6 misses × 5s) before respawning, so a request that hits
    // mid-crash needs a budget that covers detection + respawn + spawn
    // wait. 35s gives the supervisor room and adds a little slack.
    // HTTP errors (4xx/5xx from a live lume) are real semantics — never
    // retried.
    const RETRY_BUDGET_MS = 35_000;
    const RETRY_PING_INTERVAL_MS = 500;
    const start = Date.now();
    while (true) {
      try {
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
      } catch (err) {
        const msg = (err as Error).message;
        const isConnectErr =
          msg.includes("Unable to connect") ||
          msg.includes("ECONNREFUSED") ||
          msg.includes("fetch failed") ||
          msg.includes("Failed to fetch") ||
          msg.includes("Connection refused") ||
          msg.includes("connect ECONNREFUSED");
        if (!isConnectErr) throw err;
        if (Date.now() - start > RETRY_BUDGET_MS) {
          throw new Error(`lume unreachable after ${RETRY_BUDGET_MS}ms: ${msg}`);
        }
        // Wait for liveness rather than blind retry — fast feedback when
        // the supervisor brings lume back, no thundering herd if it
        // doesn't.
        await Bun.sleep(RETRY_PING_INTERVAL_MS);
      }
    }
  }
}

export const lume = new LumeClient();
