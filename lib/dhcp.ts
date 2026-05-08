// Read Apple's vmnet DHCP leases file. Lume's API leaves ipAddress null,
// so we discover well IPs by hostname here.
//
// New wells get a static IP via the pinned_ip field on the registry
// record (Lever 3); resolveWellIp prefers that over a DHCP lookup.

import { findWell, listWells } from "./registry.ts";

const LEASES_PATH = "/var/db/dhcpd_leases";

export async function readDhcpLease(hostname: string): Promise<string | null> {
  const entry = await readDhcpLeaseEntry(hostname);
  return entry?.ip ?? null;
}

export interface LeaseEntry {
  ip: string;
  // Unix epoch seconds at which the lease expires. Newer entries for
  // the same hostname have higher values; we use this to distinguish
  // a fresh lease (post-boot) from a stale one (pre-stop) when both
  // appear in the file simultaneously.
  lease: number;
}

// Pure parser — exported for tests. Walks the leases file text, returns
// the newest LeaseEntry for the given hostname or null. "Newest" = highest
// lease expiry; Apple's vmnet DHCP rewrites the expiry on every
// renewal/grant, so a fresh boot always produces a strictly higher value
// than a previous one.
export function parseDhcpLeasesForHost(
  text: string,
  hostname: string,
): LeaseEntry | null {
  let best: LeaseEntry | null = null;
  for (const block of text.split("}")) {
    const nameMatch = block.match(/name=(\S+)/);
    if (nameMatch?.[1] !== hostname) continue;
    const ipMatch = block.match(/ip_address=(\S+)/);
    const leaseMatch = block.match(/lease=0x([0-9a-f]+)/);
    if (!ipMatch) continue;
    const lease = leaseMatch ? parseInt(leaseMatch[1]!, 16) : 0;
    if (!best || lease > best.lease) {
      best = { ip: ipMatch[1]!, lease };
    }
  }
  return best;
}

// Returns the newest lease entry for this hostname, or null if none.
export async function readDhcpLeaseEntry(hostname: string): Promise<LeaseEntry | null> {
  try {
    const text = await Bun.file(LEASES_PATH).text();
    return parseDhcpLeasesForHost(text, hostname);
  } catch {
    return null;
  }
}

// Wait until we see a lease whose expiry is strictly greater than
// `since`. Use case: after stopping a well and starting it again,
// the leases file still contains the pre-stop entry until vmnet
// writes the new one. A bare readDhcpLease() returns the stale IP;
// this helper waits for the file to reflect the new boot.
export async function waitForNewerLease(
  hostname: string,
  since: number,
  timeoutMs: number,
): Promise<LeaseEntry | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await readDhcpLeaseEntry(hostname);
    if (entry && entry.lease > since) return entry;
    await Bun.sleep(500);
  }
  return null;
}

// Diagnostic dump — every entry in the leases file. Used by createWell's
// timeout path to surface "what hostname IS DHCP serving?" without
// needing the operator to cat /var/db/dhcpd_leases by hand. Recent
// entries first.
export interface LeaseSnapshot {
  name: string | null;
  ip: string | null;
  lease: number;
}

export function parseAllDhcpLeases(text: string): LeaseSnapshot[] {
  const out: LeaseSnapshot[] = [];
  for (const block of text.split("}")) {
    const nameMatch = block.match(/name=(\S+)/);
    const ipMatch = block.match(/ip_address=(\S+)/);
    const leaseMatch = block.match(/lease=0x([0-9a-f]+)/);
    if (!nameMatch && !ipMatch) continue;
    out.push({
      name: nameMatch?.[1] ?? null,
      ip: ipMatch?.[1] ?? null,
      lease: leaseMatch ? parseInt(leaseMatch[1]!, 16) : 0,
    });
  }
  out.sort((a, b) => b.lease - a.lease);
  return out;
}

export async function dumpDhcpLeases(): Promise<LeaseSnapshot[]> {
  try {
    const text = await Bun.file(LEASES_PATH).text();
    return parseAllDhcpLeases(text);
  } catch {
    return [];
  }
}

// Resolve a well's IP. Prefers the registry's pinned_ip (Lever 3,
// stable across reboots) over the host's DHCP leases file. Old wells
// without pinned_ip fall through to the lease lookup.
//
// Used by daemon HTTP / WS handlers, lifecycle ops, bridge DNS, and
// the wake path. All call sites should go through this helper rather
// than readDhcpLease directly so pinned wells are first-class.
export async function resolveWellIp(name: string): Promise<string | null> {
  const record = await findWell(name);
  if (record?.pinned_ip) return record.pinned_ip;
  return await readDhcpLease(name);
}

// Reverse lookup: which well owns this IP? Used by the metadata
// endpoint (/v1/cells/me/...) to identify the calling cell from its
// source IP. Checks pinned_ip first (registry, authoritative) and
// falls back to the DHCP leases file for older un-pinned wells.
export async function findWellByIp(ip: string): Promise<string | null> {
  const records = await listWells();
  const pinned = records.find((r) => r.pinned_ip === ip);
  if (pinned) return pinned.name;
  try {
    const text = await Bun.file(LEASES_PATH).text();
    let bestName: string | null = null;
    let bestLease = -1;
    for (const block of text.split("}")) {
      const ipMatch = block.match(/ip_address=(\S+)/);
      if (ipMatch?.[1] !== ip) continue;
      const nameMatch = block.match(/name=(\S+)/);
      const leaseMatch = block.match(/lease=0x([0-9a-f]+)/);
      if (!nameMatch) continue;
      const lease = leaseMatch ? parseInt(leaseMatch[1]!, 16) : 0;
      if (lease > bestLease) {
        bestLease = lease;
        bestName = nameMatch[1]!;
      }
    }
    return bestName;
  } catch {
    return null;
  }
}
