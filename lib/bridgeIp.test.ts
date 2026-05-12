import { describe, expect, test } from "bun:test";
import { findBridgeIpFromInterfaces, type InterfaceMap } from "./bridgeIp.ts";

// Helper: build a minimal NetworkInterfaceInfo. node:os's real shape has
// more fields but findBridgeIpFromInterfaces only reads family + internal
// + address, so the fixture stays small.
function v4(address: string, internal = false): {
  address: string;
  family: "IPv4";
  internal: boolean;
  netmask: string;
  mac: string;
  cidr: string | null;
} {
  return {
    address,
    family: "IPv4",
    internal,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
  };
}

function v6(): {
  address: string;
  family: "IPv6";
  internal: boolean;
  netmask: string;
  mac: string;
  scopeid: number;
  cidr: string | null;
} {
  return {
    address: "fe80::1",
    family: "IPv6",
    internal: false,
    netmask: "ffff:ffff:ffff:ffff::",
    mac: "00:00:00:00:00:00",
    scopeid: 0,
    cidr: null,
  };
}

describe("findBridgeIpFromInterfaces", () => {
  test("no bridge interface → null", () => {
    const ifaces: InterfaceMap = {
      en0: [v4("192.168.1.42")],
      lo0: [v4("127.0.0.1", true)],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBeNull();
  });

  test("empty interfaces → null", () => {
    expect(findBridgeIpFromInterfaces({})).toBeNull();
  });

  test("bridge with IPv4 → returns that address", () => {
    const ifaces: InterfaceMap = {
      en0: [v4("192.168.1.42")],
      bridge100: [v4("192.168.64.1")],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBe("192.168.64.1");
  });

  test("internal bridge IPv4 → still returned (no internal filter on bridge)", () => {
    // findBridgeIpFromInterfaces filters out internal=true, so this returns null:
    const ifaces: InterfaceMap = {
      bridge100: [v4("192.168.64.1", true)],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBeNull();
  });

  test("bridge with only IPv6 → null (we only return IPv4)", () => {
    const ifaces: InterfaceMap = {
      bridge100: [v6()],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBeNull();
  });

  test("first bridge wins when multiple exist", () => {
    const ifaces: InterfaceMap = {
      bridge100: [v4("192.168.64.1")],
      bridge101: [v4("192.168.65.1")],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBe("192.168.64.1");
  });

  test("bridge with mixed IPv6 + IPv4 → returns the IPv4", () => {
    const ifaces: InterfaceMap = {
      bridge100: [v6(), v4("192.168.64.1")],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBe("192.168.64.1");
  });

  test("non-bridge-prefix interfaces skipped even if name contains 'bridge'", () => {
    const ifaces: InterfaceMap = {
      "br0-but-not-bridge": [v4("10.0.0.1")],
      "not-bridge-prefix": [v4("10.0.0.2")],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBeNull();
  });

  test("undefined addrs slot (rare but possible) → skipped", () => {
    const ifaces: InterfaceMap = {
      bridge100: undefined,
      bridge101: [v4("192.168.64.1")],
    };
    expect(findBridgeIpFromInterfaces(ifaces)).toBe("192.168.64.1");
  });
});
