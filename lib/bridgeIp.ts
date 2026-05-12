// Find the macOS vmnet bridge's host-side IPv4 address. The metadata
// server + bridge DNS bind to this IP so guests can reach them at
// `host.well` (resolved via bridge DNS) or via the gateway IP directly.
//
// Walks node:os network interfaces, picks the first one whose name
// starts with "bridge" and has a non-internal IPv4 address. Returns
// null if no such interface exists (no VMs have ever started → no
// bridge), in which case welld skips the metadata server but the rest
// keeps working.

import type { NetworkInterfaceInfo } from "node:os";

export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function findBridgeIpFromInterfaces(ifaces: InterfaceMap): string | null {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!name.startsWith("bridge") || !addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}
