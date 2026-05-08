import { describe, expect, test } from "bun:test";
import {
  buildDnsResponse,
  DNS_TTL_SECONDS,
  extractWellName,
  parseDnsQuery,
  resolveWellName,
} from "./dns.ts";

// Build a minimal DNS query packet for a single A question.
function makeQuery(qname: string, qtype = 1, qclass = 1): Uint8Array {
  const labels = qname.split(".");
  let qnameBytes = 0;
  for (const l of labels) qnameBytes += 1 + l.length;
  qnameBytes += 1;
  const buf = new Uint8Array(12 + qnameBytes + 4);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0x1234);
  view.setUint16(2, 0x0100);
  view.setUint16(4, 1);
  let p = 12;
  for (const l of labels) {
    buf[p] = l.length;
    for (let i = 0; i < l.length; i++) buf[p + 1 + i] = l.charCodeAt(i);
    p += 1 + l.length;
  }
  buf[p] = 0;
  p++;
  view.setUint16(p, qtype);
  view.setUint16(p + 2, qclass);
  return buf;
}

describe("parseDnsQuery", () => {
  test("parses A query for cells-3.well", () => {
    const buf = makeQuery("cells-3.well");
    const q = parseDnsQuery(buf);
    expect(q).not.toBeNull();
    expect(q!.id).toBe(0x1234);
    expect(q!.qname).toBe("cells-3.well");
    expect(q!.qtype).toBe(1);
    expect(q!.qclass).toBe(1);
  });

  test("returns null for truncated header", () => {
    expect(parseDnsQuery(new Uint8Array(5))).toBeNull();
  });

  test("returns null when qdcount != 1", () => {
    const buf = makeQuery("foo.well");
    const view = new DataView(buf.buffer);
    view.setUint16(4, 0);
    expect(parseDnsQuery(buf)).toBeNull();
  });

  test("rejects compression pointer in question name", () => {
    const buf = makeQuery("foo.well");
    // First label length byte → set top two bits to mark it as a pointer.
    buf[12] = 0xc0;
    expect(parseDnsQuery(buf)).toBeNull();
  });

  test("captures questionEnd offset for response builder", () => {
    const buf = makeQuery("a.well");
    const q = parseDnsQuery(buf)!;
    expect(q.questionEnd).toBe(buf.length);
  });
});

describe("buildDnsResponse", () => {
  test("NOERROR + A record when ip given", () => {
    const buf = makeQuery("pete.well");
    const q = parseDnsQuery(buf)!;
    const resp = buildDnsResponse(q, "192.168.64.7");

    const view = new DataView(resp.buffer);
    expect(view.getUint16(0)).toBe(0x1234);
    expect(view.getUint16(2)).toBe(0x8180);
    expect(view.getUint16(4)).toBe(1);
    expect(view.getUint16(6)).toBe(1);

    // Answer section starts at q.questionEnd. First two bytes are the
    // compression pointer to offset 12 (start of question name).
    let p = q.questionEnd;
    expect(view.getUint16(p)).toBe(0xc00c);
    p += 2;
    expect(view.getUint16(p)).toBe(1);
    p += 2;
    expect(view.getUint16(p)).toBe(1);
    p += 2;
    expect(view.getUint32(p)).toBe(DNS_TTL_SECONDS);
    p += 4;
    expect(view.getUint16(p)).toBe(4);
    p += 2;
    expect(resp[p]).toBe(192);
    expect(resp[p + 1]).toBe(168);
    expect(resp[p + 2]).toBe(64);
    expect(resp[p + 3]).toBe(7);
  });

  test("NXDOMAIN when ip is null", () => {
    const buf = makeQuery("ghost.well");
    const q = parseDnsQuery(buf)!;
    const resp = buildDnsResponse(q, null);

    const view = new DataView(resp.buffer);
    // RCODE=3 (NXDOMAIN) in the low nibble of the flags second byte.
    expect(view.getUint16(2) & 0x000f).toBe(3);
    expect(view.getUint16(4)).toBe(1);
    expect(view.getUint16(6)).toBe(0);
    // No answer appended.
    expect(resp.length).toBe(q.questionEnd);
  });

  test("preserves transaction id from query", () => {
    const buf = makeQuery("x.well");
    const view = new DataView(buf.buffer);
    view.setUint16(0, 0xbeef);
    const q = parseDnsQuery(buf)!;
    const resp = buildDnsResponse(q, "10.0.0.1");
    expect(new DataView(resp.buffer).getUint16(0)).toBe(0xbeef);
  });
});

describe("extractWellName", () => {
  test("strips .well suffix", () => {
    expect(extractWellName("cells-3.well")).toBe("cells-3");
    expect(extractWellName("Pete.well")).toBe("pete");
  });

  test("returns null for non-.well names", () => {
    expect(extractWellName("google.com")).toBeNull();
    expect(extractWellName("well")).toBeNull();
  });

  test("returns null for bare .well", () => {
    expect(extractWellName(".well")).toBeNull();
  });
});

describe("resolveWellName", () => {
  test("returns lease IP for registered well", async () => {
    const ip = await resolveWellName("pete.well", {
      listWells: async () => [{ name: "pete" } as any],
      readDhcpLease: async (n) => (n === "pete" ? "192.168.64.7" : null),
    });
    expect(ip).toBe("192.168.64.7");
  });

  test("returns null for unregistered name", async () => {
    const ip = await resolveWellName("ghost.well", {
      listWells: async () => [{ name: "pete" } as any],
      readDhcpLease: async () => "192.168.64.99",
    });
    expect(ip).toBeNull();
  });

  test("returns null for non-.well zone", async () => {
    const ip = await resolveWellName("pete.com", {
      listWells: async () => [{ name: "pete" } as any],
      readDhcpLease: async () => "192.168.64.7",
    });
    expect(ip).toBeNull();
  });

  test("returns null when registered well has no lease", async () => {
    const ip = await resolveWellName("pete.well", {
      listWells: async () => [{ name: "pete" } as any],
      readDhcpLease: async () => null,
    });
    expect(ip).toBeNull();
  });
});
