// Pinned per-well IP allocation. Welld owns the upper half of the vmnet
// /24 (192.168.64.100-249); each new well gets the lowest unused IP in
// that range. The cell's cidata writes a static netplan with that IP,
// so the cell never goes through DHCP. Stable connection strings: a
// well's IP is the same after stop/start/restore.
//
// Range choice: bootpd's pool starts at .2 and works up; pinning .100+
// keeps us out of its way for typical Mac-mini fleet sizes (Pete's
// running 5 cells today, plenty of headroom). 150 slots is enough until
// we move to multi-Lab Colony (Phase D).
//
// Skips any IP currently held by a DHCP lease (live or stale) AND any
// IP already pinned by another well. Both must be excluded — pinned
// IPs aren't visible to bootpd, so a stale dhcp-lease entry on the
// host could otherwise collide with a fresh pin.

import { listWells } from "./registry.ts";
import { dumpDhcpLeases } from "./dhcp.ts";

const SUBNET_PREFIX = "192.168.64.";
export const PIN_RANGE_START = 100;
export const PIN_RANGE_END = 249;

export function allocatePinnedIp(taken: Iterable<string>): string | null {
  const takenSet = new Set(taken);
  for (let i = PIN_RANGE_START; i <= PIN_RANGE_END; i++) {
    const ip = `${SUBNET_PREFIX}${i}`;
    if (!takenSet.has(ip)) return ip;
  }
  return null;
}

export async function nextPinnedIp(): Promise<string | null> {
  const records = await listWells();
  const leases = await dumpDhcpLeases();
  const taken = new Set<string>();
  for (const r of records) {
    if (r.pinned_ip) taken.add(r.pinned_ip);
  }
  for (const l of leases) {
    if (l.ip) taken.add(l.ip);
  }
  return allocatePinnedIp(taken);
}
