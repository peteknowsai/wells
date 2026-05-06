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
**Done — 2026-05-05.**

- [x] `package.json` (Bun, TypeScript, TypeBox), `tsconfig.json`
- [x] CLI entry `cli/splite.ts` with `--version`, `--help`, no-op subcommand stubs
- [x] Daemon entry `daemon/splited.ts` that listens on `:7878` and responds to `GET /healthz`
- [x] State dir helper (`lib/state.ts`) — paths under `~/.splites/`, ensure-dir helpers
- [x] Logging helper (`lib/log.ts`) — structured JSON to stderr, level via `SPLITES_LOG_LEVEL`
- [x] `bun run splite` and `bun run splited` work from the repo root
- [x] Smoke test: `bun test` passes (placeholder test)

### Phase 1 — Lume vendored & buildable
**Done — 2026-05-06.**

- [x] `vendor/lume/` cloned at a pinned commit; record the commit + license in `vendor/lume.txt`
- [x] `scripts/build-lume.sh` builds the lume Swift binary into `bin/lume`
- [x] Smoke test: `bin/lume --version` works on macOS arm64
- [x] Wrapper module `engine/lume.ts` — typed methods for `start`, `stop`, `clone`, `delete`, `list`, `info`, `pull`
- [x] Daemon starts `lume serve` on demand (reuses existing process if alive); supervises it
- [x] Smoke test: daemon-side `engine.list()` returns `[]` against a fresh install

### Phase 2 — Base image build
**Done — 2026-05-06.**

- [x] `scripts/build-base-image.ts` downloads Ubuntu 25.10 arm64 cloud image (canonical's official URL)
- [x] cloud-init template installs Node, Python, Go, Ruby, Rust, git, curl, build-essential, Claude Code (mirroring sprites preinstalled set)
- [x] Boots once via lume, runs cloud-init (orchestrator composes the static template with a build-time ssh keypair so the host can poll `/etc/.splites-base-ready`), shuts down when the marker appears, saves the baked output to `~/.splites/images/ubuntu-25.10-base/disk.img`. The pristine cloud-image download stays at `~/.splites/images/ubuntu-25.10-base/cloud-image.img` (input); `disk.img` is the output ready to clone.
- [x] Idempotent — skip if `disk.img` exists; `--force` rebuilds
- [x] Smoke test: image boots in lume, `lume ssh -- uname -a` returns 0

### Phase 3 — Create / list / info
**Done — 2026-05-06.**

- [x] `splite create <name>` — clone the base `disk.img` file via APFS `clonefile(2)` into `~/.splites/vms/<name>/disk.img`; generate per-splite cloud-init seed (unique hostname, fresh ssh host keys via `ssh_genkeytypes:` so each splite has its own keypair, host's authorized_key for `splite exec`); `lume run`; wait for ssh-ready
- [x] Reject reserved names (`mother`, `keeper`, etc.) and duplicates
- [x] **Resource knobs**: `splite create --cpu=N --memory=NG --disk=NG`. Defaults: 4 vCPU, 4 GB RAM, 50 GB disk (scaled for shared-host use; sprites defaults aren't appropriate when multiple splites cohabit a Mac Mini). Tunable globally via `~/.splites/defaults.json`.
- [x] `splite list` — read state, render table (name, status, age, ip)
- [x] `splite info <name>` — JSON or pretty-print: status, ip, disk usage, uptime, cpu/memory/disk allocation
- [x] `splite use <name>` — write `.splite` JSON in cwd; subsequent commands without `-s` use it
- [x] State schema documented in `docs/state-schema.md`
- [x] Smoke test: `splite create pete && splite info pete` shows a running splite with an IP — passed 2026-05-06, end-to-end ~5s, ssh + Node 22 + Claude Code verified.

### Phase 4 — Exec & files
**Implementation done — 2026-05-06. Cells parity verified in Phase 10.**

- [x] `splite exec [-s name] [--tty] -- <cmd> [args]` — ssh into the splite, stream stdout/stderr to the caller, return guest exit code
- [x] Per-splite ssh keys generated at create, stored in the bundle, never committed (live under `~/.splites/vms/<n>/ssh_key`, outside the repo by construction)
- [x] `splite console [-s name]` — interactive PTY shell, Ctrl+\ to detach (sprites parity, not Ctrl+D)
- [x] Tar-pipe pattern works: `tar c <dir> | splite exec -- tar xz -C /target`
- [ ] Done when cells's existing `sprite_exec` and `sprite_push` patterns work against a `splite`-aliased call (verified during Phase 10)

### Phase 5 — Lifecycle
**Done — 2026-05-06.**

- [x] `splite stop [-s name]` — graceful guest shutdown (`shutdown -h now` over ssh, then `lume stop`), VM process exits, disk persists
- [x] `splite start [-s name]` — boot existing VM from the persistent disk, reuse same IP, same ssh host key
- [x] State survives stop/start: smoke test writes a sentinel file, stops, starts, reads it back
- [x] No MITM warnings on reconnect (host key persists) — verified with `ssh -o StrictHostKeyChecking=yes` against a pre-stop `known_hosts` post-restart; ed25519 fingerprint matches.
- [x] Reasonable boot time documented (target: under 10s warm boot) — measured 4.9s wall-clock from `splite start` to ssh-ready on M-series Mac Mini. Lume status flips to `running` in ~0.6s; the rest is kernel + sshd warm-up.

### Phase 6 — Checkpoints
**Done — 2026-05-06.**

- [x] `splite checkpoint create [-s name]` — APFS `clonefile(2)` of the splite's disk into `~/.splites/vms/<name>/checkpoints/<id>/`
- [x] `splite checkpoint list [-s name]` — id, created_at, size delta vs base
- [x] `splite checkpoint restore <id> [-s name]` — stop VM, swap disk, restart; ad-hoc processes die, services restart (sprites semantics)
- [x] Last-5 retention; older auto-GC'd at create time
- [x] Smoke test: create > write file > checkpoint > delete file > restore > file is back; <1s for checkpoint create on a 10GB-divergent disk — verified 2026-05-06 with 0.25s checkpoint (sync+clonefile) and 12.3s restore (stop+clone+start).

The "mount last 5 read-only inside the guest at `/.splite/checkpoints/<id>/` (sprites parity)" box was dropped 2026-05-06. Reasoning: the in-guest mount is only useful when checkpoints have nowhere else to live. Splites is going to push checkpoints to R2 (alongside the Worker + DO each splite already gets), which makes them addressable from anywhere — `curl`, the cells worker, another splite. The "browse old state" need stops happening from inside the splite. Replaced by the R2 sync box in Phase 9.

### Phase 7 — Destroy
**Done — 2026-05-06.**

- [x] `splite destroy [-s name] --yes` — confirm name match, stop VM, `rm -rf ~/.splites/vms/<name>/`, deregister from registry
- [x] Idempotent — destroy of non-existent splite returns success with a "not found" note
- [x] `splite rm` alias
- [x] Smoke test: create > destroy > list shows it's gone > directory is gone — verified 2026-05-06 against `destroyme` (5s create, 12s destroy).

### Phase 8 — Daemon REST API
**Done — 2026-05-06.**

- [x] `splited` HTTP server on `:7878` — TypeBox-validated request/response shapes (`lib/schemas.ts`; daemon self-checks responses against the schema before sending)
- [x] Endpoints: `POST /v1/splites`, `GET /v1/splites`, `GET /v1/splites/{n}`, `DELETE /v1/splites/{n}`, `POST /v1/splites/{n}/start|stop`, `POST /v1/splites/{n}/checkpoints`, `GET /v1/splites/{n}/checkpoints`, `POST /v1/splites/{n}/checkpoints/{id}/restore`
- [x] WS `/v1/splites/{n}/exec` for streaming exec (matches sprites WSS shape)
- [x] Bearer token auth from `~/.splites/token` (auto-generated on first run, mode 0600)
- [x] CLI flips to talk to daemon instead of doing engine ops directly; daemon is the single writer of state
- [x] `splite api ...` raw passthrough (matches `sprite api`)
- [x] Smoke test: cells's `cells.ts:api()` works against `SPRITES_API_URL=http://localhost:7878 SPRITES_TOKEN=$(cat ~/.splites/token)` (path noun aside) — `scripts/smoke-cells-api.ts` mimics cells's `api()` verbatim and verifies status/url/created_at/last_running_at typing. PASS as of 2026-05-06.

### Phase 9 — Services & public URL bridge
- [x] `PUT /v1/splites/{n}/services/{id}` — declarative service definition (also `DELETE`, `GET`, `GET /services` for list). PUT, not POST: matches cells's `register-site-service.sh:41` wire shape.
- [x] Daemon translates service definition to a systemd unit inside the guest, enables, starts (via ssh + base64-encoded payloads + `sudo systemctl daemon-reload && enable --now`).
- [x] Supports `cmd`, `args`, `workdir`, `env`, `auto_restart`. Field names match cells (singular `cmd`, `workdir` not `cwd`). `depends_on` and `http_port` deferred — cells doesn't send them, and `http_port` is implicit (8080 via reverse proxy).
- [x] `auto_restart: true` survives `splite stop`/`splite start` (systemd `Restart=always` + `WantedBy=multi-user.target`).
- [ ] **Cloudflare Tunnel installed** as a launchd service on the Mac Mini, advertising `*.splites.cells.md` to splited's reverse proxy — documented step-by-step in `docs/install.md`. Pete-only manual setup; tick once the launchd service is running.
- [ ] **DNS**: wildcard CNAME `*.splites.cells.md` → tunnel hostname (one-time, manual; documented in `docs/install.md`)
- [x] **Splited reverse proxy** routes by `Host` header — `<name>.splites.cells.md` → that splite's guest:8080. HTTP and WebSocket Upgrade both proxied (`lib/proxy.ts` + branch in `daemon/splited.ts`'s `fetch`). Verified live with `curl -H "Host: pete.splites.cells.md" http://127.0.0.1:7878/` and a tiny in-guest WS echo.
- [x] `splite url [-s name]` returns `https://<name>.splites.cells.md` (or errors when `SPLITES_PUBLIC_BASE` isn't set).
- [x] `splite url update --auth=public|splite` — stubbed: `PUT /v1/splites/{n}/url` returns 501 with phase-A note. Per-splite auth override deferred.
- [ ] **WebSocket Upgrade** verified end-to-end through the tunnel (`wscat` against the splite's `/agent`) — local-only WS proxy verified; tunnel verification waits on Pete's host install.
- [x] `POST /v1/splites/{n}/policy/network` egress endpoint accepts the request and returns success — real enforcement deferred to Phase A. Returns `{accepted:true, enforced:false, rules:[...]}` so callers know it's stub-shaped.
- [x] Smoke test: cells's `register-site-service.sh` payload shape succeeds against a splite (`scripts/smoke-register-service.sh`; cells's actual script hardcodes `https://api.sprites.dev` so re-execution against splited needs the `CELLS_BACKEND=splite` shim landing in Phase 10).
- [ ] Smoke test: external `curl https://<name>.splites.cells.md/healthz` reaches the splite — waits on host install.
- [ ] **Checkpoint sync to R2** — on `splite checkpoint create`, push the new checkpoint's `disk.img` to the splite's R2 bucket under `splites/<name>/checkpoints/<id>/disk.img`. R2 is durable, externally addressable, and survives a host loss. Replaces the dropped Phase 6 in-guest mount: "browse old state" becomes a `curl` from anywhere instead of a mount inside the splite.
- [ ] **Restore-from-R2** — `splite checkpoint restore --from-r2 <id>` pulls the disk back from the splite's R2 bucket and runs the same stop+swap+start as a local restore. Lets a splite be reborn on a fresh host.

See [`decisions/0002-bridge-cloudflare-tunnel.md`](decisions/0002-bridge-cloudflare-tunnel.md) for why traditional tunnel over Workers VPC binding.

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
