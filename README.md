# Wells

Local, stateful Linux machines that look and feel exactly like sprites.dev sprites — on hardware you own.

A `well` is a sprite that lives on your Mac Mini. The CLI verbs match. The REST shapes match. The mental model is the same: a Linux machine with a filesystem that survives sleep, wake, and reboot. The substrate is yours.

## Status

**v0.2.0** shipped 2026-05-12 (Phase A partial). Working toward [v1.0](docs/proposals/road-to-wells-1.0.html), target ~2026-06-06.

What's stable today:

- Create / exec / start / stop / destroy / list — sprites-shaped REST + CLI parity.
- Hibernate + wake-on-traffic — release RAM to disk in ~200ms, wake in ~1s.
- Pre-warmed pool — `well create` in ~2s when a pool member is ready.
- Image save / push / pull — APFS clonefile of stopped wells; R2 push/pull for cross-host transfer.
- Public URL bridge — every well reachable on your own domain via `cloudflared`.

Test suite: 995/995 green. Substrate facts in [`STATUS.html`](STATUS.html).

## Why

Sprites are great. But the upstream company has to stay solvent for the fleet to keep working, and metered RAM means a "paused" cell isn't free. Wells:

- **Owned end-to-end.** Engine is open (vendored lume → Apple's Virtualization.framework). State is on your disk. No tokens to rotate, no `api.sprites.dev` to depend on.
- **Sprites-shaped surface.** Anywhere your code calls `sprite ...`, `well ...` does the same thing locally. The REST shapes match too — flip `CELLS_BACKEND=well` and existing tooling keeps working.
- **Hibernation costs disk, not dollars.** Owned hardware means a paused cell costs you the hibernate.bin file (~28% of allocated RAM) and nothing else.
- **Future: multi-OS guests.** Once the Linux substrate is solid: macOS, Windows, Android via the same path. Sprites is Linux-only — wells doesn't have to be.

## Design

For the one-page tour: [`docs/overview.md`](docs/overview.md).
For the architecture: [`docs/architecture.md`](docs/architecture.md).
For the lifecycle (alive / hibernating / frozen): [`docs/lifecycle.md`](docs/lifecycle.md).
For the cells integration contract: [`docs/cells-integration.md`](docs/cells-integration.md).

Short version:

- `well` — Bun/TS CLI, thin client.
- `welld` — Bun/TS daemon on `:7878`, sprites-shaped REST. Single owner of `~/.wells/`. Handler orchestration in `lib/handlers/` (deps-injected, unit-tested).
- Engine — wells-owned soft fork of lume at `engine/vwell-src/` driving Apple's Virtualization.framework. Boundary in `engine/vwell.ts` — engine swap is a one-file change.
- State — `~/.wells/` (registry, images, per-well runtime + hibernate.bin, pool).

## Install

```sh
# 1. Build the engine (signed lume binary):
scripts/build-lume.sh

# 2. Install the dhcp helper (one-time, prompts sudo):
bash scripts/install-dhcp-helper.sh

# 3. Set your public base + bring up the cloudflared tunnel:
export WELL_PUBLIC_BASE=cells.md    # or your own domain
# (see docs/install.md § Cloudflared for the bridge config)

# 4. Install welld as a launchd agent (auto-starts on login):
scripts/install-launchd.sh

# 5. Verify:
curl -s http://127.0.0.1:7878/healthz | jq .
well list
```

Full walkthrough including the cloudflared + ACM cert setup: [`docs/install.md`](docs/install.md).

## Use

```sh
well create pete                # create a well (~2s with pool, ~14s fresh)
well exec pete -- uname -a      # exec inside the well
well stop pete                  # hibernate (~200ms)
well start pete                 # wake from hibernate (~1s)
well destroy pete               # tear down

well image save pete my-snap    # APFS clonefile of pete's disk
well image push my-snap         # push to R2 library

well list                       # roster
well info pete                  # per-well status + IP + resource usage
```

Sprites compatibility: any sprites-shaped client works against welld by flipping the API URL. Cells uses `CELLS_BACKEND=well`.

## Repo

```
.
├── bin/                     # built artifacts (lume.app, well CLI)
├── cli/                     # well CLI (Bun TS)
├── daemon/welld.ts          # the daemon — HTTP/WS router + lifecycle
├── docs/                    # architecture, lifecycle, install, cells-integration
├── engine/
│   ├── vwell.ts             # engine boundary — only file that knows about lume
│   └── vwell-src/           # wells-owned soft fork of lume (MIT, originally trycua/lume)
├── lib/                     # daemon helpers, state, registry, networking
│   └── handlers/            # 12 modules covering all welld endpoints (deps-injected, unit-tested)
├── scripts/                 # install, build, smoke
└── templates/               # cloud-init + well-firstboot
```

## Develop

```sh
bun install
bun test                    # 995/995 green; ~4.7s sequential. Don't use --concurrent.
bun run daemon/welld.ts     # foreground dev daemon
```

Branch policy: small topical branches off `main` (`feature/<thing>`, `fix/<thing>`). Squash-merge back within a day or two. See `CLAUDE.md` for the project conventions.

## License

The wells-owned lume soft fork in `engine/vwell-src/` is MIT, originally pinned to [trycua/lume](https://github.com/trycua/lume) @ `d422294b`. The rest of the project license is TBD pending the public release.
