# vendor/lume.patches/

Wells-owned signing artifacts for `bin/lume.app`. The lume Swift source itself lives in `vendor/lume/src/` and we edit it directly — no patch dance.

## Layout

- `well-engine.entitlements` — wells-owned codesigning entitlements for `bin/lume.app`. Used by `scripts/build-lume.sh` in signed mode.
- `splites-lume.provisionprofile` — Apple-issued provisioning profile authorizing the VZ entitlement for our Developer ID. Embedded into the .app bundle.

## History

This directory used to hold `swift/*.patch` files applied at build time and reverse-applied on exit so `vendor/lume/` git status stayed clean. The wells team has since taken full ownership of the lume Swift source, so those patches were baked permanently into `vendor/lume/src/` and the patch infrastructure removed (2026-05-08).

If we ever upstream changes back to `trycua/lume` we'll regenerate them as a clean diff against upstream at that point.
