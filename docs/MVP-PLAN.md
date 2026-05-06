# Splites — MVP Plan

**MVP complete on 2026-05-06.**

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
- [x] Done when cells's existing `sprite_exec` and `sprite_push` patterns work against a `splite`-aliased call — verified in Phase 10 by `scripts/smoke-cells-call-shapes.sh` (every cells shell-out shape replays cleanly, including `sprite exec` with metacharacters via the shellEscape fix).

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
**Done — 2026-05-06.**
- [x] `PUT /v1/splites/{n}/services/{id}` — declarative service definition (also `DELETE`, `GET`, `GET /services` for list). PUT, not POST: matches cells's `register-site-service.sh:41` wire shape.
- [x] Daemon translates service definition to a systemd unit inside the guest, enables, starts (via ssh + base64-encoded payloads + `sudo systemctl daemon-reload && enable --now`).
- [x] Supports `cmd`, `args`, `workdir`, `env`, `auto_restart`. Field names match cells (singular `cmd`, `workdir` not `cwd`). `depends_on` and `http_port` deferred — cells doesn't send them, and `http_port` is implicit (8080 via reverse proxy).
- [x] `auto_restart: true` survives `splite stop`/`splite start` (systemd `Restart=always` + `WantedBy=multi-user.target`).
- [x] **Cloudflare Tunnel** running as `splites-proxy` (uuid `eaddeff4-...`) advertising `*.splites.cells.md` to splited's reverse proxy. Currently runs as a user process matching cells-proxy's pattern (not launchd) — same supervision shape, fine for solo Mac Mini. Steps in `docs/install.md`.
- [x] **DNS**: wildcard CNAME `*.splites.cells.md` → tunnel via `cloudflared tunnel route dns`. Plus ACM cert ordered through the dashboard (Universal SSL doesn't cover depth-2 wildcards).
- [x] **Splited reverse proxy** routes by `Host` header — `<name>.splites.cells.md` → that splite's guest:8080. HTTP and WebSocket Upgrade both proxied (`lib/proxy.ts` + branch in `daemon/splited.ts`'s `fetch`). Verified live with `curl -H "Host: pete.splites.cells.md" http://127.0.0.1:7878/` and a tiny in-guest WS echo.
- [x] `splite url [-s name]` returns `https://<name>.splites.cells.md` (or errors when `SPLITES_PUBLIC_BASE` isn't set).
- [x] `splite url update --auth=public|splite` — stubbed: `PUT /v1/splites/{n}/url` returns 501 with phase-A note. Per-splite auth override deferred.
- [x] **WebSocket Upgrade** verified end-to-end through the tunnel — `scripts/smoke-public-url.sh` opens `wss://pete.splites.cells.md/agent`, sends a frame, verifies the echo. Roundtrip works.
- [x] `POST /v1/splites/{n}/policy/network` egress endpoint accepts the request and returns success — real enforcement deferred to Phase A. Returns `{accepted:true, enforced:false, rules:[...]}` so callers know it's stub-shaped.
- [x] Smoke test: cells's `register-site-service.sh` payload shape succeeds against a splite (`scripts/smoke-register-service.sh`; cells's actual script hardcodes `https://api.sprites.dev` so re-execution against splited needs the `CELLS_BACKEND=splite` shim landing in Phase 10).
- [x] Smoke test: external `curl https://<name>.splites.cells.md/` reaches the splite — `scripts/smoke-public-url.sh` does the full HTTPS + WSS roundtrip via Cloudflare → cloudflared → splited → guest:8080. ~150ms HTTPS roundtrip on M-series Mac Mini.
- ~~Checkpoint sync to R2~~ — moved to Phase A (2026-05-06).
- ~~Restore-from-R2~~ — moved to Phase A (2026-05-06).

See [`decisions/0002-bridge-cloudflare-tunnel.md`](decisions/0002-bridge-cloudflare-tunnel.md) for why traditional tunnel over Workers VPC binding.

R2 sync (the two struck-through boxes above) was originally in Phase 9 but doesn't gate the MVP done-definition (`cells birth pete --backend=splite` works). Local checkpoints already work; remote durability only matters when restoring on a fresh host. Moved to Phase A so Phase 9 closes on the bridge.

### Phase 10 — Cells integration
**Done — 2026-05-06.**

**Reframed (2026-05-06):** the original plan had cells flipping a `CELLS_BACKEND=splite` env var that branched API URLs, CLI binary names, and bridge URLs inside cells's code. We dropped that approach. Splites adapts to the sprites contract instead — same paths, same verbs, same flags, same field shapes. Cells stays untouched; pointing `SPRITES_API_URL` and (optionally) symlinking `sprite → splite` is the entire integration. Captured in `docs/sprites-parity.md`.

- [x] **Sprites contract documented** — `docs/sprites-parity.md` catalogues every cells API call site and CLI shell-out from `~/Projects/cells`, with file:line refs. The contract splites is committed to.
- [x] **Daemon path alias** — `/v1/sprites/...` rewrites to `/v1/splites/...` at the top of `fetch()`. Cells's `api()` calls work verbatim.
- [x] **Synchronous exec endpoint** — `POST /v1/splites/{n}/exec` with `{command:[…]}` body, `{exit_code,stdout,stderr,truncated?}` response. Cells's `deliberate/index.ts` shape.
- [x] **GET /policy/network** with persistence — POST atomically writes `~/.splites/vms/{n}/policy.json`, GET reads it back; ENOENT yields `{rules:[]}`.
- [x] **Per-splite URL auth toggle** — real `PUT /v1/splites/{n}/url` and proxy gate. `splite url update --auth=public|splite` (cells's hatch step). Replaced the Phase 9 501 stub.
- [x] **CLI flag/verb parity** — `splite destroy --force` (alias of `--yes`), top-level `splite restore <id>`, `splite url update --auth=...`, `splite checkpoint create --comment <label>`, `splite info` emits `URL:` line for `awk '/^URL:/'`, `splite api -s/-X/-H` curl-flavored flag tolerance.
- [x] **Exec shell-escape** — `lib/shellEscape.ts` shared between daemon and CLI; `splite exec` no longer mangles `;`, `$VAR`, quotes when forwarding to ssh. Latent bug from Phase 4 fixed.
- [x] **End-to-end smoke** — `scripts/smoke-cells-call-shapes.sh` replays every catalogued cells call shape against a live splited+splite. PASS as of 2026-05-06.
- [x] **Cells-side integration is cells's job.** `cells birth/talk/checkpoint/sleep/wake/destroy` will run unchanged when cells points its `SPRITES_API_URL` at splited and symlinks `sprite → splite`. No cells edits required by splites.
- [x] **Squash-merge `feature/mvp` into `main`. Tag `v0.1.0`.** Local only — push when ready.

### Phase A — Mature management

The pieces sprites has that splites must add for a real-world fleet on owned hardware. Ordered by user-visible impact: autosleep first (the "feels like sprites" bump), then R2 (durability, gates Phase E), then egress (security teeth on the existing stub), then retention.

**Branch:** `feature/phase-a`. Squash to `main` and tag `v0.2.0` when all boxes are checked.

#### A.1 — Autosleep, wake, warm

The full sprite-style "ephemeral by default" feel: splites stop themselves quickly when idle, wake themselves on demand, and use a warm tier so wake is sub-second. End state: you spin up a splite, do work, walk away. It sleeps in 60s. You hit it again, it's back in <1s.

- **A.1.1 Idle watchdog (per-splite).** Splited tracks per-splite "last touched" timestamp. After `auto_sleep_seconds` of inactivity, runs `splite stop`. Override per splite with `auto_sleep_seconds: null` (never sleep) or a custom value. Persisted in registry record.
  - [x] A.1.1.a — Touch tracking + idle-decision logic. In-memory `last_touched_at` per splite (`lib/idle.ts`), bumped on every authed `/v1/splites/{n}/...` API hit, every WS frame (exec + proxy), and every proxy HTTP request. `auto_sleep_seconds?: number | null` field on `SpliteRecord`. Pure `shouldAutoSleep` function with full test coverage. No auto-stop yet.
  - [x] A.1.1.b — Override knob. `splite auto-sleep --seconds N | --never [-s name]` CLI + `PATCH /v1/splites/{n}` endpoint. Global default in `~/.splites/defaults.json`. pete pinned to `null` ahead of the watchdog.
  - [x] A.1.1.c — Watchdog loop. `setInterval` (every 30s, unref'd) in splited that scans, calls `stopSplite(name)` for any running splite where `shouldAutoSleep` returns true. Pure tick fn in `lib/watchdog.ts` with 9 unit tests covering override semantics, stop failures, scoping. Default global `auto_sleep_seconds` dropped from 600 → 60. Live-smoked: pete temporarily un-pinned with 5s timeout, watchdog stopped it within ~35s ("watchdog: auto-sleeping idle splite" in the log), then restored to running + re-pinned. **A.1.1 (idle watchdog) is fully done.**
- [x] **A.1.2 Wake-on-demand.** `lib/wake.ts` exposes `ensureRunning(name, timeoutMs)` with a per-name in-flight cache so concurrent requests for a stopped splite all await the same start (verified: 3 simultaneous requests = 1 boot, ~5s total). Wired into the proxy branch (HTTP + WS), HTTP exec, services PUT/DELETE, and checkpoint create. Cap is 10s; 504 with `wake_failed` if it doesn't come up. 6 unit tests cover the dedup logic; live-smoked: stopped pete + POST exec returned correct stdout in 5s wall-clock.
- [ ] **A.1.3 Cold / warm / hot tiering — core lifecycle research.** This is the most foundational work in Phase A. The current touch-on-API-call model from A.1.1 is too coarse: real activity (in-guest compile, ssh session, agent loop, background job) often doesn't hit our API, and the watchdog could kill a splite mid-work. Pete's call: don't just ship save/restore — iterate until we know the answer to the questions below. Multi-fire investigation; ships when defaults are picked from data.

  **Open questions A.1.3 must answer (with experiments):**
  - **Activity detection.** What signals do we watch besides API touches? Candidates: in-guest CPU%, active ssh session count, in-flight TCP connection count to the guest, host-side bytes/sec through the tap interface, an in-guest "I'm busy/idle" agent. Heuristic vs. signaled? Cost of each?
  - **Mid-job safety.** Define the scenarios that must NEVER trigger a sleep: (a) compile/build, (b) interactive ssh, (c) Claude Code/Pi agent running locally, (d) inbound TCP connection in-flight, (e) a service mid-request. What's the rule for each?
  - **Finish-detection.** When work completes, can we warm-down immediately instead of waiting 60s? Signals for "work just finished" — e.g., last connection closed and CPU dropped.
  - **Tier targets.** Sprites's cold/warm/hot definitions vs. ours. Hot (paused, RAM-resident, <1ms wake) vs. warm (state-saved-to-disk, VM exited, ~1s wake) vs. cold (full shutdown, ~5s). Aggressive defaults possible because we own the box; what numbers fall out of measurement?
  - **VZ + lume primitives.** What does `Virtualization.framework` actually expose (pause, resume, saveState, restoreState)? What does lume already wrap, and what needs a patch?

  Sub-boxes (each fire ticks one):
  - [ ] A.1.3.a — Scenario inventory + signal catalogue. Write `docs/state-tiers.md` v1: list every "in the middle of something" scenario, every observable signal, the rule that maps signals → "stop" / "warm" / "wait". No code yet — get the framework down so subsequent fires implement against it.
  - [ ] A.1.3.b — VZ + lume primitive discovery. Read Apple's Virtualization.framework docs for pause/resume + saveMachineStateTo/restoreMachineStateFrom. Read lume source for what's exposed today. Document gap. Result in `docs/state-tiers.md`: "lume can do X today; warm tier needs patch Y."
  - [ ] A.1.3.c — Benchmark cold/warm/hot transitions. Median + p95 for each, on a clean splite. RAM cost per hot, disk cost per warm-state file. Write the numbers into `docs/state-tiers.md`.
  - [ ] A.1.3.d — Activity-detection prototype. Pick the 1–2 strongest signals from A.1.3.a (probably: in-guest CPU + active ssh sessions). Implement as a polling probe in splited; expose readings via `splite info`. Validate against the scenarios from A.1.3.a — does each "in the middle" case correctly NOT trigger sleep?
  - [ ] A.1.3.e — Lume patch (if needed). Add warm save/restore primitive in `vendor/lume.patches/` if discovery shows it's missing.
  - [ ] A.1.3.f — Wire tiers into splited. `stopSplite(name, {tier})` with watchdog choosing tier based on idle duration + activity signals. `splite stop` defaults to warm; `--cold` for full shutdown. `splite info` surfaces current tier.
  - [ ] A.1.3.g — Smoke: scenario coverage. Each scenario from A.1.3.a tested live (compile + check no-sleep, ssh session + check no-sleep, etc.). Tier transition smoke (hot→warm→cold and back) with measured wake budgets.
- [ ] **A.1.4 Pre-baked pool.** Splited keeps `pool_size` (default 1) of pre-baked, pre-booted-then-warmed splites in `pool/` (separate registry namespace). `splite create <name>` adopts a pool member: rename, re-cidata for identity, restore from warm state. Target: <2s end-to-end. Pool refills async after adoption. Depends on A.1.3.
- [ ] **A.1.5 Pool config.** `~/.splites/defaults.json` gains `pool_size`. `splite pool list|refill|drain` CLI. `GET /v1/splites/pool` endpoint for visibility.
- [ ] **A.1.6 Smoke: full lifecycle.** `scripts/smoke-warm-pool.sh` measures pool-adoption create, idles past auto-sleep, hits the URL, measures wake. Asserts targets: <2s create, <1s wake.

#### A.2 — Checkpoint sync to R2

R2 creds live per-splite in `meta.json`. Splite create accepts `--r2-endpoint`, `--r2-bucket`, `--r2-key`, `--r2-secret`; daemon stores them; checkpoint sync uses them. Each splite's R2 path is `<bucket>/splites/<name>/checkpoints/<id>/disk.img`. (Cells's eventual integration: cells's worker creates the bucket+keys when birthing a splite-backed cell and passes them in via the create body.)

- [ ] **R2 client (`lib/r2.ts`).** S3-compatible streaming PUT/GET via `bun:s3` (or AWS SDK if `bun:s3` lacks something). Uses per-splite creds from `SpliteRecord`.
- [ ] **`splite checkpoint create` pushes to R2.** When the splite has R2 configured, after the local clonefile, stream `disk.img` to `splites/<name>/checkpoints/<id>/disk.img`. Best-effort; failure logs a warning but doesn't fail the checkpoint create. Adds `r2_uploaded: bool` to checkpoint metadata.
- [ ] **`splite checkpoint restore --from-r2 <id>`.** Pulls the disk back into the bundle, then runs the existing stop+swap+start. Useful for fresh-host restore. CLI: top-level `--from-r2` flag on the existing `restore` verb.
- [ ] **R2 GC tracks local retention.** When local retention rotates a checkpoint out, also remove the R2 object. New env `SPLITES_R2_RETAIN_FOREVER=1` to keep R2 forever.
- [ ] **Smoke: round-trip.** `scripts/smoke-r2-sync.sh` creates a checkpoint, verifies the R2 object, deletes the local checkpoint, restores from R2, verifies disk integrity.

#### A.3 — Egress enforcement

The `POST /v1/splites/{n}/policy/network` endpoint already persists rules (Phase 10 chunk 3). What's missing is actually enforcing them on the wire.

- [ ] **pf rule generation per splite tap.** Each splite has a vmnet tap interface (lume manages it). Splited generates pf rules to allow/deny traffic per the splite's policy. Anchor per splite (e.g. `splite/<name>`) to keep state clean. Rules generated from `policy.json` on POST and on splited startup.
- [ ] **DNS-based deny for domain rules.** Run a per-host resolver (dnsmasq or unbound) that splited configures with the splite's domain rules. Splite's `/etc/resolv.conf` (set by cloud-init) points at the host resolver. Deny = NXDOMAIN.
- [ ] **`enforced: true` flag flips when rules are live.** The existing response field switches from stub to honest reporting.
- [ ] **Smoke: blocked vs. allowed.** `scripts/smoke-egress.sh` adds an allow rule for `github.com`, denies `evil.com`, exec's curl in the splite, asserts the right outcomes.

#### A.4 — Retention with explicit expiration

- [ ] **`splite checkpoint create --retain-for <duration>`.** Per-checkpoint TTL (e.g. `7d`, `2h`). Persisted in checkpoint meta. GC removes expired checkpoints before applying the last-N rule.
- [ ] **`splite checkpoint expire <id>`.** Force-delete a checkpoint regardless of retention.
- [ ] **Configurable last-N.** `~/.splites/defaults.json` adds `checkpoint_retain_count` (default 5). Per-splite override on create.

### Phase E — Linux hosting (engine pluralism)

The Mac MVP proves the architecture. Phase E ports it to a Linux host so splites can live on a $20/mo VPS instead of a Mac in your closet. The user-facing surface (CLI verbs, REST shapes, cells integration) stays identical — only the engine boundary swaps. ADR: [`decisions/0003-multi-engine.md`](decisions/0003-multi-engine.md).

**Branch:** `feature/phase-e`. Squash to `main` and tag `v0.3.0` when all boxes are checked.

**Hosting target:** Hetzner CCX21 (4 vCPU, 16 GB RAM, KVM-enabled, ~$30/mo) or any KVM-enabled Linux VPS. Code targets generic KVM Linux; smoke runs against Hetzner.

#### E.1 — Engine boundary cleanup

- [ ] **Document the engine interface.** `engine/INTERFACE.md` enumerates the contract every engine satisfies: `create`, `delete`, `start`, `stop`, `info`, `list`, plus the disk path conventions and cidata expectations. `engine/lume.ts` is reference impl.
- [ ] **Engine selection.** `SPLITES_ENGINE` env var (`lume` | `firecracker`). Default by `os.platform()`: Darwin → lume, Linux → firecracker. Splited picks at startup.
- [ ] **Disk-clone abstraction (`lib/clonefile.ts` → `lib/diskClone.ts`).** Detect filesystem at startup: APFS uses `clonefile(2)`, btrfs/xfs uses `cp --reflink=auto`, fallback creates a qcow2 backing file. Same `cloneDisk(src, dst)` API regardless.
- [ ] **DHCP discovery abstraction.** `lib/dhcp.ts` already reads `/var/db/dhcpd_leases` on Mac. Add Linux readers for `dnsmasq.leases` and `systemd-networkd` lease files. Engine config tells which backend to use.

#### E.2 — Firecracker engine

- [ ] **`engine/firecracker.ts` skeleton.** Wraps the firecracker REST API (Unix socket `/tmp/firecracker-<n>.sock`). Implements the engine interface from E.1.
- [ ] **Boot flow.** Kernel + initrd path conventions; cidata ISO mounted as a second drive. Same Ubuntu 25.10 cloud image as Mac (it's KVM-bootable).
- [ ] **Network: tap + bridge.** Splited creates a tap per splite, attaches to a bridge (`splites0`). DHCP via dnsmasq running on the host (configured by splited at startup).
- [ ] **Lifecycle parity smoke.** Same lifecycle.test.ts but pointing at firecracker engine. `bun test` passes on a Linux box.

#### E.3 — Hosting smoke

- [ ] **`scripts/install-linux-host.sh`.** One-shot setup for a fresh Hetzner box: install firecracker, dnsmasq, splited deps; configure systemd unit; download base image; enable IP forwarding. Idempotent.
- [ ] **`scripts/smoke-cells-call-shapes.sh` runs Linux-side.** Same smoke that gates Mac, against splited running on the VPS via a tunnel.
- [ ] **Cross-host checkpoint round-trip.** Create on Mac, push to R2 (Phase A.2), restore on Hetzner. Document any disk-format limitations discovered.

#### E.4 — Documentation

- [ ] **`docs/install-linux.md`.** Counterpart to `docs/install.md`. Hetzner-specific tips for cloudflared + ACM cert + firewall.
- [ ] **`docs/architecture.md` update.** Lifecycle diagram updated to show both engines side-by-side.

## Loop discipline

When the `/mvp-splites` loop fires, the running agent should:

1. Read this file. Find the first phase with unchecked items.
2. Identify the smallest next checkbox to make progress on.
3. Implement it. Write tests where it makes sense. Run them.
4. Commit with a clear message naming the phase + checkbox.
5. Update the checkboxes in this file. Commit the doc change too (or in the same commit).
6. If a whole phase is complete, append a short note under the phase title: `**Done — <yyyy-mm-dd>.**`, squash-merge that phase's branch to `main`, tag the version (Phase A → `v0.2.0`, Phase E → `v0.3.0`), then start the next phase.

**Bounded:** one loop run = roughly one focused chunk of work. If a checkbox is huge, decompose it into sub-checkboxes during the run; check the easy ones, defer the rest.

**Branch convention:** one feature branch per phase. MVP shipped on `feature/mvp` (already merged + tagged `v0.1.0`). Phase A lives on `feature/phase-a`, Phase E on `feature/phase-e`. Don't commit to `main` directly — only the phase-end squash-merge lands on `main`.

**When stuck:** write the blocker to `docs/BLOCKED.md` (date, what was tried, what's needed from Pete). Commit. Stop the run. The next run reads BLOCKED.md and skips new work until it's resolved.
