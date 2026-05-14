import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetIpPoolMutexForTests,
  _resetIpPoolReservationsForTests,
  allocateInRange,
  checkBootpdOverlap,
  currentlyTakenIps,
  DEFAULT_STATIC_RANGE_END,
  DEFAULT_STATIC_RANGE_START,
  loadStaticRange,
  nextStaticIp,
  parseRange,
  rangesOverlap,
  readBootpdRange,
  releaseReservedIp,
  SUBNET_PREFIX,
} from "./ipPool.ts";

describe("parseRange", () => {
  test("short form: 200-250", () => {
    expect(parseRange("200-250")).toEqual({ start: 200, end: 250 });
  });

  test("prefix form on both endpoints", () => {
    expect(parseRange("192.168.64.200-192.168.64.250")).toEqual({
      start: 200,
      end: 250,
    });
  });

  test("prefix form on first endpoint only", () => {
    expect(parseRange("192.168.64.200-250")).toEqual({ start: 200, end: 250 });
  });

  test("tolerates whitespace", () => {
    expect(parseRange("  200 - 250  ")).toEqual({ start: 200, end: 250 });
  });

  test("rejects empty input", () => {
    expect(() => parseRange("")).toThrow();
    expect(() => parseRange("   ")).toThrow();
  });

  test("rejects single-endpoint forms", () => {
    expect(() => parseRange("200")).toThrow();
    expect(() => parseRange("200-")).toThrow();
    expect(() => parseRange("-200")).toThrow();
  });

  test("rejects start > end", () => {
    expect(() => parseRange("250-200")).toThrow(/start>end/);
  });

  test("rejects out-of-octet endpoints", () => {
    expect(() => parseRange("0-50")).toThrow();
    expect(() => parseRange("100-255")).toThrow();
  });

  test("rejects non-numeric endpoints", () => {
    expect(() => parseRange("abc-def")).toThrow();
  });

  test("rejects wrong-subnet endpoints", () => {
    expect(() => parseRange("10.0.0.1-10.0.0.10")).toThrow(
      /192\.168\.64/,
    );
  });
});

describe("allocateInRange", () => {
  test("returns the lowest IP when nothing taken", () => {
    expect(allocateInRange({ start: 200, end: 250 }, [])).toBe(
      `${SUBNET_PREFIX}200`,
    );
  });

  test("skips already-taken IPs", () => {
    const taken = [`${SUBNET_PREFIX}200`, `${SUBNET_PREFIX}201`];
    expect(allocateInRange({ start: 200, end: 250 }, taken)).toBe(
      `${SUBNET_PREFIX}202`,
    );
  });

  test("returns null when range is exhausted", () => {
    const taken: string[] = [];
    for (let i = 200; i <= 250; i++) taken.push(`${SUBNET_PREFIX}${i}`);
    expect(allocateInRange({ start: 200, end: 250 }, taken)).toBeNull();
  });

  test("ignores taken IPs outside the range", () => {
    const taken = [`${SUBNET_PREFIX}50`, `${SUBNET_PREFIX}199`, `${SUBNET_PREFIX}251`];
    expect(allocateInRange({ start: 200, end: 250 }, taken)).toBe(
      `${SUBNET_PREFIX}200`,
    );
  });

  test("returns next free when a middle slot opens", () => {
    const taken = new Set<string>();
    for (let i = 200; i < 215; i++) taken.add(`${SUBNET_PREFIX}${i}`);
    for (let i = 216; i <= 250; i++) taken.add(`${SUBNET_PREFIX}${i}`);
    expect(allocateInRange({ start: 200, end: 250 }, taken)).toBe(
      `${SUBNET_PREFIX}215`,
    );
  });

  test("works for single-IP ranges", () => {
    expect(allocateInRange({ start: 220, end: 220 }, [])).toBe(
      `${SUBNET_PREFIX}220`,
    );
    expect(allocateInRange({ start: 220, end: 220 }, [`${SUBNET_PREFIX}220`]))
      .toBeNull();
  });
});

describe("loadStaticRange + state-dir-backed defaults", () => {
  const dirs: string[] = [];
  const oldStateDir = process.env.WELL_STATE_DIR;

  afterAll(async () => {
    if (oldStateDir == null) delete process.env.WELL_STATE_DIR;
    else process.env.WELL_STATE_DIR = oldStateDir;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function isolatedStateDir(defaultsBody: object | null): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "ip-pool-test-"));
    dirs.push(d);
    if (defaultsBody !== null) {
      await writeFile(
        join(d, "defaults.json"),
        JSON.stringify(defaultsBody),
        { mode: 0o600 },
      );
    }
    process.env.WELL_STATE_DIR = d;
    return d;
  }

  test("returns the hardcoded default range when no defaults.json", async () => {
    await isolatedStateDir(null);
    expect(await loadStaticRange()).toEqual({
      start: DEFAULT_STATIC_RANGE_START,
      end: DEFAULT_STATIC_RANGE_END,
    });
  });

  test("honors operator override in defaults.json", async () => {
    await isolatedStateDir({ static_ip_range: "210-220" });
    expect(await loadStaticRange()).toEqual({ start: 210, end: 220 });
  });

  test("returns the W.72 default range when operator opts in to its constants", async () => {
    await isolatedStateDir({
      static_ip_range: `${DEFAULT_STATIC_RANGE_START}-${DEFAULT_STATIC_RANGE_END}`,
    });
    expect(await loadStaticRange()).toEqual({
      start: DEFAULT_STATIC_RANGE_START,
      end: DEFAULT_STATIC_RANGE_END,
    });
  });

  test("returns null when explicitly disabled", async () => {
    await isolatedStateDir({ static_ip_range: null });
    expect(await loadStaticRange()).toBeNull();
  });
});

describe("currentlyTakenIps + nextStaticIp", () => {
  const dirs: string[] = [];
  const oldStateDir = process.env.WELL_STATE_DIR;

  beforeEach(() => {
    _resetIpPoolMutexForTests();
    _resetIpPoolReservationsForTests();
  });

  afterAll(async () => {
    if (oldStateDir == null) delete process.env.WELL_STATE_DIR;
    else process.env.WELL_STATE_DIR = oldStateDir;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function seedRegistry(
    pinnedIps: string[],
    defaults?: object,
  ): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "ip-pool-test-"));
    dirs.push(d);
    // registry.json with one well per pin
    const wells = pinnedIps.map((ip, i) => ({
      name: `pinned-${i}`,
      uuid: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      created_at: "2026-05-12T00:00:00Z",
      cpu: 1,
      memory: "256MB",
      disk_size: "10GB",
      auth: "well",
      pinned_ip: ip,
    }));
    await writeFile(
      join(d, "registry.json"),
      JSON.stringify({ wells }),
      { mode: 0o600 },
    );
    if (defaults) {
      await writeFile(
        join(d, "defaults.json"),
        JSON.stringify(defaults),
        { mode: 0o600 },
      );
    }
    process.env.WELL_STATE_DIR = d;
    return d;
  }

  test("currentlyTakenIps surfaces registry pinned IPs", async () => {
    await seedRegistry(["192.168.64.200", "192.168.64.205"]);
    const taken = await currentlyTakenIps();
    expect(taken.has("192.168.64.200")).toBe(true);
    expect(taken.has("192.168.64.205")).toBe(true);
  });

  test("nextStaticIp returns the lowest free IP using the default range", async () => {
    await seedRegistry(["192.168.64.200"]);
    expect(await nextStaticIp()).toBe("192.168.64.201");
  });

  test("nextStaticIp returns null when operator explicitly disables the range", async () => {
    await seedRegistry(["192.168.64.200"], { static_ip_range: null });
    expect(await nextStaticIp()).toBeNull();
  });

  test("nextStaticIp returns null when operator disables static range", async () => {
    await seedRegistry([], { static_ip_range: null });
    expect(await nextStaticIp()).toBeNull();
  });

  test("nextStaticIp serializes concurrent calls + reservations prevent double-allocation", async () => {
    await seedRegistry([], { static_ip_range: "200-202" });
    // Three concurrent allocations from a 3-slot range. The mutex
    // serializes the read+pick step; the in-memory reservation set
    // ensures each call sees the previous call's pick as taken even
    // though the caller hasn't yet written it to the registry. Cells
    // team 2026-05-13 surfaced this race when 5 parallel POST /v1/wells
    // calls produced 3 wells (2 collided on the same .NNN).
    const results = await Promise.all([
      nextStaticIp(),
      nextStaticIp(),
      nextStaticIp(),
    ]);
    expect(results.sort()).toEqual([
      "192.168.64.200",
      "192.168.64.201",
      "192.168.64.202",
    ]);
  });

  test("releaseReservedIp frees a previously-reserved IP for re-allocation", async () => {
    await seedRegistry([], { static_ip_range: "200-201" });
    const first = await nextStaticIp();
    expect(first).toBe("192.168.64.200");
    // Without release, the next pick should be .201 (since .200 is reserved).
    const second = await nextStaticIp();
    expect(second).toBe("192.168.64.201");
    // After releasing .200, a third call should reuse it (lowest free in range).
    releaseReservedIp("192.168.64.200");
    const third = await nextStaticIp();
    expect(third).toBe("192.168.64.200");
  });

  test("currentlyTakenIps includes in-flight reservations", async () => {
    await seedRegistry([]);
    await nextStaticIp(); // reserves .200
    const taken = await currentlyTakenIps();
    expect(taken.has("192.168.64.200")).toBe(true);
  });

  test("nextStaticIp returns null when range exhausted", async () => {
    await seedRegistry(
      ["192.168.64.220", "192.168.64.221", "192.168.64.222"],
      { static_ip_range: "220-222" },
    );
    expect(await nextStaticIp()).toBeNull();
  });
});

describe("rangesOverlap", () => {
  test("identical ranges overlap", () => {
    expect(rangesOverlap({ start: 200, end: 250 }, { start: 200, end: 250 }))
      .toBe(true);
  });

  test("disjoint ranges don't overlap", () => {
    expect(rangesOverlap({ start: 2, end: 150 }, { start: 200, end: 250 }))
      .toBe(false);
    expect(rangesOverlap({ start: 200, end: 250 }, { start: 2, end: 150 }))
      .toBe(false);
  });

  test("adjacent (just-touching) ranges count as overlap", () => {
    // .150 in both → bootpd would race us for that one slot.
    expect(rangesOverlap({ start: 100, end: 150 }, { start: 150, end: 200 }))
      .toBe(true);
  });

  test("nested ranges overlap", () => {
    expect(rangesOverlap({ start: 200, end: 250 }, { start: 210, end: 220 }))
      .toBe(true);
  });
});

describe("readBootpdRange + checkBootpdOverlap (file-backed)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function writePlist(body: object): Promise<string> {
    // plutil reads any valid plist (XML or JSON-shaped) — write JSON
    // and convert to XML so the test exercises the real readBootpdRange
    // codepath. Returns the resulting plist path.
    const dir = await mkdtemp(join(tmpdir(), "bootpd-test-"));
    dirs.push(dir);
    const jsonPath = join(dir, "src.json");
    const plistPath = join(dir, "bootpd.plist");
    await writeFile(jsonPath, JSON.stringify(body));
    const proc = Bun.spawn(
      ["plutil", "-convert", "xml1", "-o", plistPath, jsonPath],
      { stdout: "ignore", stderr: "ignore" },
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`plutil convert failed`);
    return plistPath;
  }

  test("readBootpdRange returns null for missing file", async () => {
    expect(await readBootpdRange("/tmp/wells-test/does-not-exist.plist"))
      .toBeNull();
  });

  test("readBootpdRange parses a vmnet plist", async () => {
    const path = await writePlist({
      Subnets: [
        {
          name: "vmnet",
          net_address: "192.168.64.0",
          net_range: ["192.168.64.2", "192.168.64.150"],
        },
      ],
    });
    expect(await readBootpdRange(path)).toEqual({ start: 2, end: 150 });
  });

  test("readBootpdRange ignores non-192.168.64 subnets", async () => {
    const path = await writePlist({
      Subnets: [
        {
          name: "other",
          net_address: "10.0.0.0",
          net_range: ["10.0.0.2", "10.0.0.100"],
        },
        {
          name: "vmnet",
          net_address: "192.168.64.0",
          net_range: ["192.168.64.50", "192.168.64.120"],
        },
      ],
    });
    expect(await readBootpdRange(path)).toEqual({ start: 50, end: 120 });
  });

  test("readBootpdRange returns null for malformed range", async () => {
    const path = await writePlist({
      Subnets: [{ name: "vmnet", net_range: ["not-an-ip", "192.168.64.150"] }],
    });
    expect(await readBootpdRange(path)).toBeNull();
  });

  test("checkBootpdOverlap returns no-overlap when bootpd absent", async () => {
    const r = await checkBootpdOverlap(
      { start: 200, end: 250 },
      "/tmp/wells-test/does-not-exist.plist",
    );
    expect(r.overlap).toBe(false);
    expect(r.reason).toContain("absent");
  });

  test("checkBootpdOverlap flags overlap with a clear reason", async () => {
    const path = await writePlist({
      Subnets: [
        {
          net_address: "192.168.64.0",
          net_range: ["192.168.64.2", "192.168.64.220"],
        },
      ],
    });
    const r = await checkBootpdOverlap({ start: 200, end: 250 }, path);
    expect(r.overlap).toBe(true);
    expect(r.reason).toContain("overlaps");
    expect(r.reason).toContain("192.168.64.200");
    // Bootpd end (220) appears in the reason as part of the range hint.
    expect(r.reason).toContain("220");
  });

  test("checkBootpdOverlap reports disjoint when ranges don't collide", async () => {
    const path = await writePlist({
      Subnets: [
        {
          net_address: "192.168.64.0",
          net_range: ["192.168.64.2", "192.168.64.150"],
        },
      ],
    });
    const r = await checkBootpdOverlap({ start: 200, end: 250 }, path);
    expect(r.overlap).toBe(false);
    expect(r.reason).toContain("disjoint");
  });
});
