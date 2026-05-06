#!/usr/bin/env bun
// Cells-shaped api() smoke test. Verifies that splited's REST surface is
// drop-in compatible with cells's `api()` helper modulo the noun rename
// (cells calls /v1/sprites/..., splited serves /v1/splites/...).
//
// The body of api() below is intentionally a verbatim copy of
// ~/Projects/cells/cli/cells.ts:api() — we want the smoke to fail the
// instant cells's expectations drift from what we serve.
//
// Run:
//   SPRITES_API_URL=http://127.0.0.1:7878 \
//   SPRITES_TOKEN=$(cat ~/.splites/token) \
//   bun run scripts/smoke-cells-api.ts <splite-name>

const BASE = process.env.SPRITES_API_URL ?? "https://api.sprites.dev";
const TOKEN = process.env.SPRITES_TOKEN;

async function api(path: string): Promise<any> {
  if (!TOKEN) throw new Error("SPRITES_TOKEN not set");
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`api ${path} → ${r.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const REQUIRED_FIELDS = ["status", "url", "created_at", "last_running_at"] as const;

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: bun run scripts/smoke-cells-api.ts <splite-name>");
    process.exit(64);
  }

  console.log(`smoke against ${BASE}, target splite: ${name}`);

  // 1. List endpoint — cells uses this for "show me my sprites" UIs.
  console.log("\n[1] GET /v1/splites (list)");
  const list = await api("/v1/splites");
  if (!Array.isArray(list?.splites)) {
    throw new Error(`expected { splites: [] } shape, got: ${JSON.stringify(list).slice(0, 200)}`);
  }
  console.log(`    ✓ ${list.splites.length} splites`);

  // 2. Singular — this is what cells's getSpriteInfo() reads.
  console.log(`\n[2] GET /v1/splites/${name}`);
  const sprite = await api(`/v1/splites/${encodeURIComponent(name)}`);

  for (const f of REQUIRED_FIELDS) {
    if (!(f in sprite)) {
      throw new Error(`missing field '${f}' — cells will break. got: ${JSON.stringify(Object.keys(sprite))}`);
    }
    console.log(`    ✓ ${f} = ${JSON.stringify(sprite[f])}`);
  }

  // 3. last_running_at must be string-or-null per cells's typing
  // (SpriteInfo.last_running_at: string | null).
  if (sprite.last_running_at !== null && typeof sprite.last_running_at !== "string") {
    throw new Error(`last_running_at must be string | null, got ${typeof sprite.last_running_at}`);
  }
  console.log("    ✓ last_running_at is string | null");

  // 4. url must be string-or-null per cells (SpriteInfo.url: string | null).
  if (sprite.url !== null && typeof sprite.url !== "string") {
    throw new Error(`url must be string | null, got ${typeof sprite.url}`);
  }
  console.log("    ✓ url is string | null");

  // 5. status must be a non-empty string — cells does `sprite.status ?? "?"`
  if (typeof sprite.status !== "string" || sprite.status.length === 0) {
    throw new Error(`status must be non-empty string, got ${JSON.stringify(sprite.status)}`);
  }
  console.log(`    ✓ status is non-empty string`);

  console.log("\nPASS — splited is cells-api-compatible.");
}

await main();
