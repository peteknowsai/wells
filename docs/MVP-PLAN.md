# Splites — MVP Plan

The smallest thing that makes splites a drop-in for sprites: birth a Pi cell on a local Linux splite via `cells birth --backend=splite`, and reach it via the existing `<name>.cells.md` Cloudflare Worker bridge.

## Constraints

- **Host:** Mac Mini (arm64). Single host for v1.
- **Guest:** Ubuntu 25.10 arm64. Mirrors current sprites baseline (Node, Python, Go, Ruby, Rust, git, curl, build tools, Claude Code).
- **Engine:** vendored lume → Apple's Virtualization.framework.
- **Stack:** Bun + TypeScript.
- **State:** `~/.splites/` (registry, images, vms, checkpoints).
- **Daemon:** `splited` on `:7878`, sprites-shaped REST.
- **CLI:** `splite`, thin client to `splited`.

## Done definition

`cells birth pete --backend=splite` produces a working Pi cell on a local splite. `cells talk pete` reaches it via the CF Worker bridge. State persists across `splite stop` / `splite start`. `splite checkpoint create` snapshots in <1s. `splite destroy pete --yes` reclaims the disk.

## Phases

### Phase 0 — Repo bootstrap
- [x] `package.json` (Bun, TypeScript, TypeBox), `tsconfig.json`
- [x] CLI entry `cli/splite.ts` with `--version`, `--help`, no-op subcommand stubs
- [x] Daemon entry `daemon/splited.ts` that listens on `:7878` and responds to `GET /healthz`
- [ ] State dir helper (`lib/state.ts`) — paths under `~/.splites/`, ensure-dir helpers
- [ ] Logging helper (`lib/log.ts`) — structured JSON to stderr, level via `SPLITES_LOG_LEVEL`
- [ ] `bun run splite` and `bun run splited` work from the repo root
- [ ] Smoke test: `bun test` passes (placeholder test)

### Phase 1 — Lume vendored & buildable
- [ ] `vendor/lume/` cloned at a pinned commit; record the commit + license in `vendor/lume.txt`
- [ ] `scripts/build-lume.sh` builds the lume Swift binary into `bin/lume`
- [ ] Smoke test: `bin/lume --version` works on macOS arm64
- [ ] Wrapper module `engine/lume.ts` — typed methods for `start`, `stop`, `clone`, `delete`, `list`, `info`, `pull`
- [ ] Daemon starts `lume serve` on demand (reuses existing process if alive); supervises it
- [ ] Smoke test: daemon-side `engine.list()` returns `[]` against a fresh install

### Phase 2 — Base image build
- [ ] `scripts/build-base-image.ts` downloads Ubuntu 25.10 arm64 cloud image (canonical's official URL)
- [ ] cloud-init template installs Node, Python, Go, Ruby, Rust, git, curl, build-essential, Claude Code (mirroring sprites preinstalled set)
- [ ] Boots once via lume, freezes when cloud-init is done, saves to `~/.splites/images/ubuntu-25.10-base/`
- [ ] Idempotent — skip if exists; `--force` rebuilds
- [ ] Smoke test: image boots in lume, `lume exec` runs `uname -a` and returns 0

### Phase 3 — Create / list / info
- [ ] `splite create <name>` — clone base image directory via APFS clonefile into `~/.splites/vms/<name>/`, generate per-splite cloud-init (hostname, ssh key), `lume run`, wait for ssh-ready
- [ ] Reject reserved names (`mother`, `keeper`, etc.) and duplicates
- [ ] `splite list` — read state, render table (name, status, age, ip)
- [ ] `splite info <name>` — JSON or pretty-print: status, ip, disk usage, uptime, lume vm id
- [ ] `splite use <name>` — write `.splite` JSON in cwd; subsequent commands without `-s` use it
- [ ] State schema documented in `docs/state-schema.md`
- [ ] Smoke test: `splite create pete && splite info pete` shows a running splite with an IP

### Phase 4 — Exec & files
- [ ] `splite exec [-s name] [--tty] -- <cmd> [args]` — ssh into the splite, stream stdout/stderr to the caller, return guest exit code
- [ ] Per-splite ssh keys generated at create, stored in the bundle, never committed
- [ ] `splite console [-s name]` — interactive PTY shell, Ctrl+\ to detach (sprites parity, not Ctrl+D)
- [ ] Tar-pipe pattern works: `tar c <dir> | splite exec -- tar xz -C /target`
- [ ] Done when cells's existing `sprite_exec` and `sprite_push` patterns work against a `splite`-aliased call

### Phase 5 — Lifecycle
- [ ] `splite stop [-s name]` — graceful guest shutdown (`shutdown -h now` over ssh, then `lume stop`), VM process exits, disk persists
- [ ] `splite start [-s name]` — boot existing VM from the persistent disk, reuse same IP, same ssh host key
- [ ] State survives stop/start: smoke test writes a sentinel file, stops, starts, reads it back
- [ ] No MITM warnings on reconnect (host key persists)
- [ ] Reasonable boot time documented (target: under 10s warm boot)

### Phase 6 — Checkpoints
- [ ] `splite checkpoint create [-s name]` — APFS `clonefile(2)` of the splite's disk into `~/.splites/vms/<name>/checkpoints/<id>/`
- [ ] `splite checkpoint list [-s name]` — id, created_at, size delta vs base
- [ ] `splite checkpoint restore <id> [-s name]` — stop VM, swap disk, restart; ad-hoc processes die, services restart (sprites semantics)
- [ ] Last-5 retention; older auto-GC'd at create time
- [ ] Mount the last 5 read-only inside the guest at `/.splite/checkpoints/<id>/` (sprites parity)
- [ ] Smoke test: create > write file > checkpoint > delete file > restore > file is back; <1s for checkpoint create on a 10GB-divergent disk

### Phase 7 — Destroy
- [ ] `splite destroy [-s name] --yes` — confirm name match, stop VM, `rm -rf ~/.splites/vms/<name>/`, deregister from registry
- [ ] Idempotent — destroy of non-existent splite returns success with a "not found" note
- [ ] `splite rm` alias
- [ ] Smoke test: create > destroy > list shows it's gone > directory is gone

### Phase 8 — Daemon REST API
- [ ] `splited` HTTP server on `:7878` — TypeBox-validated request/response shapes
- [ ] Endpoints: `POST /v1/splites`, `GET /v1/splites`, `GET /v1/splites/{n}`, `DELETE /v1/splites/{n}`, `POST /v1/splites/{n}/start|stop`, `POST /v1/splites/{n}/checkpoints`, `GET /v1/splites/{n}/checkpoints`, `POST /v1/splites/{n}/checkpoints/{id}/restore`
- [ ] WS `/v1/splites/{n}/exec` for streaming exec (matches sprites WSS shape)
- [ ] Bearer token auth from `~/.splites/token` (auto-generated on first run, mode 0600)
- [ ] CLI flips to talk to daemon instead of doing engine ops directly; daemon is the single writer of state
- [ ] `splite api ...` raw passthrough (matches `sprite api`)
- [ ] Smoke test: cells's `cells.ts:api()` works against `SPRITES_API_URL=http://localhost:7878 SPRITES_TOKEN=$(cat ~/.splites/token)` (path noun aside)

### Phase 9 — Services & URL
- [ ] `POST /v1/splites/{n}/services/{id}` — declarative service definition
- [ ] Daemon translates service definition to a systemd unit inside the guest, enables, starts
- [ ] Supports `command`, `args`, `cwd`, `env`, `auto_restart`, `http_port`, `depends_on`
- [ ] `auto_restart: true` survives `splite stop`/`splite start` (systemd handles it)
- [ ] `splite url [-s name]` returns a stable HTTPS URL → guest:8080 (MVP: `http://localhost:<random>` from splited's reverse proxy; Phase A adds TLS via Cloudflare Tunnel)
- [ ] `splite url update --auth=public|splite` toggles bearer requirement on the proxy
- [ ] `POST /v1/splites/{n}/policy/network` egress endpoint accepts the request and returns success — real enforcement deferred to Phase A
- [ ] Smoke test: cells's `register-site-service.sh` succeeds against a splite

### Phase 10 — Cells integration
- [ ] In `~/Projects/cells`: add `CELLS_BACKEND=splite` env var support to `cli/cells.ts` and the `sprite-tools` Pi extension
- [ ] When `CELLS_BACKEND=splite`, calls to `sprite ...` route to `splite ...` (or directly to splited's REST via `SPRITES_API_URL`)
- [ ] Cells's CF Worker bridge picks the splite-side endpoint when birthing a splite-backed cell
- [ ] End-to-end birth: `CELLS_BACKEND=splite cells birth pete` creates a working Pi cell on a local splite
- [ ] `cells talk pete` reaches it; bidirectional messaging works
- [ ] `cells checkpoint pete`, `cells sleep pete`, `cells wake pete`, `cells destroy pete` all work
- [ ] Squash-merge `feature/mvp` into `main`. Tag `v0.1.0`.

## Loop discipline

When the `/mvp-splites` loop fires, the running agent should:

1. Read this file. Find the first phase with unchecked items.
2. Identify the smallest next checkbox to make progress on.
3. Implement it. Write tests where it makes sense. Run them.
4. Commit with a clear message naming the phase + checkbox.
5. Update the checkboxes in this file. Commit the doc change too (or in the same commit).
6. If a whole phase is complete, append a short note under the phase title: `**Done — <yyyy-mm-dd>.**`
7. If MVP is fully complete, write a "MVP complete on <date>" line at the top and stop.

**Bounded:** one loop run = roughly one focused chunk of work. If a checkbox is huge, decompose it into sub-checkboxes during the run; check the easy ones, defer the rest.

**When stuck:** write the blocker to `docs/BLOCKED.md` (date, what was tried, what's needed from Pete). Commit. Stop the run. The next run reads BLOCKED.md and skips new work until it's resolved.
