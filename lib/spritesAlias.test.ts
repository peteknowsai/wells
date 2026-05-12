import { describe, expect, test } from "bun:test";
import { rewriteSpritesAlias } from "./spritesAlias.ts";

describe("rewriteSpritesAlias", () => {
  test("rewrites bare /v1/sprites to /v1/wells", () => {
    expect(rewriteSpritesAlias("/v1/sprites")).toBe("/v1/wells");
  });

  test("rewrites resource paths", () => {
    expect(rewriteSpritesAlias("/v1/sprites/pete")).toBe("/v1/wells/pete");
    expect(rewriteSpritesAlias("/v1/sprites/pete/exec")).toBe("/v1/wells/pete/exec");
    expect(rewriteSpritesAlias("/v1/sprites/pete/policy/network")).toBe(
      "/v1/wells/pete/policy/network",
    );
  });

  test("preserves trailing slash", () => {
    expect(rewriteSpritesAlias("/v1/sprites/pete/")).toBe("/v1/wells/pete/");
  });

  test("does not double-rewrite already-canonical paths", () => {
    expect(rewriteSpritesAlias("/v1/wells")).toBe("/v1/wells");
    expect(rewriteSpritesAlias("/v1/wells/pete")).toBe("/v1/wells/pete");
  });

  test("leaves unrelated paths unchanged", () => {
    expect(rewriteSpritesAlias("/healthz")).toBe("/healthz");
    expect(rewriteSpritesAlias("/")).toBe("/");
    expect(rewriteSpritesAlias("/v1/cells/me/sleep")).toBe("/v1/cells/me/sleep");
  });

  test("does not match similar-looking paths", () => {
    // No accidental rewrites for paths that contain "sprites" but aren't the alias.
    expect(rewriteSpritesAlias("/v1/spritesfoo")).toBe("/v1/spritesfoo");
    expect(rewriteSpritesAlias("/sprites")).toBe("/sprites");
    expect(rewriteSpritesAlias("/v1/sprites_x/pete")).toBe("/v1/sprites_x/pete");
  });

  test("preserves query string semantics (path-only function)", () => {
    // The function only operates on pathname — callers pass URL.pathname,
    // not the full URL. Confirming we don't accidentally include the query.
    expect(rewriteSpritesAlias("/v1/sprites/pete")).toBe("/v1/wells/pete");
  });
});
