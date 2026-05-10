// Read Apple's vmnet DHCP leases file. Lume's API leaves ipAddress null,
// so we discover well IPs from /var/db/dhcpd_leases.
//
// Lookup order, most-substrate to least:
//   1. Registry's pinned_ip (Lever 3) — bypasses DHCP entirely.
//   2. Lease whose hw_address matches the well's MAC. Wells with
//      `dhcp-identifier: mac` in their netplan (B.0.8.e onward)
//      send the MAC as the DHCP client-id, recorded by vmnet as
//      "01,<mac>" in hw_address. Substrate-level identity that
//      doesn't depend on cloud-init hostname.
//   3. Lease whose name= field equals the hostname. Fallback for
//      pre-MAC wells (cells-1..5) and for cases where the guest
//      hasn't applied the new netplan yet.

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

// Pure parser — find the newest lease whose hw_address encodes the
// given MAC. vmnet records the DHCP client-identifier verbatim; with
// `dhcp-identifier: mac` set in netplan, that's "01,<mac-bytes>"
// (type 0x01 = ethernet hardware addr, RFC 2132 §9.14).
//
// MAC normalization: lowercase, strip leading zeros per byte, colon-
// separated. Apple's lease file emits "01,fe:e8:4c:5d:bf:b9" — the
// guest's actual MAC is lume's config.json `macAddress` field
// formatted the same way.
export function parseDhcpLeasesForMac(
  text: string,
  mac: string,
): LeaseEntry | null {
  const normalized = normalizeMac(mac);
  let best: LeaseEntry | null = null;
  for (const block of text.split("}")) {
    const hwMatch = block.match(/hw_address=0?1,([0-9a-f:]+)/i);
    if (!hwMatch) continue;
    if (normalizeMac(hwMatch[1]!) !== normalized) continue;
    const ipMatch = block.match(/ip_address=(\S+)/);
    if (!ipMatch) continue;
    const leaseMatch = block.match(/lease=0x([0-9a-f]+)/);
    const lease = leaseMatch ? parseInt(leaseMatch[1]!, 16) : 0;
    if (!best || lease > best.lease) {
      best = { ip: ipMatch[1]!, lease };
    }
  }
  return best;
}

// "fe:e8:4c:5d:bf:b9" or "FE:E8:4C:05:0B:09" → "fe:e8:4c:5d:bf:b9".
// Lowercase, strips leading zeros per byte. Apple's lease file emits
// the latter form (single-digit bytes when 0x0X); standard MAC
// representations vary.
export function normalizeMac(mac: string): string {
  return mac
    .toLowerCase()
    .split(":")
    .map((b) => parseInt(b, 16).toString(16))
    .join(":");
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

// Returns the newest lease entry for this MAC, or null if none.
export async function readDhcpLeaseByMac(mac: string): Promise<LeaseEntry | null> {
  try {
    const text = await Bun.file(LEASES_PATH).text();
    return parseDhcpLeasesForMac(text, mac);
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
  // MAC address (lowercase, normalized) when the lease's hw_address
  // is in the `01,<mac>` form (DHCP client-id type 0x01 = ethernet HW
  // addr). Null for non-ethernet lease formats (e.g., the older
  // `ff,...` DUID form pre-A.1.4.f). Carried in LeaseSnapshot so
  // `waitForDhcpLease` can constrain its delta-snapshot lookup to a
  // specific MAC — otherwise a lease renewed between the pre-boot
  // snapshot and the in-loop snapshot looks like a "new" lease and
  // the fresh boot wrongly inherits another VM's IP. Surfaced by
  // smoke-pool-adopt's cold-fallback (3rd cycle after pool consume).
  mac: string | null;
}

export function parseAllDhcpLeases(text: string): LeaseSnapshot[] {
  const out: LeaseSnapshot[] = [];
  for (const block of text.split("}")) {
    const nameMatch = block.match(/name=(\S+)/);
    const ipMatch = block.match(/ip_address=(\S+)/);
    const leaseMatch = block.match(/lease=0x([0-9a-f]+)/);
    const macMatch = block.match(/hw_address=0?1,([0-9a-f:]+)/i);
    if (!nameMatch && !ipMatch) continue;
    out.push({
      name: nameMatch?.[1] ?? null,
      ip: ipMatch?.[1] ?? null,
      lease: leaseMatch ? parseInt(leaseMatch[1]!, 16) : 0,
      mac: macMatch ? normalizeMac(macMatch[1]!) : null,
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

// Pure: given the leases-file content as it looked BEFORE a VM
// started + a fresh snapshot, return entries that didn't exist
// before. Substrate-level identity that doesn't depend on cloud-init
// hostname OR DHCP client-id format. The new lease that appears
// after a VM boot IS that VM's lease, regardless of what hostname or
// DUID it sent. Concurrent creates produce >1 result; caller picks
// the most-recent (highest lease expiry).
//
// Comparison key is (ip, lease) — vmnet rewrites the lease epoch on
// every grant/renewal, so a renewed-existing-VM lease shows up as
// "different" too. That's actually fine for the create-time use:
// the renewal can only fire for a VM that already had a lease, and
// our VM didn't have one (it just booted). Any (ip, lease) pair
// not in `before` is plausibly ours.
export function findNewLeases(
  before: LeaseSnapshot[],
  after: LeaseSnapshot[],
): LeaseSnapshot[] {
  const beforeKeys = new Set(before.map((b) => `${b.ip}|${b.lease}`));
  return after.filter((a) => !beforeKeys.has(`${a.ip}|${a.lease}`));
}

// Resolve a well's IP. Lookup order (substrate-most first):
//   1. registry pinned_ip — bypasses DHCP entirely (Lever 3).
//   2. lease by MAC — substrate-level identity, doesn't depend on
//      cloud-init hostname (B.0.8.e). Only available for wells
//      created with `dhcp-identifier: mac` in their netplan AND
//      whose `mac_address` is recorded in the registry.
//   3. lease by hostname — fallback for pre-MAC wells.
//
// Used by daemon HTTP / WS handlers, lifecycle ops, bridge DNS, and
// the wake path. All call sites should go through this helper rather
// than readDhcpLease directly so pinned + MAC-tracked wells are
// first-class.
export async function resolveWellIp(name: string): Promise<string | null> {
  const record = await findWell(name);
  if (record?.pinned_ip) return record.pinned_ip;
  if (record?.mac_address) {
    const byMac = await readDhcpLeaseByMac(record.mac_address);
    if (byMac) return byMac.ip;
  }
  return await readDhcpLease(name);
}

// Reverse lookup: which well owns this IP? Used by the metadata
// endpoint (/v1/cells/me/...) to identify the calling cell from its
// source IP. Lookup order:
//   1. registry pinned_ip — exact match.
//   2. registry mac_address vs lease's hw_address with that IP —
//      substrate-level cross-check.
//   3. lease's name= field — fallback for pre-MAC wells.
export async function findWellByIp(ip: string): Promise<string | null> {
  const records = await listWells();
  const pinned = records.find((r) => r.pinned_ip === ip);
  if (pinned) return pinned.name;
  let leaseText = "";
  try {
    leaseText = await Bun.file(LEASES_PATH).text();
  } catch {
    return null;
  }
  // 2. MAC cross-check: find the lease for this IP, see if its
  // hw_address (when 01,<mac>) matches a registered well's MAC.
  const macForIp = extractMacForIp(leaseText, ip);
  if (macForIp) {
    const normalized = normalizeMac(macForIp);
    const byMac = records.find(
      (r) => r.mac_address && normalizeMac(r.mac_address) === normalized,
    );
    if (byMac) return byMac.name;
  }
  // 3. hostname fallback: lease's name= field.
  let bestName: string | null = null;
  let bestLease = -1;
  for (const block of leaseText.split("}")) {
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
}

function extractMacForIp(text: string, ip: string): string | null {
  for (const block of text.split("}")) {
    const ipMatch = block.match(/ip_address=(\S+)/);
    if (ipMatch?.[1] !== ip) continue;
    const hwMatch = block.match(/hw_address=0?1,([0-9a-f:]+)/i);
    if (hwMatch) return hwMatch[1]!;
  }
  return null;
}
