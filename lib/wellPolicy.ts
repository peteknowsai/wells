// Well naming policy. Hostnames need to be RFC1123-safe (lowercase alnum
// plus hyphens, 1–63 chars, no leading/trailing hyphen) so they round-trip
// through cloud-init's local-hostname, DNS, and `<name>.wells.cells.md`.

const RESERVED = new Set([
  // Cells-side identities the wells layer mustn't shadow.
  "mother",
  "keeper",
  // Wells infra names.
  "wells-base",
  "wells-base-stage",
  // System-y collisions.
  "localhost",
  "broadcast",
  "host",
  "default",
]);

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isReservedName(name: string): boolean {
  return RESERVED.has(name);
}

export function validateWellName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid well name '${name}': must be lowercase alphanumeric + hyphens, 1–63 chars, no leading/trailing hyphen`,
    );
  }
  if (isReservedName(name)) {
    throw new Error(`'${name}' is a reserved name`);
  }
}

// Memory + disk are sprites-shaped strings: "4GB", "512MB", "50GB".
const SIZE_RE = /^(\d+)(MB|GB|TB)$/i;

export function normalizeSize(input: string): string {
  const m = SIZE_RE.exec(input.trim());
  if (!m) throw new Error(`invalid size '${input}': expected like '4GB' or '512MB'`);
  return `${m[1]}${m[2]!.toUpperCase()}`;
}

// Convert "20GB" → "20G" for `truncate -s` (which uses K/M/G/T suffixes).
export function sizeToTruncateArg(input: string): string {
  const m = SIZE_RE.exec(input.trim());
  if (!m) throw new Error(`invalid size '${input}'`);
  const unit = m[2]!.toUpperCase();
  const short = unit === "MB" ? "M" : unit === "GB" ? "G" : "T";
  return `${m[1]}${short}`;
}
