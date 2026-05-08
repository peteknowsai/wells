# Wells — Claude Code instructions

This is the wells project. See `docs/ROADMAP.md` for the broader vision and `docs/MVP-PLAN.md` for the current phased plan. The autonomous loop is documented in `.claude/commands/mvp-wells.md`.

## Working on this repo

- Match the global CLAUDE.md vibe (`~/.claude/CLAUDE.md`): opinions over hedging, brevity, no sycophancy.
- The MVP plan is the source of truth for what to build next. Don't add scope without checking the plan or surfacing a question to Pete in `docs/BLOCKED.md`.
- Branch policy: work on `feature/mvp` for the duration of MVP. Squash to `main` when MVP is done.
- Don't commit to `main` directly. (Exception: the very first root commit, already done.)

## Stack

- Bun + TypeScript. Match cells's conventions — see `~/Projects/cells/cli/cells.ts` for style.
- TypeBox for schema validation (matches cells).
- No build tools beyond `bun build` / `bun run`. No bundlers.
- Tests in `*.test.ts` colocated next to the code; `bun test`.

## Engine

- Vendored lume in `vendor/lume/` (MIT, pinned commit). Build via `scripts/build-lume.sh` → `bin/lume`.
- Don't modify lume in place. If patches are needed, drop them in `vendor/lume.patches/` and apply during build.
- The engine boundary lives in `engine/lume.ts`. Everything else in the daemon is engine-agnostic — swapping engines later (e.g., to Apple's `containerization` framework) should be a one-file change.

## State

- Daemon-owned at `~/.wells/`. Never commit. The CLI never writes there directly — always go through the daemon's REST API.
- See `docs/architecture.md` for the layout.

## Sprites compatibility

- REST shapes mirror sprites: `/v1/wells/...` with sprite-shaped fields (`status`, `url`, `created_at`, `last_running_at`, services, policy/network).
- Auth: `Authorization: Bearer $WELL_TOKEN`.
- Cells flips backend with `CELLS_BACKEND=well`. We don't change cells's CF Worker bridge logic — only the WS target URL.
