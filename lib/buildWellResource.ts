// Builds the sprite-shaped WellResource for GET /v1/wells/<n>, plus the
// post-success responses on lifecycle / hibernation / patch / url /
// checkpoint-restore / create. Six handlers compose this — extracting
// it gives those handlers a single seam for direct unit testing.

export interface BuildWellResourceRecord {
  name: string;
  uuid: string;
  created_at: string;
  cpu: number;
  memory: string;
  disk_size: string;
  auto_sleep_seconds?: number | null;
}

export interface BuildWellResourceDeps {
  findWell(name: string): Promise<BuildWellResourceRecord | null | undefined>;
  // The lume-name resolver — pool-adopted wells differ from operator-name.
  lumeNameOf(record: BuildWellResourceRecord): string;
  // Returns whatever lume.info gives, plus null. Caller only reads .status.
  // `unknown | null` keeps the dep wide so engine type changes don't ripple.
  lumeInfo(lumeName: string): Promise<unknown | null>;
  resolveWellIp(name: string): Promise<string | null>;
  diskUsageBytes(name: string): Promise<number | null>;
  publicBase(): string | null;
}

export interface WellResourceBody {
  name: string;
  uuid: string;
  status: "running" | "stopped" | "missing";
  url: string | null;
  ip: string | null;
  created_at: string;
  last_running_at: null;
  cpu: number;
  memory: string;
  disk_size: string;
  disk_used_bytes: number | null;
  auto_sleep_seconds?: number | null;
}

export async function buildWellResource(
  name: string,
  deps: BuildWellResourceDeps,
): Promise<WellResourceBody | null> {
  const record = await deps.findWell(name);
  if (!record) return null;
  const lumeInfo = await deps.lumeInfo(deps.lumeNameOf(record));
  const lumeStatus = (lumeInfo as { status?: unknown } | null)?.status;
  const status =
    typeof lumeStatus === "string"
      ? (lumeStatus as "running" | "stopped")
      : "missing";
  const ip = await deps.resolveWellIp(name);
  const diskUsed = await deps.diskUsageBytes(name);
  const base = deps.publicBase();
  return {
    name: record.name,
    uuid: record.uuid,
    status,
    url: base ? `https://${record.name}.${base}` : null,
    ip,
    created_at: record.created_at,
    last_running_at: null,
    cpu: record.cpu,
    memory: record.memory,
    disk_size: record.disk_size,
    disk_used_bytes: diskUsed,
    ...(record.auto_sleep_seconds !== undefined
      ? { auto_sleep_seconds: record.auto_sleep_seconds }
      : {}),
  };
}
