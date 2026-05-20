# Wells — Claude Code instructions

This is the wells project. See `docs/ROADMAP.md` for the broader vision and `docs/MVP-PLAN.md` for the current phased plan.

## Working on this repo

- Match the global CLAUDE.md vibe (`~/.claude/CLAUDE.md`): opinions over hedging, brevity, no sycophancy.
- `docs/MVP-PLAN.md` is the source of truth for what to build next. Don't add scope without checking the plan or flagging blockers in `docs/BLOCKED.md`.
- Branch policy: small topical branches off `main` (`feature/<thing>`, `fix/<thing>`). Merge back to `main` via squash within a day or two. No per-phase mega-branches — phase A's `feature/phase-a` ballooned to 670 commits / 35k LOC in a week (squashed to `v0.2.0` 2026-05-12); phase-sized branches accumulate too fast to review or bisect.
- Don't commit to `main` directly. (Exception: the very first root commit, already done.)

## Stack

- Bun + TypeScript. Match cells's conventions — see `~/Projects/cells/cli/cells.ts` for style.
- TypeBox for schema validation (matches cells).
- No build tools beyond `bun build` / `bun run`. No bundlers.
- Tests in `*.test.ts` colocated next to the code; `bun test`. Suite is reliably 980+/0 in default sequential mode; **don't use `bun test --concurrent`** — see `docs/findings-w15-test-isolation.md` for why.

## Engine

- Wells-owned soft fork of lume's Swift sources at `engine/vwell-src/` (MIT, originally pinned to trycua/lume @ d422294b). Build via `scripts/build-vwell.sh` → `bin/vwell.app` (signed) + `bin/vwell` (gitignored shell wrapper).
- Wells team has full ownership now — edit `engine/vwell-src/` in place. Patch architecture is gone; in-tree edits with rationale captured in commit messages. See `engine/vwell-src.txt` for the in-tree edits history.
- Codesigning entitlements: `engine/well-engine.entitlements` (committed). Provisioning profile: `engine/splites-lume.provisionprofile` (gitignored, pre-rename filename; build script reads via `$WELL_PROVISION_PROFILE` env var so the legacy name is cosmetic).
- The engine boundary lives in `engine/vwell.ts`. Everything else in the daemon is engine-agnostic — swapping engines later (e.g., to Apple's `containerization` framework) should be a one-file change.

## State

- Daemon-owned at `~/.wells/`. Never commit. The CLI never writes there directly — always go through the daemon's REST API.
- See `docs/architecture.md` + `docs/state-schema.md` for the layout.

## Wells / cells boundary (post-Pi2 / Pi3 / /seal, 2026-05-13)

- **Wells owns substrate primitives.** `create`, `start`, `stop`, `hibernate`, `wake`, `seal`, `destroy`, `exec`, `checkpoint`, image management. Pool ownership moved OUT of wells in Piece 2. Don't reintroduce pool state — `~/.wells/pool/` is gone, pool modules deleted (commit `1ab5160`).
- **Cells owns the pool.** `~/.cells/pool.json`, refill loop, eviction logic, `reconcilePool()` — all cells-side. Cells's canonical bake flow is `create → exec (provision) → seal → hibernate`.
- **`/seal` is the post-provision hibernate-legal primitive.** `lib/lifecycle.ts:sealWell` halts the VM via SSH-sysrq, restarts without cidata, flips `runtime.hibernate_ready=true`. Refuses with 409 `well_already_sealed` / `well_not_running`. See `docs/cells-pool-builder-primitives.md` + memory `wells_seal_endpoint`.
- **Handlers live in `lib/handlers/`.** Pure orchestration with deps injection. `daemon/welld.ts` wires real deps; don't add new logic inline in welld.ts. Memory: `wells_handler_pattern`.
- **Coordinate welld bounces with cells via `/comms cells`.** Don't surprise-bounce when cells is actively testing/baking. Memory: `feedback_stable_untouchable`.

## Sprites compatibility

- REST shapes mirror sprites: `/v1/wells/...` with sprite-shaped fields (`status`, `url`, `created_at`, `last_running_at`, services, policy/network).
- Auth: `Authorization: Bearer $WELL_TOKEN`.
- Cells flips backend with `CELLS_BACKEND=well`. We don't change cells's CF Worker bridge logic — only the WS target URL.
