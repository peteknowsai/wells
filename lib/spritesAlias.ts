// Sprites → wells path alias. Cells (and anything else that already
// speaks the sprites HTTP shape) hits us at `/v1/sprites/...`; we rewrite
// to the canonical `/v1/wells/...` so all downstream route matchers see
// one path scheme.
//
// Two cases handled:
//   /v1/sprites          → /v1/wells          (bare list endpoint)
//   /v1/sprites/<rest>   → /v1/wells/<rest>   (resource endpoints)
//
// Anything else is returned unchanged — we don't touch /v1/wells, /healthz,
// or unrelated URLs.

const SPRITES_PREFIX = "/v1/sprites/";
const SPRITES_BARE = "/v1/sprites";
const WELLS_PREFIX = "/v1/wells/";
const WELLS_BARE = "/v1/wells";

export function rewriteSpritesAlias(pathname: string): string {
  if (pathname === SPRITES_BARE) return WELLS_BARE;
  if (pathname.startsWith(SPRITES_PREFIX)) {
    return WELLS_PREFIX + pathname.slice(SPRITES_PREFIX.length);
  }
  return pathname;
}
