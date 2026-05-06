// Read Apple's vmnet DHCP leases file. Lume's API leaves ipAddress null,
// so we discover splite IPs by hostname here.

const LEASES_PATH = "/var/db/dhcpd_leases";

export async function readDhcpLease(hostname: string): Promise<string | null> {
  try {
    const text = await Bun.file(LEASES_PATH).text();
    let bestIp: string | null = null;
    let bestLease = -1;
    for (const block of text.split("}")) {
      const nameMatch = block.match(/name=(\S+)/);
      if (nameMatch?.[1] !== hostname) continue;
      const ipMatch = block.match(/ip_address=(\S+)/);
      const leaseMatch = block.match(/lease=0x([0-9a-f]+)/);
      if (!ipMatch) continue;
      const lease = leaseMatch ? parseInt(leaseMatch[1]!, 16) : 0;
      if (lease > bestLease) {
        bestLease = lease;
        bestIp = ipMatch[1]!;
      }
    }
    return bestIp;
  } catch {
    return null;
  }
}
