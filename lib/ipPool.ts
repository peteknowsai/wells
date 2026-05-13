// W.72 — static IP allocator. Welld picks an IP from a managed range
// at create time, writes it via cidata netplan (well-firstboot.sh in
// the base image consumes WELL_STATIC_IP_CIDR), bootpd is bypassed.
//
// Why: macOS bootpd races above ~4 concurrent DHCP grants and the
// substrate occasionally leaks lease entries that never garbage-
// collect. Both classes of failure go away when welld owns the IP
// before the VM boots. See docs/proposals/static-ip-allocation.html.
//
// Layout:
//   - `parseRange(s)` — parse "200-250" or "192.168.64.200-250" forms.
//   - `allocateInRange(range, taken)` — pure: lowest free in range.
//   - `loadStaticRange()` — read defaults.static_ip_range (or default).
//   - `currentlyTakenIps()` — async: registry pinned IPs + DHCP leases.
//   - `nextStaticIp()` — convenience that composes the three above.
//
// The allocator runs inside a single welld process; concurrent create
// calls hit `nextStaticIp` serialized by an in-process mutex so two
// wells can't grab the same .NNN. Cross-process safety is not in
// scope (welld is the single owner; multi-welld is a future design).

import { listWells } from "./registry.ts";
import { dumpDhcpLeases } from "./dhcp.ts";
import { loadDefaults } from "./defaults.ts";

export const SUBNET_PREFIX = "192.168.64.";
export const DEFAULT_STATIC_RANGE_START = 200;
export const DEFAULT_STATIC_RANGE_END = 250;
export const DEFAULT_GATEWAY = "192.168.64.1";
export const DEFAULT_CIDR_PREFIX = 24;

export interface IpRange {
  start: number;
  end: number;
}

// Parse a range string. Accepted forms:
//   "200-250"
//   "192.168.64.200-250"
//   "192.168.64.200-192.168.64.250"
// Throws if malformed, out-of-octet, or empty range. Strict: we'd
// rather refuse a typo at startup than silently allocate garbage.
export function parseRange(s: string): IpRange {
  const trimmed = s.trim();
  if (!trimmed) throw new Error("empty range");
  const parts = trimmed.split("-").map((p) => p.trim());
  if (parts.length !== 2) {
    throw new Error(`range must be "start-end": ${s}`);
  }
  const [rawStart, rawEnd] = parts;
  const start = parseEndpoint(rawStart!);
  const end = parseEndpoint(rawEnd!);
  if (start > end) throw new Error(`range start>end: ${s}`);
  if (start < 1 || end > 254) {
    throw new Error(`range outside 192.168.64.1-254: ${s}`);
  }
  return { start, end };
}

function parseEndpoint(s: string): number {
  // "192.168.64.200" → 200; "200" → 200
  const last = s.includes(".") ? s.split(".").pop()! : s;
  if (!/^[0-9]+$/.test(last)) {
    throw new Error(`endpoint not numeric: ${s}`);
  }
  const n = Number(last);
  if (s.includes(".")) {
    const expected = `${SUBNET_PREFIX}${last}`;
    if (s !== expected) {
      throw new Error(`endpoint must be in 192.168.64.0/24: ${s}`);
    }
  }
  return n;
}

// Pure: pick the lowest IP in `range` not present in `taken`. Returns
// null when the range is exhausted. Caller is responsible for the
// taken-set (registry + live leases).
export function allocateInRange(
  range: IpRange,
  taken: Iterable<string>,
): string | null {
  const set = new Set(taken);
  for (let i = range.start; i <= range.end; i++) {
    const ip = `${SUBNET_PREFIX}${i}`;
    if (!set.has(ip)) return ip;
  }
  return null;
}

// Default range + the operator override path. Returns null when the
// operator explicitly disabled static allocation (defaults.static_ip_range
// = null) — caller should fall back to DHCP in that case.
export async function loadStaticRange(): Promise<IpRange | null> {
  const d = await loadDefaults();
  if (d.static_ip_range == null) return null;
  return parseRange(d.static_ip_range);
}

// Compute the live set of IPs we must not allocate over: every
// registered well's pinned_ip + every entry in /var/db/dhcpd_leases.
// Including DHCP leases is defensive — if welld bootstrap is mixed
// with legacy DHCP wells, we don't want to collide with a live lease
// that bootpd handed out.
export async function currentlyTakenIps(): Promise<Set<string>> {
  const [records, leases] = await Promise.all([
    listWells(),
    dumpDhcpLeases().catch(() => [] as { ip: string }[]),
  ]);
  const taken = new Set<string>();
  for (const r of records) if (r.pinned_ip) taken.add(r.pinned_ip);
  for (const l of leases) if (l.ip) taken.add(l.ip);
  return taken;
}

// In-process serialization. Two concurrent createWell calls would
// otherwise see the same registry snapshot and pick the same IP. The
// mutex is async-aware: each caller awaits its turn before reading.
let mutex: Promise<unknown> = Promise.resolve();

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mutex;
  let release: (v: unknown) => void = () => {};
  mutex = new Promise((res) => (release = res));
  try {
    await prev;
    return await fn();
  } finally {
    release(undefined);
  }
}

// Convenience: allocate the next static IP using the operator's
// configured range and the live taken-set. Returns null if the range
// is disabled (operator chose DHCP) OR exhausted — the call site must
// distinguish via a separate `loadStaticRange()` check if it needs to.
export async function nextStaticIp(): Promise<string | null> {
  return withMutex(async () => {
    const range = await loadStaticRange();
    if (!range) return null;
    const taken = await currentlyTakenIps();
    return allocateInRange(range, taken);
  });
}

// Test seam: reset the mutex (so back-to-back test runs don't inherit
// a still-pending lock from a hung previous test). Not for prod use.
export function _resetIpPoolMutexForTests(): void {
  mutex = Promise.resolve();
}

// macOS's bootpd configuration. When present, the file describes which
// IP range bootpd hands out via DHCP. Welld's static range MUST NOT
// overlap with it — overlapping would let bootpd grant an IP from
// inside our static pool, racing with our own allocations.
//
// When the file is absent (Apple's default vmnet config, no operator
// edits), bootpd behaves per its built-in defaults — typically
// .2-.150 within 192.168.64.0/24, with no public commitment. The
// /Library/Preferences path is the only stable source of truth, so
// we can't precisely model the default. In that case, callers should
// trust the configured static range (.200-.250 by default sits well
// clear of bootpd's grant pattern) and log an advisory.
export const BOOTPD_PLIST = "/Library/Preferences/SystemConfiguration/bootpd.plist";

// Parse the bootpd plist into a static range. The format is the
// XML/binary plist Apple ships with `bootpd`; we convert to JSON via
// `plutil` and pluck out the first Subnet that targets 192.168.64.0/24.
// Returns null if the file is absent (Apple defaults — caller decides
// what to do) or unparseable.
export async function readBootpdRange(
  path: string = BOOTPD_PLIST,
): Promise<IpRange | null> {
  if (!Bun.file(path).size) return null;
  try {
    const proc = Bun.spawn(["plutil", "-convert", "json", "-o", "-", path], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const data = JSON.parse(text) as { Subnets?: Array<Record<string, unknown>> };
    const subnets = Array.isArray(data?.Subnets) ? data.Subnets : [];
    for (const s of subnets) {
      const netAddr = s.net_address as string | undefined;
      if (netAddr && !netAddr.startsWith("192.168.64.")) continue;
      const range = s.net_range as unknown;
      if (Array.isArray(range) && range.length === 2) {
        const start = parseEndpointSafe(range[0]);
        const end = parseEndpointSafe(range[1]);
        if (start != null && end != null) return { start, end };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseEndpointSafe(v: unknown): number | null {
  if (typeof v !== "string") return null;
  if (!v.startsWith(SUBNET_PREFIX)) return null;
  const last = v.slice(SUBNET_PREFIX.length);
  if (!/^[0-9]+$/.test(last)) return null;
  const n = Number(last);
  if (n < 0 || n > 255) return null;
  return n;
}

export interface RangeOverlapResult {
  overlap: boolean;
  reason?: string;
}

// Pure: do two ranges share any IP?
export function rangesOverlap(a: IpRange, b: IpRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

// Startup gate. Given our configured static range, walk bootpd's
// declared range (if any) and complain on overlap. Returns a result
// object so the caller can decide whether to refuse to start or log.
export async function checkBootpdOverlap(
  staticRange: IpRange,
  bootpdPath: string = BOOTPD_PLIST,
): Promise<RangeOverlapResult> {
  const bootpd = await readBootpdRange(bootpdPath);
  if (!bootpd) {
    return {
      overlap: false,
      reason: "bootpd.plist absent (Apple default vmnet config)",
    };
  }
  if (rangesOverlap(staticRange, bootpd)) {
    return {
      overlap: true,
      reason: `static range ${SUBNET_PREFIX}${staticRange.start}-${staticRange.end} overlaps bootpd grant range ${SUBNET_PREFIX}${bootpd.start}-${bootpd.end}`,
    };
  }
  return {
    overlap: false,
    reason: `bootpd grant range ${SUBNET_PREFIX}${bootpd.start}-${bootpd.end} disjoint from static ${SUBNET_PREFIX}${staticRange.start}-${staticRange.end}`,
  };
}
