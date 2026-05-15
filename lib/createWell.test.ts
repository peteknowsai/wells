import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFreshLease, readMeta, reapOrphanVm } from "./createWell.ts";
import type { LeaseSnapshot } from "./dhcp.ts";

// Stale-lease bug: vmnet's `/var/db/dhcpd_leases` accumulates entries
// indefinitely (per-MAC entries persist; per-hostname entries are
// rewritten on every grant but the old IP/lease pair is retained until
// vmnet GC). When a well is destroyed and a new well is created with
// the same name, the prior lease is still in the file. Without
// snapshot-aware filtering, a hostname-match lookup returns the stale
// entry in <20ms (file read), and welld then sits ssh-poking a dead
// IP while the real DHCP lease arrives 4-6s later.
//
// `isFreshLease` is the per-iteration filter that runs against every
// candidate (delta-snapshot, MAC-match, hostname-match results).
describe("isFreshLease", () => {
  const before: LeaseSnapshot[] = [
    { name: "smoke-7", ip: "192.168.64.134", lease: 1778370538 },
    { name: "smoke-6", ip: "192.168.64.124", lease: 1778370539 },
  ];

  test("returns true when no snapshot is provided (no filter)", () => {
    expect(isFreshLease({ ip: "192.168.64.134", lease: 1778370538 })).toBe(true);
  });

  test("rejects a candidate that's an exact match for a snapshot entry (the cells-team smoke-7 case)", () => {
    const stale = { ip: "192.168.64.134", lease: 1778370538 };
    expect(isFreshLease(stale, before)).toBe(false);
  });

  test("accepts a candidate at the same IP but with a newer lease epoch (vmnet renewal)", () => {
    // Same IP can come back to a different VM; what matters is whether the
    // (ip, lease) pair was already seen — a renewal bumps the epoch.
    const renewed = { ip: "192.168.64.134", lease: 1778370600 };
    expect(isFreshLease(renewed, before)).toBe(true);
  });

  test("accepts a candidate at a fresh IP that's not in the snapshot at all", () => {
    const fresh = { ip: "192.168.64.140", lease: 1778370550 };
    expect(isFreshLease(fresh, before)).toBe(true);
  });

  test("accepts a candidate when the snapshot is empty (cold-start case)", () => {
    expect(isFreshLease({ ip: "192.168.64.99", lease: 1 }, [])).toBe(true);
  });

  test("rejects when an unrelated entry happens to share both IP and lease", () => {
    // Both fields must match to count as the same write — guards against
    // a coincidence where IP matches but lease epoch differs.
    const same = { ip: "192.168.64.124", lease: 1778370539 };
    expect(isFreshLease(same, before)).toBe(false);
  });
});

// readMeta is the CLI's escape hatch for showing meta on `well info`.
// Tolerant: returns null on missing file OR invalid JSON instead of
// throwing — these are likely transient states (well mid-create, raced
// filesystem) and the caller treats null as "render without meta".
describe("readMeta", () => {
  let tmp: string;
  let savedStateDir: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-readmeta-test-"));
    savedStateDir = process.env.WELL_STATE_DIR;
    process.env.WELL_STATE_DIR = tmp;
  });

  afterEach(async () => {
    if (savedStateDir === undefined) delete process.env.WELL_STATE_DIR;
    else process.env.WELL_STATE_DIR = savedStateDir;
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns null when the well's meta.json doesn't exist", async () => {
    expect(await readMeta("never-created")).toBeNull();
  });

  test("returns the parsed object when meta.json is valid JSON", async () => {
    const vmDir = join(tmp, "vms", "pete");
    await mkdir(vmDir, { recursive: true });
    const meta = { name: "pete", cpu: 4, memory: "4GB", baseImage: "ubuntu-25.10-base" };
    await writeFile(join(vmDir, "meta.json"), JSON.stringify(meta));
    expect(await readMeta("pete")).toEqual(meta);
  });

  test("returns null on malformed JSON (tolerant, not throwing)", async () => {
    const vmDir = join(tmp, "vms", "pete");
    await mkdir(vmDir, { recursive: true });
    await writeFile(join(vmDir, "meta.json"), "{ not json");
    expect(await readMeta("pete")).toBeNull();
  });

  test("returns null on empty meta.json file", async () => {
    const vmDir = join(tmp, "vms", "pete");
    await mkdir(vmDir, { recursive: true });
    await writeFile(join(vmDir, "meta.json"), "");
    expect(await readMeta("pete")).toBeNull();
  });
});

// reapOrphanVm is the cleanup the createWell catch path runs when a
// create fails after lume.start — without it, a timed-out create
// (cells bake contention, 2026-05-14) leaks the VM and its VZ XPC
// process, which `well doctor` then flags as a degraded orphan.
describe("reapOrphanVm", () => {
  let tmp: string;
  let vmDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wells-reap-test-"));
    vmDir = join(tmp, "vms", "egg-dead");
    await mkdir(vmDir, { recursive: true });
    await writeFile(join(vmDir, "cidata.iso"), "stub");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  type StubFn = () => Promise<unknown>;
  function stubLume(over: { info?: StubFn; stop?: StubFn; delete?: StubFn } = {}) {
    const calls: string[] = [];
    const lume = {
      info:
        over.info ??
        (async () => {
          calls.push("info");
          return { status: "running" };
        }),
      stop:
        over.stop ??
        (async () => {
          calls.push("stop");
          return {};
        }),
      delete:
        over.delete ??
        (async () => {
          calls.push("delete");
          return {};
        }),
    };
    return { lume, calls };
  }

  test("running orphan: stops, deletes, drops the state dir, returns true", async () => {
    const { lume, calls } = stubLume();
    const reaped = await reapOrphanVm(lume, "egg-dead", vmDir);
    expect(reaped).toBe(true);
    expect(calls).toEqual(["info", "stop", "delete"]);
    expect(existsSync(vmDir)).toBe(false);
  });

  test("already-stopped orphan: skips stop, still deletes", async () => {
    const { lume, calls } = stubLume({
      info: async () => ({ status: "stopped" }),
    });
    const reaped = await reapOrphanVm(lume, "egg-dead", vmDir);
    expect(reaped).toBe(true);
    expect(calls).toEqual(["delete"]);
    expect(existsSync(vmDir)).toBe(false);
  });

  test("lume doesn't know the VM: no stop/delete, still drops the state dir, returns false", async () => {
    const { lume, calls } = stubLume({
      info: async () => {
        throw new Error("VM not found");
      },
    });
    const reaped = await reapOrphanVm(lume, "egg-dead", vmDir);
    expect(reaped).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(vmDir)).toBe(false);
  });

  test("tolerates stop/delete failures — never throws from cleanup", async () => {
    const { lume } = stubLume({
      stop: async () => {
        throw new Error("lume stop 500");
      },
      delete: async () => {
        throw new Error("lume delete 500");
      },
    });
    const reaped = await reapOrphanVm(lume, "egg-dead", vmDir);
    expect(reaped).toBe(true);
    expect(existsSync(vmDir)).toBe(false);
  });
});
