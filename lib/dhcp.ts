// Read Apple's vmnet DHCP leases file. Lume's API leaves ipAddress null,
// so we discover well IPs by hostname here.

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

// Returns the newest lease entry for this hostname, or null if none.
// "Newest" = highest lease expiry; Apple's vmnet DHCP rewrites the
// expiry on every renewal/grant, so a fresh boot always produces a
// strictly higher value than a previous one.
export async function readDhcpLeaseEntry(hostname: string): Promise<LeaseEntry | null> {
  try {
    const text = await Bun.file(LEASES_PATH).text();
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

// Reverse lookup: which well owns this IP? Used by the metadata
// endpoint (/v1/cells/me/...) to identify the calling cell from its
// source IP. Returns null if no lease matches.
export async function findWellByIp(ip: string): Promise<string | null> {
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
