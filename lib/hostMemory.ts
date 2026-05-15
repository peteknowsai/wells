// Host memory snapshot for the dashboard. Mac-specific (sysctl + vm_stat).
//
// "memory_used_bytes" follows Activity Monitor's convention:
//   used = (active + wired + compressed) * page_size
// i.e. RAM that's actually in physical residency under pressure.
//
// "memory_total_bytes" is the kernel's view (`hw.memsize`).
//
// Both reads are cheap (~ms). Called once per /dashboard/data; no caching.
// Failures degrade to null rather than throw — the dashboard is observability,
// not a control surface, so a missing host metric shouldn't error the daemon.

export interface HostMemorySnapshot {
  memory_total_bytes: number | null;
  memory_used_bytes: number | null;
}

export async function readHostMemory(): Promise<HostMemorySnapshot> {
  const [total, used] = await Promise.all([readTotal(), readUsed()]);
  return { memory_total_bytes: total, memory_used_bytes: used };
}

async function readTotal(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["sysctl", "-n", "hw.memsize"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0) return null;
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function readUsed(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["vm_stat"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return parseVmStat(text);
  } catch {
    return null;
  }
}

// Pure. Exported for tests.
export function parseVmStat(text: string): number | null {
  // First line: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
  const pageMatch = text.match(/page size of (\d+) bytes/);
  if (!pageMatch?.[1]) return null;
  const pageSize = Number(pageMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const getPages = (label: string): number | null => {
    const re = new RegExp(`^${escapeRegex(label)}:\\s+(\\d+)\\.?`, "m");
    const m = text.match(re);
    return m?.[1] ? Number(m[1]) : null;
  };

  const active = getPages("Pages active");
  const wired = getPages("Pages wired down");
  // "Pages occupied by compressor" — present on Mavericks+; if missing treat as 0.
  const compressed =
    getPages("Pages occupied by compressor") ??
    getPages("Pages stored in compressor") ?? 0;

  if (active == null || wired == null) return null;
  return (active + wired + compressed) * pageSize;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
