import { describe, expect, test } from "bun:test";
import { parseAllDhcpLeases, parseDhcpLeasesForHost } from "./dhcp.ts";

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
