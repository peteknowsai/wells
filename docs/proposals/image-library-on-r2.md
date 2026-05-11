# Design — image library on R2

**To:** wells team (this is an internal design doc; cells team gets the integration spec once W.4/W.5 ship)
**From:** worker, fired by /loop
**Date:** 2026-05-10
**Status:** ✅ SHIPPED 2026-05-10. W.4 (push half) commit `a4d...`, W.5 (pull half + auto-pull-on-create) commit `1f5...`; round-trip smoke verified live 14:50Z (41:18 wall-clock, sha match). `lib/imageLibrary.ts` is the implementation; `lib/imageLibrary.test.ts` has 13 tests covering happy + failure paths. Proposal preserved below as the design rationale; what shipped matches it modulo the three R2 plumbing fixes the live verify surfaced (16MB partSize, async upload, streaming sha256).

---

## In plain English

Today, every Mac that runs welld bakes its own copy of `ubuntu-25.10-base` (~6 GB). When wells move from one Mac to another, or when a new Mac mini gets added to a Colony (Phase E), it has to re-bake from scratch — a 5–10 minute toolchain install + several minutes of disk write. Saved images (cells's `cell-base`, custom-baked images per cells team) are also stuck on the Mac that produced them.

This design adds a **content-addressable image library on R2**, so any welld can `well image pull cell-base` (or any name) and have the bytes locally in seconds, regardless of where they were originally baked. It's `docker pull` for wells.

The whole thing is opt-in via env vars or per-image registration. R2 is the only backend in v1 — the bundle.S3Client is enough; no Cloudflare Workers needed for the library itself (image registration metadata lives directly in R2 alongside the bytes).

---

## Goals

1. **Mac-portable images.** A bake done on Pete's Mac mini lands on cells team's Mac with `well image pull <name>`. No re-bake.
2. **Cells team unblocks for Colony.** Phase E adds multi-Mac Colony; image distribution is the prerequisite that doesn't exist yet.
3. **Compatible with existing `--from-image`.** `well create --from-image cell-base` should auto-pull from R2 when the image is missing locally, mirroring what `lib/checkpoints.ts:ensureCheckpointLocal` already does for checkpoints.
4. **Cheap.** R2 egress is free up to limits; storing 5–10 images at 6 GB each = 30–60 GB stored, well under the free tier's 10 GB but Pete is on a paid plan anyway.

## Non-goals (v1)

- **No image versioning beyond name.** `cell-base` is `cell-base`. If you need a new version, give it a new name (`cell-base-2026-05-10`). Tags / SHA-pinned references can land in v2 once we know whether we want them.
- **No mutable images.** Push-once-read-many. Re-pushing the same name overwrites — but the CLI warns on overwrite. No history kept on R2.
- **No multi-tenancy beyond bucket-level.** Whoever has bucket read can pull any image; whoever has bucket write can push or overwrite. Cells team's images and wells team's images live in the same bucket; we don't enforce per-image ACLs in v1. (Phase E may need this — track separately.)
- **No partial pulls / resumable transfers.** Streaming PUT/GET against bun's `S3Client.write`/`Bun.write(localPath, remoteFile)` is what we already use for checkpoints; reuse it. If a 6 GB pull fails partway, the next `pull` retries from zero. Cells team's network is fast enough that this is fine.
- **No cross-region replication.** Single R2 bucket per organization. Multi-region story is a Phase E+ concern.

---

## Bucket layout

```
<bucket>/
  images/
    <image-name>/
      manifest.json    — pointer + integrity (canonical metadata for the library)
      meta.json        — verbatim copy of the local meta.json (image_contract_version, from_well, etc.)
      disk.img         — the disk bytes
```

**Why `manifest.json` separate from `meta.json`:**

- `meta.json` is the existing local-side image metadata produced by `lib/imageStore.ts:saveImage`. It's identical to what's at `~/.wells/images/<name>/meta.json` on the producer Mac. Mirroring it on R2 means a fresh-pulled image is byte-equivalent to a locally-baked one — no transformation step.
- `manifest.json` is library-only. It carries the R2-specific fields the local meta.json doesn't have:
  - `disk_sha256` — sha256 of `disk.img`. Verified after pull. The "did the image arrive intact" check.
  - `disk_size_bytes` — for progress display + early "image too large for available disk" check.
  - `pushed_at` — UTC ISO. So `well image list --remote` can sort by recency.
  - `pushed_by_welld_version` — diagnostic.
  - `pushed_by_host` — diagnostic (e.g., `pete-macmini`). Useful when chasing "which Mac baked this" questions in a Colony.

The split lets `well image list --remote` issue cheap HEADs (or directory-list-equivalents) on `manifest.json` without pulling 6 GB of `disk.img`. It also keeps the wire contract for `meta.json` stable — anything that already reads local `meta.json` works without change.

**Why content-addressable layout NOT chosen:**

Considered `images/by-sha256/<hex>` + `images/by-name/<name>` symlink-equivalents. Rejected for v1 — adds a dereference hop, complicates `pull` to two GETs, and the use case (de-dup identical-bytes images across names) doesn't exist yet. Defer until W.4/W.5 ship and someone actually wants name aliases. The current name-keyed layout is also identical to the local layout, which keeps mental model alignment.

---

## CLI surface

```
well image push <name>                  # local → R2 (overwrites if name exists, with confirm)
well image pull <name>                  # R2 → local (skips if local exists, --force to re-pull)
well image list --remote                # R2 → list (default lists local-only)
well image rm --remote <name>           # delete R2 object (local untouched)
```

**Existing local commands stay:**
```
well image list                         # local-only
well image save <well> <name>           # captures from a stopped well, local-only
well image rm <name>                    # local-only delete
well image info <name>                  # local meta.json + (optional) --remote query
```

**Auto-pull on `well create`:**

`well create --from-image <name>` already calls `welld POST /v1/wells` which hits `createWell` → `imageExists(fromImage)` → throws if missing. The fix is in `createWell`: when `imageExists` returns false AND the image is configured for R2 (more on config below), call `pullImage(name)` first, then re-check. Mirrors `ensureCheckpointLocal`'s implicit-fetch path. **No CLI change needed** — the create just gets slower the first time (one-time pull, then cached).

**Confirmation prompt on overwrite:**

`well image push <name>` with an existing R2 object prompts `image '<name>' already on R2 (pushed 2 hours ago by pete-macmini@0.1.0-pre). overwrite? [y/N]`. `--force` skips. Default-deny keeps accidental clobbers off.

---

## R2 config — where the creds live

Two layered options, both supported in v1 (the more specific wins):

**1. Per-Mac (operator-wide).** Env vars on welld start:
```
WELL_R2_LIBRARY_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
WELL_R2_LIBRARY_BUCKET=wells-images
WELL_R2_LIBRARY_ACCESS_KEY_ID=<key>
WELL_R2_LIBRARY_SECRET_ACCESS_KEY=<secret>
```
This is the typical mode — one set of creds per Mac that has both pull and push access to the org's image bucket. Creds rotate via env (re-launch welld). Matches the pattern Pete already uses for the checkpoint smoke (`R2_*` env).

**2. Per-image (overrides per-Mac).** `well image push <name> --r2-endpoint=… --r2-bucket=…` lets a one-off image go to a different bucket than the operator's default. The push records the bucket in local `meta.json.r2_library` so `well image rm --remote <name>` knows where to delete from. **Pull doesn't need per-image config** — it always uses operator-default since by definition local doesn't have the image yet.

**No per-well R2 library config.** Wells already have per-well R2 for *checkpoints* (`record.r2`), which is appropriate because each well is a tenant of its own R2 bucket. Image library is operator-shared infrastructure — different concept, different creds.

---

## Security boundary

**A baked image is a fresh-boot disk.** Anyone with bucket read can `well create --from-image <pulled-name>` and end up with a working VM that boots from those bytes. That means:

- **Read access to the library is "can boot any image in it."** Don't put secrets in the library bucket. (Cells DNA, well-firstboot scripts, the `cell` user's authorized_keys are fine — those are by design baked into the disk.)
- **Write access to the library is "can replace any name."** Pushing a malicious image with the same name as a trusted one means anyone who pulls next gets compromised. Mitigation: in v2, manifest-pinned content addressing. In v1, accept the trust boundary — only operator Macs with R2 secret keys get write.

**No client-side encryption in v1.** R2 supports server-side encryption transparently; that's the floor. If/when we need client-side, it's a separate layer that fits at the streaming PUT/GET boundary in `lib/r2.ts`.

**Signing / Sigstore-style attestation not in scope.** Wells doesn't have a CA story yet. If Phase E exposes the image library publicly, that's the trigger to add signature verification.

---

## Versioning approach (revisited because it matters)

V1 is **name = version**. To ship a new build of `cell-base`:

1. Bake locally as `cell-base-2026-05-10` (date-stamped name).
2. `well image push cell-base-2026-05-10`.
3. Update consumers (cells team's birth flow) to reference the new name.
4. Once consumers are migrated, `well image rm --remote cell-base` to retire the old.

This is intentionally low-tech. It surfaces the "what's the canonical version" question to whoever consumes images — they explicitly pick. No `:latest` tag drift, no implicit migration.

If/when this gets painful, v2 adds:
- `well image alias <name> <target>` — server-side R2 redirect manifest
- `well image push <name> --tag=stable` — moves the named tag to point at the just-pushed bytes
- `well image pull <name>:stable` — resolves tag → content hash → fetch

But not in v1. The current cells team workflow ("rebake when DNA changes, snap to a new image name") works with name-as-version.

---

## Phase E fit

Phase E (multi-Mac Colony) needs image distribution. This design lands the primitive but does **not** solve Colony coordination:

- A Colony has N Macs. When `cell create` lands on Mac #3 and the requested image isn't local, Mac #3 issues a single `well image pull` against R2. Done. Independent of which Mac baked it.
- Refresh is per-Mac. Mac #1 bakes a new `cell-base` and pushes. Mac #2 still has the old version locally — it doesn't auto-pull. Either it gets a `--from-image` request and the create path detects + pulls fresh, or an admin runs `well image pull cell-base --force` on Mac #2 explicitly.
- **No central coordinator.** R2 is the only shared state. This is intentional — cells's pool-on-wells design (`docs/proposals/cells-pool-on-wells.md`) keeps state per-Mac too. Image library matches.

**What Phase E will need on top of this design:**

- A way for the orchestrator to know "image X is at version Y on R2" so it can route fresh-create requests to a Mac that already has it cached. That's a manifest-level cache hint. Not in v1; v2 has manifest.json which carries enough metadata to support it.
- A "pre-warm" command: `well image pull <name>` against every Mac in the Colony. v1's per-Mac CLI is enough — orchestrator scripts the loop.

---

## Implementation slices

**W.3 (this fire) — design.** This document.

**W.4 — `well image push <name>`.**
- New `lib/imageLibrary.ts` with `pushImage(name, config)` that:
  - Reads local `~/.wells/images/<name>/{disk.img, meta.json}`.
  - Computes sha256 of `disk.img` (streaming, not buffered).
  - Builds `manifest.json` (sha256 + size + pushed_at + pushed_by_welld_version + pushed_by_host).
  - Streams `disk.img` to R2 via the bundled `S3Client`.
  - Streams `meta.json` and `manifest.json`.
  - Returns the keys written.
- Welld endpoint `POST /v1/wells/images/<name>/push` (admin-only via Authorization header).
- CLI `well image push <name>` calls the endpoint, prompts on overwrite via `well image info --remote <name>` first.
- 4–5 unit tests on `pushImage` (round-trip with mock client, overwrite confirm, error on missing local, sha256 stamping, per-image config override).

**W.5 — `well image pull <name>` + auto-pull on create.**
- New `lib/imageLibrary.ts:pullImage(name, config)`:
  - Streams `manifest.json` from R2 first (cheap, ~1 KB).
  - Streams `disk.img` from R2 to a temp path; verifies sha256 against manifest's; mv on success.
  - Streams `meta.json` to local `~/.wells/images/<name>/meta.json`.
  - Returns metadata.
- Welld endpoint `POST /v1/wells/images/<name>/pull`.
- CLI `well image pull <name>` (uses `--force` flag to re-pull when local exists).
- `createWell`'s `imageExists` check gains an implicit `pullImage` before throwing, when R2 library is configured (env vars present).
- Tests: 4–5 covering pull-with-mock, sha256 mismatch (must throw + cleanup), pull-when-local-exists (no-op + log), implicit fetch path on `createWell`.

**Smoke (lands with W.5):** `scripts/smoke-image-library.ts` — pushes a small image (e.g., the existing `ubuntu-25.10-base` if dev pool isn't testing it), purges local, pulls it back, asserts disk-byte identity. Same pattern as `smoke-r2-sync.ts` (W.2).

---

## Open items / deferred decisions

1. **Bucket lifecycle policy.** R2 supports lifecycle rules (auto-delete old objects). Should the image bucket have a "delete after 30 days untouched" rule for staging-style names like `cell-base-staging-*`? Defer — easy to add later via wrangler, no code impact.
2. **Operator-overridable name namespace.** `wells-images` bucket = one namespace. If two cells-team-related projects want isolated namespaces (e.g., dev vs prod images), they use different buckets via per-image config (option 2 above). Whether to make this first-class (e.g., `WELL_R2_LIBRARY_BUCKET_<env>`) — defer until we hit it.
3. **Colony-aware "nearest cache" pull.** Once Phase E lands and there are multiple Macs each holding image caches, a `well image pull <name> --prefer-local` could check sibling Macs first before going to R2. Out of scope for v1.

---

## Closes

W.3 only. Worker exits this fire with the design doc shipped + W.3 ticked. W.4 and W.5 are separate fires that implement against this spec. Whoever picks them up should re-read this doc first — implementation choices may surface details that shift the design slightly, and that's expected.
