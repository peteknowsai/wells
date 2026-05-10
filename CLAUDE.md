# Wells — Claude Code instructions

This is the wells project. See `docs/ROADMAP.md` for the broader vision and `docs/MVP-PLAN.md` for the current phased plan. The Pete Loop autonomous-fire harness lives in `.claude/loops/worker.md`; the per-fire entrypoint is `/start-pete-loop`.

## Working on this repo

- Match the global CLAUDE.md vibe (`~/.claude/CLAUDE.md`): opinions over hedging, brevity, no sycophancy.
- The MVP plan is the source of truth for what to build next. `BOARD.md` is the per-fire Kanban; pick the top of Todo unless a Blocked item just unblocked. Don't add scope without checking the plan or flagging in `docs/BLOCKED.md` / `NEEDS_PETE.md`.
- Branch policy: work on `feature/phase-a` for the current phase. Squash to `main` at phase rollover (Pete's call). Sub-branches like `worker/...` are NOT used — workers commit directly on the active phase branch.
- Don't commit to `main` directly. (Exception: the very first root commit, already done.)

## Stack

- Bun + TypeScript. Match cells's conventions — see `~/Projects/cells/cli/cells.ts` for style.
- TypeBox for schema validation (matches cells).
- No build tools beyond `bun build` / `bun run`. No bundlers.
- Tests in `*.test.ts` colocated next to the code; `bun test`. Suite is reliably 520+/0 in default sequential mode; **don't use `bun test --concurrent`** — see `docs/findings-w15-test-isolation.md` for why.

## Engine

- Wells-owned soft fork of lume's Swift sources at `engine/vwell-src/` (MIT, originally pinned to trycua/lume @ d422294b). Build via `scripts/build-lume.sh` → `bin/lume.app` (signed) + `bin/lume` (wrapper).
- Wells team has full ownership now — edit `engine/vwell-src/` in place. Patch architecture is gone; in-tree edits with rationale captured in commit messages. See `engine/vwell-src.txt` for the in-tree edits history.
- Codesigning entitlements: `engine/well-engine.entitlements` (committed). Provisioning profile: `engine/splites-lume.provisionprofile` (gitignored).
- The engine boundary lives in `engine/vwell.ts`. Everything else in the daemon is engine-agnostic — swapping engines later (e.g., to Apple's `containerization` framework) should be a one-file change.

## State

- Daemon-owned at `~/.wells/`. Never commit. The CLI never writes there directly — always go through the daemon's REST API.
- See `docs/architecture.md` for the layout.

## Sprites compatibility

- REST shapes mirror sprites: `/v1/wells/...` with sprite-shaped fields (`status`, `url`, `created_at`, `last_running_at`, services, policy/network).
- Auth: `Authorization: Bearer $WELL_TOKEN`.
- Cells flips backend with `CELLS_BACKEND=well`. We don't change cells's CF Worker bridge logic — only the WS target URL.
