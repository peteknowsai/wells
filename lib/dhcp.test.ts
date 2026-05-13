import { describe, expect, test } from "bun:test";
import {
  buildKnownLeaseNames,
  computeOrphanLeasesFrom,
  findNewLeases,
  normalizeMac,
  parseAllDhcpLeases,
  parseDhcpLeasesForHost,
  parseDhcpLeasesForMac,
  type LeaseSnapshot,
} from "./dhcp.ts";

// Apple's /var/db/dhcpd_leases format. Each entry is a brace-delimited
// block; entries for the same hostname accumulate over time (the vmnet
// DHCP server rewrites the lease expiry on each grant rather than
// removing the old entry).
const SAMPLE = `\
{
\tname=cells-1
\tip_address=192.168.64.8
\thw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11:8e:d:cb:92:9e:9f:ce:2a
\tidentifier=ff,f1:f5:dd:7f:0:2:0:0:ab:11:8e:d:cb:92:9e:9f:ce:2a
\tlease=0x69fd6ae3
}
{
\tname=pete
\tip_address=192.168.64.7
\thw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11:ac:de:8c:3b:a4:5f:4d:b4
\tidentifier=ff,f1:f5:dd:7f:0:2:0:0:ab:11:ac:de:8c:3b:a4:5f:4d:b4
\tlease=0x69fd6b0f
}
`;

// The "stale lease" scenario the wells daemon hits in production: a well
// is stopped and started; vmnet writes a NEW entry for the same hostname
// while the OLD one is still in the file, with a higher lease expiry.
// readDhcpLeaseEntry must pick the newer (higher-lease) IP.
const STALE_LEASE = `\
{
\tname=pete
\tip_address=192.168.64.7
\thw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11:c2:e3:37:0:4e:4c:c1:e9
\tlease=0x69fe15c7
}
{
\tname=pete
\tip_address=192.168.64.14
\thw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11:d9:bc:28:a:4:d9:b:63
\tlease=0x69fe15d8
}
`;

describe("parseDhcpLeasesForHost", () => {
  test("returns the entry for a known hostname", () => {
    const entry = parseDhcpLeasesForHost(SAMPLE, "cells-1");
    expect(entry).toEqual({
      ip: "192.168.64.8",
      lease: 0x69fd6ae3,
    });
  });

  test("returns null for an unknown hostname", () => {
    expect(parseDhcpLeasesForHost(SAMPLE, "nonexistent")).toBeNull();
  });

  test("returns null for empty leases file", () => {
    expect(parseDhcpLeasesForHost("", "pete")).toBeNull();
  });

  test("picks the entry with the highest lease (stale lease scenario)", () => {
    const entry = parseDhcpLeasesForHost(STALE_LEASE, "pete");
    // .14 has higher lease than .7 — should pick the newer one
    expect(entry?.ip).toBe("192.168.64.14");
    expect(entry?.lease).toBe(0x69fe15d8);
  });

  test("does not match different hostnames with similar names", () => {
    const text = SAMPLE.replace(/cells-1/g, "cells-10");
    expect(parseDhcpLeasesForHost(text, "cells-1")).toBeNull();
    expect(parseDhcpLeasesForHost(text, "cells-10")?.ip).toBe("192.168.64.8");
  });

  test("handles entries with no lease line (treats as oldest)", () => {
    const text = `\
{
\tname=pete
\tip_address=192.168.64.99
}
{
\tname=pete
\tip_address=192.168.64.7
\tlease=0x69fd6b0f
}
`;
    // The entry with explicit lease should win over the one without
    expect(parseDhcpLeasesForHost(text, "pete")?.ip).toBe("192.168.64.7");
  });
});

describe("parseAllDhcpLeases", () => {
  test("returns every entry sorted newest-lease first", () => {
    const all = parseAllDhcpLeases(SAMPLE);
    expect(all).toHaveLength(2);
    // pete has the higher lease (0x69fd6b0f vs 0x69fd6ae3) → first.
    expect(all[0]!.name).toBe("pete");
    expect(all[0]!.ip).toBe("192.168.64.7");
    expect(all[1]!.name).toBe("cells-1");
  });

  test("empty input returns empty array", () => {
    expect(parseAllDhcpLeases("")).toEqual([]);
  });

  test("extracts MAC for the `1,<mac>` form (Apple's actual format, A.1.4.f)", () => {
    // Apple's vmnet writes `hw_address=1,<mac>` (no leading zero on the
    // type byte), not `01,<mac>` like the lib originally assumed. Bug
    // surfaced 2026-05-09 when the A.1.4.f filter silently never
    // matched any real lease — `parseAllDhcpLeases` returned `mac:null`
    // for every entry and the cold-fallback fix was a no-op.
    const text = `\
{
\tname=pool-5b978f6f
\tip_address=192.168.64.217
\thw_address=1,32:17:ae:e0:8c:1a
\tidentifier=1,32:17:ae:e0:8c:1a
\tlease=0x6a0002da
}
`;
    const all = parseAllDhcpLeases(text);
    expect(all).toHaveLength(1);
    expect(all[0]!.mac).toBe("32:17:ae:e0:8c:1a");
  });

  test("extracts MAC for entries in 01,<mac> form (A.1.4.f)", () => {
    const text = `\
{
\tname=ethy
\tip_address=192.168.64.50
\thw_address=01,fe:e8:4c:5:f:9
\tidentifier=01,fe:e8:4c:5:f:9
\tlease=0x69fd6b0f
}
{
\tname=duidy
\tip_address=192.168.64.51
\thw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11:8e:d:cb:92:9e:9f:ce:2a
\tlease=0x69fd6ae3
}
`;
    const all = parseAllDhcpLeases(text);
    expect(all).toHaveLength(2);
    const ethy = all.find((e) => e.name === "ethy");
    const duidy = all.find((e) => e.name === "duidy");
    expect(ethy?.mac).toBe("fe:e8:4c:5:f:9");
    expect(duidy?.mac).toBeNull();
  });
});

describe("normalizeMac", () => {
  test("lowercases", () => {
    expect(normalizeMac("FE:E8:4C:5D:BF:B9")).toBe("fe:e8:4c:5d:bf:b9");
  });
  test("strips leading zeros per byte (Apple lease format)", () => {
    // Apple's lease file emits "01,fe:e8:4c:5:f:9" rather than
    // "01,fe:e8:4c:05:0f:09" for low-byte values.
    expect(normalizeMac("fe:e8:4c:05:0f:09")).toBe("fe:e8:4c:5:f:9");
    expect(normalizeMac("fe:e8:4c:5:f:9")).toBe("fe:e8:4c:5:f:9");
  });
  test("idempotent on already-normalized form", () => {
    expect(normalizeMac("fe:e8:4c:5d:bf:b9")).toBe("fe:e8:4c:5d:bf:b9");
  });
});

describe("parseDhcpLeasesForMac", () => {
  // Wells with `dhcp-identifier: mac` send their MAC as DHCP client-id;
  // vmnet records it as "01,<mac>" in hw_address.
  const MAC_LEASES = `\
{
\tname=any-hostname
\tip_address=192.168.64.20
\thw_address=01,fe:e8:4c:5d:bf:b9
\tidentifier=01,fe:e8:4c:5d:bf:b9
\tlease=0x69fea05c
}
{
\tname=other
\tip_address=192.168.64.21
\thw_address=01,aa:bb:cc:dd:ee:ff
\tlease=0x69fea05d
}
`;

  test("matches by MAC regardless of hostname", () => {
    // Cell may have boot-time hostname different from registry name.
    // MAC lookup is substrate-level — doesn't care.
    const entry = parseDhcpLeasesForMac(MAC_LEASES, "fe:e8:4c:5d:bf:b9");
    expect(entry?.ip).toBe("192.168.64.20");
  });

  test("returns null for unknown MAC", () => {
    expect(parseDhcpLeasesForMac(MAC_LEASES, "11:22:33:44:55:66")).toBeNull();
  });

  test("ignores DUID-format hw_address (ff,...) — not a MAC", () => {
    // Pre-MAC wells without dhcp-identifier: mac get DUID-encoded
    // client-ids; we deliberately don't try to derive a MAC from
    // those because the format is opaque and vendor-specific.
    const duidOnly = `\
{
\tname=cells-1
\tip_address=192.168.64.8
\thw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11:8e:d:cb:92:9e:9f:ce:2a
\tlease=0x69fea05c
}
`;
    expect(parseDhcpLeasesForMac(duidOnly, "fe:e8:4c:5d:bf:b9")).toBeNull();
  });

  test("normalizes both inputs (Apple's stripped-zero form vs full)", () => {
    const lease = `\
{
\tname=x
\tip_address=192.168.64.50
\thw_address=01,fe:e8:4c:5:f:9
\tlease=0x69fea05c
}
`;
    // Caller passes full-byte form; lease has stripped-zero form.
    expect(parseDhcpLeasesForMac(lease, "fe:e8:4c:05:0f:09")?.ip).toBe(
      "192.168.64.50",
    );
  });

  test("picks the entry with the highest lease for a recurring MAC", () => {
    const stale = `\
{
\tname=x
\tip_address=192.168.64.7
\thw_address=01,fe:e8:4c:5d:bf:b9
\tlease=0x69fe15c7
}
{
\tname=x
\tip_address=192.168.64.14
\thw_address=01,fe:e8:4c:5d:bf:b9
\tlease=0x69fe15d8
}
`;
    expect(parseDhcpLeasesForMac(stale, "fe:e8:4c:5d:bf:b9")?.ip).toBe(
      "192.168.64.14",
    );
  });

  test("skips blocks with neither name nor ip", () => {
    const text = `{\n\thw_address=ff:00:00\n}\n${SAMPLE}`;
    const all = parseAllDhcpLeases(text);
    expect(all).toHaveLength(2);
  });

  test("preserves entries with name but no ip (and vice-versa)", () => {
    const text = `{\n\tname=ghost\n\tlease=0x1\n}\n`;
    const all = parseAllDhcpLeases(text);
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("ghost");
    expect(all[0]!.ip).toBeNull();
  });
});

describe("findNewLeases", () => {
  // Substrate-level delta-snapshot lookup: any (ip, lease) that
  // wasn't in `before` is plausibly the new VM's lease — bypasses
  // hostname/DUID racing entirely.
  test("identifies a brand-new lease", () => {
    const before = parseAllDhcpLeases(`\
{
\tname=cells-1
\tip_address=192.168.64.8
\tlease=0x69fea05c
}
`);
    const after = parseAllDhcpLeases(`\
{
\tname=cells-1
\tip_address=192.168.64.8
\tlease=0x69fea05c
}
{
\tname=splites-base-mou0ctzh
\tip_address=192.168.64.6
\tlease=0x69ff0001
}
`);
    const fresh = findNewLeases(before, after);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.ip).toBe("192.168.64.6");
  });

  test("renewed lease (same ip, new epoch) counts as new", () => {
    // vmnet rewrites lease on every grant. A renewal of an existing
    // VM's lease produces (ip=same, lease=higher). For our use case
    // (create-time delta), this is fine: only our brand-new VM can
    // produce a fresh lease pair we didn't snapshot earlier.
    const before = [{ name: "x", ip: "192.168.64.8", lease: 100 }];
    const after = [{ name: "x", ip: "192.168.64.8", lease: 200 }];
    expect(findNewLeases(before, after)).toHaveLength(1);
  });

  test("empty before, anything after is new", () => {
    const after = parseAllDhcpLeases(`\
{
\tname=hib-verify
\tip_address=192.168.64.7
\tlease=0x69fea05c
}
`);
    expect(findNewLeases([], after)).toHaveLength(1);
  });

  test("identical before/after yields empty", () => {
    const snap = parseAllDhcpLeases(`\
{
\tname=x
\tip_address=192.168.64.8
\tlease=0x1
}
`);
    expect(findNewLeases(snap, snap)).toEqual([]);
  });

  test("concurrent creates: returns all new leases (caller picks newest)", () => {
    const before: any[] = [];
    const after = [
      { name: "a", ip: "192.168.64.8", lease: 100 },
      { name: "b", ip: "192.168.64.9", lease: 200 },
    ];
    expect(findNewLeases(before, after)).toHaveLength(2);
  });
});

describe("buildKnownLeaseNames", () => {
  test("includes operator-facing well names", () => {
    const known = buildKnownLeaseNames([{ name: "alpha" }, { name: "beta" }]);
    expect(known.has("alpha")).toBe(true);
    expect(known.has("beta")).toBe(true);
    expect(known.size).toBe(2);
  });

  test("includes lume_name for adopted wells (in addition to operator name)", () => {
    const known = buildKnownLeaseNames(
      [{ name: "myWell", lume_name: "pool-abc123" }],
    );
    expect(known.has("myWell")).toBe(true);
    expect(known.has("pool-abc123")).toBe(true);
    expect(known.size).toBe(2);
  });

  test("dedupes when a well's lume_name matches its operator name", () => {
    const known = buildKnownLeaseNames(
      [{ name: "shared", lume_name: "shared" }],
    );
    expect(known.size).toBe(1);
  });

  test("empty input returns empty set", () => {
    expect(buildKnownLeaseNames([]).size).toBe(0);
  });
});

describe("computeOrphanLeasesFrom", () => {
  const mkLease = (name: string | null, ip = "192.168.64.10"): LeaseSnapshot => ({
    name,
    ip,
    lease: 0,
    mac: null,
  });

  test("returns leases whose name isn't in the known set", () => {
    const leases = [mkLease("orphan-1"), mkLease("alive-well"), mkLease("orphan-2")];
    const known = new Set(["alive-well"]);
    const result = computeOrphanLeasesFrom(leases, known);
    expect(result.map((l) => l.name)).toEqual(["orphan-1", "orphan-2"]);
  });

  test("excludes null-named leases (DUID form — bootpd's own GC handles)", () => {
    const leases = [mkLease(null), mkLease("orphan-1"), mkLease(null)];
    const known = new Set<string>();
    const result = computeOrphanLeasesFrom(leases, known);
    expect(result.map((l) => l.name)).toEqual(["orphan-1"]);
  });

  test("adopted well lume_name in known set is NOT an orphan", () => {
    const leases = [mkLease("pool-abc")];
    const known = buildKnownLeaseNames(
      [{ name: "operator-name", lume_name: "pool-abc" }],
    );
    expect(computeOrphanLeasesFrom(leases, known)).toEqual([]);
  });

  test("empty leases returns empty array", () => {
    expect(computeOrphanLeasesFrom([], new Set(["x"]))).toEqual([]);
  });

  test("all-orphan case returns the full list", () => {
    const leases = [mkLease("a"), mkLease("b"), mkLease("c")];
    expect(computeOrphanLeasesFrom(leases, new Set())).toHaveLength(3);
  });
});
