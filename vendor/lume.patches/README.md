# vendor/lume.patches/

Wells-team patches over the vendored upstream lume source.

The `vendor/lume/` tree is checked in as a clean copy of upstream (currently `trycua/lume v0.3.9`). We don't edit it in place. Instead, all wells-team modifications live here and are applied at build time by `scripts/build-lume.sh` and reverse-applied on exit, so `git status` in `vendor/lume/` stays clean.

## Layout

- `swift/*.patch` — unified diffs against `vendor/lume/`, applied with `patch -p1` from inside `vendor/lume/`. Numbered `0001-`, `0002-`, etc. so apply order is deterministic.
- `well-engine.entitlements` — wells-owned codesigning entitlements for `bin/lume.app`. Used by `scripts/build-lume.sh` in signed mode.
- `splites-lume.provisionprofile` — Apple-issued provisioning profile authorizing the VZ entitlement for our Developer ID. Embedded into the .app bundle.

## Why patches and not a fork

Today the wells team maintains lume as patches over a vendored copy. Once the patches stabilize and we accept that we own this code path indefinitely, the next step is a real fork at `peteknowsai/lume` (Phase B.1 Chunk 5). At that point this directory continues to host wells-specific config (entitlements, provisioning profile) but the Swift patches move into the fork's git history.

## Authoring a new Swift patch

1. From the wells repo root: `cd vendor/lume`
2. Make your edits in place.
3. `git diff > ../lume.patches/swift/00NN-short-description.patch` (replace NN with the next number; describe what the patch does in 3-5 hyphenated words).
4. **Revert your in-place edits**: `git checkout -- .` so `vendor/lume/` is clean again.
5. Verify the patch applies cleanly: `cd ../.. && scripts/build-lume.sh` — should rebuild `bin/lume` with no errors.
6. Commit the new `.patch` file under `vendor/lume.patches/swift/`.

## Active patches

- `0001-add-mount-to-RunVMRequest.patch` — adds `mount: String?` to lume's HTTP `/run` request body so wells can pass cidata.iso for first-boot cloud-init via the API path. Without this, wells falls back to `lume run` subprocess which doesn't put the VM in lume serve's SharedVM cache, breaking pause/resume.
- `0002-fix-SIGINT-process-group-leak.patch` — replaces `kill(pid, SIGINT)` with `kill(pid, SIGTERM)` in `vendor/lume/src/VM/VM.swift:451-454`. The SIGINT was propagating back to lume serve via shared process-group semantics and crashing the parent with exit code 130 every time a VM was destroyed.
