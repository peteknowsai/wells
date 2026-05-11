import { describe, expect, test } from "bun:test";
import { publishLease, releaseLease } from "./dhcpHelper.ts";

// dhcpHelper.ts shells out to a privileged helper at
// /usr/local/sbin/welld-dhcp-helper. The helper IS installed in
// production (via scripts/install-dhcp-helper.sh) but isn't in CI.
// Tests cover the not-installed + invalid-arg branches without
// requiring the helper to exist.
//
// (Live-verified behavior — installed-and-working — is covered by
// the destroyWell integration smoke, not here.)

describe("dhcpHelper — argument validation", () => {
  test("rejects empty hostname", async () => {
    const r = await releaseLease("");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects hostname with shell metacharacters", async () => {
    const r = await releaseLease("foo; rm -rf /");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects hostname starting with hyphen (flag-injection defense)", async () => {
    const r = await releaseLease("-rf");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects hostname with underscore (RFC1123 + matches NAME_RE)", async () => {
    const r = await releaseLease("foo_bar");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects hostname over 63 chars", async () => {
    const r = await releaseLease("a".repeat(64));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("accepts valid hostnames as far as argument validation goes (then helper-not-installed path)", async () => {
    // In CI / fresh dev box the helper isn't installed, so we get
    // not-installed or exit-nonzero. Either way it's NOT invalid-arg.
    const r = await releaseLease("valid-name-123");
    expect(r.reason).not.toBe("invalid-arg");
  });
});

describe("dhcpHelper — not-installed path", () => {
  test("releaseLease when helper absent returns ok:false with a reason", async () => {
    const r = await releaseLease("valid-name-123");
    // Don't pin the specific reason — install state varies between
    // operator machines. Pin that the wrapper handles absence
    // gracefully (doesn't throw).
    if (!r.ok) {
      expect(["not-installed", "exec-failed", "exit-nonzero"]).toContain(r.reason);
    }
  });
});

describe("publishLease — argument validation (W.68)", () => {
  const validMac = "fe:e8:4c:5d:bf:b9";
  const validIp = "192.168.64.10";

  test("rejects invalid hostname", async () => {
    const r = await publishLease("bad name", validIp, validMac);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects empty hostname", async () => {
    const r = await publishLease("", validIp, validMac);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects malformed IPv4 (not enough octets)", async () => {
    const r = await publishLease("valid-name", "192.168.64", validMac);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects IPv4 with out-of-range octet", async () => {
    const r = await publishLease("valid-name", "192.168.64.999", validMac);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects IPv4 with letters", async () => {
    const r = await publishLease("valid-name", "192.168.abc.1", validMac);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects malformed MAC", async () => {
    const r = await publishLease("valid-name", validIp, "not-a-mac");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });

  test("rejects MAC with wrong number of bytes", async () => {
    const r = await publishLease("valid-name", validIp, "aa:bb:cc:dd:ee");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-arg");
  });
});
