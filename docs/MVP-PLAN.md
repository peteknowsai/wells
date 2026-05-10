# Wells — MVP Plan

**MVP complete on 2026-05-06.**

The smallest thing that makes wells a drop-in for sprites: birth a Pi cell on a local Linux well via `cells birth --backend=well`, and reach it via the existing `<name>.cells.md` Cloudflare Worker bridge.

## Constraints

- **Host:** Mac Mini (arm64). Single host for v1.
- **Guest:** Ubuntu 25.10 arm64. Mirrors current sprites baseline (Node, Python, Go, Ruby, Rust, git, curl, build tools, Claude Code).
- **Engine:** vendored lume → Apple's Virtualization.framework.
- **Stack:** Bun + TypeScript.
- **State:** `~/.wells/` (registry, images, vms, checkpoints).
- **Daemon:** `welld` on `:7878`, sprites-shaped REST.
- **CLI:** `well`, thin client to `welld`.

## Done definition

`cells birth pete --backend=well` produces a working Pi cell on a local well. `cells talk pete` reaches it via the CF Worker bridge. State persists across `well stop` / `well start`. `well checkpoint create` snapshots in <1s. `well destroy pete --yes` reclaims the disk.

## Phases

### Phase 0 — Repo bootstrap
**Done — 2026-05-05.**

- [x] `package.json` (Bun, TypeScript, TypeBox), `tsconfig.json`
- [x] CLI entry `cli/well.ts` with `--version`, `--help`, no-op subcommand stubs
- [x] Daemon entry `daemon/welld.ts` that listens on `:7878` and responds to `GET /healthz`
- [x] State dir helper (`lib/state.ts`) — paths under `~/.wells/`, ensure-dir helpers
- [x] Logging helper (`lib/log.ts`) — structured JSON to stderr, level via `WELL_LOG_LEVEL`
- [x] `bun run well` and `bun run welld` work from the repo root
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
- [x] Boots once via lume, runs cloud-init (orchestrator composes the static template with a build-time ssh keypair so the host can poll `/etc/.wells-base-ready`), shuts down when the marker appears, saves the baked output to `~/.wells/images/ubuntu-25.10-base/disk.img`. The pristine cloud-image download stays at `~/.wells/images/ubuntu-25.10-base/cloud-image.img` (input); `disk.img` is the output ready to clone.
- [x] Idempotent — skip if `disk.img` exists; `--force` rebuilds
- [x] Smoke test: image boots in lume, `lume ssh -- uname -a` returns 0

### Phase 3 — Create / list / info
**Done — 2026-05-06.**

- [x] `well create <name>` — clone the base `disk.img` file via APFS `clonefile(2)` into `~/.wells/vms/<name>/disk.img`; generate per-well cloud-init seed (unique hostname, fresh ssh host keys via `ssh_genkeytypes:` so each well has its own keypair, host's authorized_key for `well exec`); `lume run`; wait for ssh-ready
- [x] Reject reserved names (`mother`, `keeper`, etc.) and duplicates
- [x] **Resource knobs**: `well create --cpu=N --memory=NG --disk=NG`. Defaults: 4 vCPU, 4 GB RAM, 50 GB disk (scaled for shared-host use; sprites defaults aren't appropriate when multiple wells cohabit a Mac Mini). Tunable globally via `~/.wells/defaults.json`.
- [x] `well list` — read state, render table (name, status, age, ip)
- [x] `well info <name>` — JSON or pretty-print: status, ip, disk usage, uptime, cpu/memory/disk allocation
- [x] `well use <name>` — write `.well` JSON in cwd; subsequent commands without `-s` use it
- [x] State schema documented in `docs/state-schema.md`
- [x] Smoke test: `well create pete && well info pete` shows a running well with an IP — passed 2026-05-06, end-to-end ~5s, ssh + Node 22 + Claude Code verified.

### Phase 4 — Exec & files
**Implementation done — 2026-05-06. Cells parity verified in Phase 10.**

- [x] `well exec [-s name] [--tty] -- <cmd> [args]` — ssh into the well, stream stdout/stderr to the caller, return guest exit code
- [x] Per-well ssh keys generated at create, stored in the bundle, never committed (live under `~/.wells/vms/<n>/ssh_key`, outside the repo by construction)
- [x] `well console [-s name]` — interactive PTY shell, Ctrl+\ to detach (sprites parity, not Ctrl+D)
- [x] Tar-pipe pattern works: `tar c <dir> | well exec -- tar xz -C /target`
- [x] Done when cells's existing `sprite_exec` and `sprite_push` patterns work against a `well`-aliased call — verified in Phase 10 by `scripts/smoke-cells-call-shapes.sh` (every cells shell-out shape replays cleanly, including `sprite exec` with metacharacters via the shellEscape fix).

### Phase 5 — Lifecycle
**Done — 2026-05-06.**

- [x] `well stop [-s name]` — graceful guest shutdown (`shutdown -h now` over ssh, then `lume stop`), VM process exits, disk persists
- [x] `well start [-s name]` — boot existing VM from the persistent disk, reuse same IP, same ssh host key
- [x] State survives stop/start: smoke test writes a sentinel file, stops, starts, reads it back
- [x] No MITM warnings on reconnect (host key persists) — verified with `ssh -o StrictHostKeyChecking=yes` against a pre-stop `known_hosts` post-restart; ed25519 fingerprint matches.
- [x] Reasonable boot time documented (target: under 10s warm boot) — measured 4.9s wall-clock from `well start` to ssh-ready on M-series Mac Mini. Lume status flips to `running` in ~0.6s; the rest is kernel + sshd warm-up.

### Phase 6 — Checkpoints
**Done — 2026-05-06.**

- [x] `well checkpoint create [-s name]` — APFS `clonefile(2)` of the well's disk into `~/.wells/vms/<name>/checkpoints/<id>/`
- [x] `well checkpoint list [-s name]` — id, created_at, size delta vs base
- [x] `well checkpoint restore <id> [-s name]` — stop VM, swap disk, restart; ad-hoc processes die, services restart (sprites semantics)
- [x] Last-5 retention; older auto-GC'd at create time
- [x] Smoke test: create > write file > checkpoint > delete file > restore > file is back; <1s for checkpoint create on a 10GB-divergent disk — verified 2026-05-06 with 0.25s checkpoint (sync+clonefile) and 12.3s restore (stop+clone+start).

The "mount last 5 read-only inside the guest at `/.well/checkpoints/<id>/` (sprites parity)" box was dropped 2026-05-06. Reasoning: the in-guest mount is only useful when checkpoints have nowhere else to live. Wells is going to push checkpoints to R2 (alongside the Worker + DO each well already gets), which makes them addressable from anywhere — `curl`, the cells worker, another well. The "browse old state" need stops happening from inside the well. Replaced by the R2 sync box in Phase 9.

### Phase 7 — Destroy
**Done — 2026-05-06.**

- [x] `well destroy [-s name] --yes` — confirm name match, stop VM, `rm -rf ~/.wells/vms/<name>/`, deregister from registry
- [x] Idempotent — destroy of non-existent well returns success with a "not found" note
- [x] `well rm` alias
- [x] Smoke test: create > destroy > list shows it's gone > directory is gone — verified 2026-05-06 against `destroyme` (5s create, 12s destroy).

### Phase 8 — Daemon REST API
**Done — 2026-05-06.**

- [x] `welld` HTTP server on `:7878` — TypeBox-validated request/response shapes (`lib/schemas.ts`; daemon self-checks responses against the schema before sending)
- [x] Endpoints: `POST /v1/wells`, `GET /v1/wells`, `GET /v1/wells/{n}`, `DELETE /v1/wells/{n}`, `POST /v1/wells/{n}/start|stop`, `POST /v1/wells/{n}/checkpoints`, `GET /v1/wells/{n}/checkpoints`, `POST /v1/wells/{n}/checkpoints/{id}/restore`
- [x] WS `/v1/wells/{n}/exec` for streaming exec (matches sprites WSS shape)
- [x] Bearer token auth from `~/.wells/token` (auto-generated on first run, mode 0600)
- [x] CLI flips to talk to daemon instead of doing engine ops directly; daemon is the single writer of state
- [x] `well api ...` raw passthrough (matches `sprite api`)
- [x] Smoke test: cells's `cells.ts:api()` works against `SPRITES_API_URL=http://localhost:7878 SPRITES_TOKEN=$(cat ~/.wells/token)` (path noun aside) — `scripts/smoke-cells-api.ts` mimics cells's `api()` verbatim and verifies status/url/created_at/last_running_at typing. PASS as of 2026-05-06.

### Phase 9 — Services & public URL bridge
**Done — 2026-05-06.**
- [x] `PUT /v1/wells/{n}/services/{id}` — declarative service definition (also `DELETE`, `GET`, `GET /services` for list). PUT, not POST: matches cells's `register-site-service.sh:41` wire shape.
- [x] Daemon translates service definition to a systemd unit inside the guest, enables, starts (via ssh + base64-encoded payloads + `sudo systemctl daemon-reload && enable --now`).
- [x] Supports `cmd`, `args`, `workdir`, `env`, `auto_restart`. Field names match cells (singular `cmd`, `workdir` not `cwd`). `depends_on` and `http_port` deferred — cells doesn't send them, and `http_port` is implicit (8080 via reverse proxy).
- [x] `auto_restart: true` survives `well stop`/`well start` (systemd `Restart=always` + `WantedBy=multi-user.target`).
- [x] **Cloudflare Tunnel** running as `wells-proxy` (uuid `eaddeff4-...`) advertising `*.wells.cells.md` to welld's reverse proxy. Currently runs as a user process matching cells-proxy's pattern (not launchd) — same supervision shape, fine for solo Mac Mini. Steps in `docs/install.md`.
- [x] **DNS**: wildcard CNAME `*.wells.cells.md` → tunnel via `cloudflared tunnel route dns`. Plus ACM cert ordered through the dashboard (Universal SSL doesn't cover depth-2 wildcards).
- [x] **Welld reverse proxy** routes by `Host` header — `<name>.wells.cells.md` → that well's guest:8080. HTTP and WebSocket Upgrade both proxied (`lib/proxy.ts` + branch in `daemon/welld.ts`'s `fetch`). Verified live with `curl -H "Host: pete.wells.cells.md" http://127.0.0.1:7878/` and a tiny in-guest WS echo.
- [x] `well url [-s name]` returns `https://<name>.wells.cells.md` (or errors when `WELL_PUBLIC_BASE` isn't set).
- [x] `well url update --auth=public|well` — stubbed: `PUT /v1/wells/{n}/url` returns 501 with phase-A note. Per-well auth override deferred.
- [x] **WebSocket Upgrade** verified end-to-end through the tunnel — `scripts/smoke-public-url.sh` opens `wss://pete.wells.cells.md/agent`, sends a frame, verifies the echo. Roundtrip works.
- [x] `POST /v1/wells/{n}/policy/network` egress endpoint accepts the request and returns success — real enforcement deferred to Phase A. Returns `{accepted:true, enforced:false, rules:[...]}` so callers know it's stub-shaped.
- [x] Smoke test: cells's `register-site-service.sh` payload shape succeeds against a well (`scripts/smoke-register-service.sh`; cells's actual script hardcodes `https://api.sprites.dev` so re-execution against welld needs the `CELLS_BACKEND=well` shim landing in Phase 10).
- [x] Smoke test: external `curl https://<name>.wells.cells.md/` reaches the well — `scripts/smoke-public-url.sh` does the full HTTPS + WSS roundtrip via Cloudflare → cloudflared → welld → guest:8080. ~150ms HTTPS roundtrip on M-series Mac Mini.
- ~~Checkpoint sync to R2~~ — moved to Phase A (2026-05-06).
- ~~Restore-from-R2~~ — moved to Phase A (2026-05-06).

See [`decisions/0002-bridge-cloudflare-tunnel.md`](decisions/0002-bridge-cloudflare-tunnel.md) for why traditional tunnel over Workers VPC binding.

R2 sync (the two struck-through boxes above) was originally in Phase 9 but doesn't gate the MVP done-definition (`cells birth pete --backend=well` works). Local checkpoints already work; remote durability only matters when restoring on a fresh host. Moved to Phase A so Phase 9 closes on the bridge.

### Phase 10 — Cells integration
**Done — 2026-05-06.**

**Reframed (2026-05-06):** the original plan had cells flipping a `CELLS_BACKEND=well` env var that branched API URLs, CLI binary names, and bridge URLs inside cells's code. We dropped that approach. Wells adapts to the sprites contract instead — same paths, same verbs, same flags, same field shapes. Cells stays untouched; pointing `SPRITES_API_URL` and (optionally) symlinking `sprite → well` is the entire integration. Captured in `docs/sprites-parity.md`.

- [x] **Sprites contract documented** — `docs/sprites-parity.md` catalogues every cells API call site and CLI shell-out from `~/Projects/cells`, with file:line refs. The contract wells is committed to.
- [x] **Daemon path alias** — `/v1/sprites/...` rewrites to `/v1/wells/...` at the top of `fetch()`. Cells's `api()` calls work verbatim.
- [x] **Synchronous exec endpoint** — `POST /v1/wells/{n}/exec` with `{command:[…]}` body, `{exit_code,stdout,stderr,truncated?}` response. Cells's `deliberate/index.ts` shape.
- [x] **GET /policy/network** with persistence — POST atomically writes `~/.wells/vms/{n}/policy.json`, GET reads it back; ENOENT yields `{rules:[]}`.
- [x] **Per-well URL auth toggle** — real `PUT /v1/wells/{n}/url` and proxy gate. `well url update --auth=public|well` (cells's hatch step). Replaced the Phase 9 501 stub.
- [x] **CLI flag/verb parity** — `well destroy --force` (alias of `--yes`), top-level `well restore <id>`, `well url update --auth=...`, `well checkpoint create --comment <label>`, `well info` emits `URL:` line for `awk '/^URL:/'`, `well api -s/-X/-H` curl-flavored flag tolerance.
- [x] **Exec shell-escape** — `lib/shellEscape.ts` shared between daemon and CLI; `well exec` no longer mangles `;`, `$VAR`, quotes when forwarding to ssh. Latent bug from Phase 4 fixed.
- [x] **End-to-end smoke** — `scripts/smoke-cells-call-shapes.sh` replays every catalogued cells call shape against a live welld+well. PASS as of 2026-05-06.
- [x] **Cells-side integration is cells's job.** `cells birth/talk/checkpoint/sleep/wake/destroy` will run unchanged when cells points its `SPRITES_API_URL` at welld and symlinks `sprite → well`. No cells edits required by wells.
- [x] **Squash-merge `feature/mvp` into `main`. Tag `v0.1.0`.** Local only — push when ready.

### Phase A — Mature management

The pieces sprites has that wells must add for a real-world fleet on owned hardware. Ordered by user-visible impact: autosleep first (the "feels like sprites" bump), then R2 (durability, gates Phase E), then egress (security teeth on the existing stub), then retention.

**Branch:** `feature/phase-a`. Squash to `main` and tag `v0.2.0` when all boxes are checked.

#### A.1 — Autosleep, wake, warm

The full sprite-style "ephemeral by default" feel: wells stop themselves quickly when idle, wake themselves on demand, and use a warm tier so wake is sub-second. End state: you spin up a well, do work, walk away. It sleeps in 60s. You hit it again, it's back in <1s.

- **A.1.1 Idle watchdog (per-well).** Welld tracks per-well "last touched" timestamp. After `auto_sleep_seconds` of inactivity, runs `well stop`. Override per well with `auto_sleep_seconds: null` (never sleep) or a custom value. Persisted in registry record.
  - [x] A.1.1.a — Touch tracking + idle-decision logic. In-memory `last_touched_at` per well (`lib/idle.ts`), bumped on every authed `/v1/wells/{n}/...` API hit, every WS frame (exec + proxy), and every proxy HTTP request. `auto_sleep_seconds?: number | null` field on `WellRecord`. Pure `shouldAutoSleep` function with full test coverage. No auto-stop yet.
  - [x] A.1.1.b — Override knob. `well auto-sleep --seconds N | --never [-s name]` CLI + `PATCH /v1/wells/{n}` endpoint. Global default in `~/.wells/defaults.json`. pete pinned to `null` ahead of the watchdog.
  - [x] A.1.1.c — Watchdog loop. `setInterval` (every 30s, unref'd) in welld that scans, calls `stopWell(name)` for any running well where `shouldAutoSleep` returns true. Pure tick fn in `lib/watchdog.ts` with 9 unit tests covering override semantics, stop failures, scoping. Default global `auto_sleep_seconds` dropped from 600 → 60. Live-smoked: pete temporarily un-pinned with 5s timeout, watchdog stopped it within ~35s ("watchdog: auto-sleeping idle well" in the log), then restored to running + re-pinned. **A.1.1 (idle watchdog) is fully done.**
- [x] **A.1.2 Wake-on-demand.** `lib/wake.ts` exposes `ensureRunning(name, timeoutMs)` with a per-name in-flight cache so concurrent requests for a stopped well all await the same start (verified: 3 simultaneous requests = 1 boot, ~5s total). Wired into the proxy branch (HTTP + WS), HTTP exec, services PUT/DELETE, and checkpoint create. Cap is 10s; 504 with `wake_failed` if it doesn't come up. 6 unit tests cover the dedup logic; live-smoked: stopped pete + POST exec returned correct stdout in 5s wall-clock.
- [ ] **A.1.3 Lifecycle states — alive vs hibernating.** Originally framed as cold/warm/hot tiering; **collapsed 2026-05-07** to two states (alive, hibernating) plus a future Frozen tier (R2 offload). See [`docs/lifecycle.md`](lifecycle.md) for the canonical model; [`docs/state-tiers.md`](state-tiers.md) keeps the original three-tier investigation as archaeology. Drop "cold" semantics entirely — explicit shutdown is `well destroy`, not a tier. The current touch-on-API-call model from A.1.1 is too coarse: real activity (in-guest compile, ssh session, agent loop, background job) often doesn't hit our API, and the watchdog could kill a well mid-work. Pete's call: don't just ship save/restore — iterate until we know the answer to the questions below.

  **Open questions A.1.3 must answer (with experiments):**
  - **Activity detection.** What signals do we watch besides API touches? Candidates: in-guest CPU%, active ssh session count, in-flight TCP connection count to the guest, host-side bytes/sec through the tap interface, an in-guest "I'm busy/idle" agent. Heuristic vs. signaled? Cost of each?
  - **Mid-job safety.** Define the scenarios that must NEVER trigger a sleep: (a) compile/build, (b) interactive ssh, (c) Claude Code/Pi agent running locally, (d) inbound TCP connection in-flight, (e) a service mid-request. What's the rule for each?
  - **Finish-detection.** When work completes, can we warm-down immediately instead of waiting 60s? Signals for "work just finished" — e.g., last connection closed and CPU dropped.
  - **Tier targets.** Sprites's cold/warm/hot definitions vs. ours. Hot (paused, RAM-resident, <1ms wake) vs. warm (state-saved-to-disk, VM exited, ~1s wake) vs. cold (full shutdown, ~5s). Aggressive defaults possible because we own the box; what numbers fall out of measurement?
  - **VZ + lume primitives.** What does `Virtualization.framework` actually expose (pause, resume, saveState, restoreState)? What does lume already wrap, and what needs a patch?

  Sub-boxes (each fire ticks one):
  - [x] A.1.3.a — Scenario inventory + signal catalogue. `docs/state-tiers.md` v1: 10 "in the middle of something" scenarios (S1–S10), 12 observable signals (sig-1–sig-12), tier definitions (hot/warm/cold), decision rules + mid-job safety + finish-detection layers, signal-selection priority, open questions. Layered format: technical content + plain-English blurb per section.
  - [x] A.1.3.b — VZ + lume primitive discovery. Findings written to `docs/state-tiers.md` § Discovery: lume Swift already implements `pause()`/`resume()` against `VZVirtualMachine.pause`/`.resume` (in `VMVirtualizationService.swift:93-119`) but nothing in CLI or HTTP exposes it; hot-tier patch is ~150 lines (4 Swift files). Warm tier (save/restore) has zero references in lume — needs ~300-line patch wrapping `VZVirtualMachine.saveMachineState(to:)`. Cold tier already works.
  - [ ] A.1.3.c — Benchmark cold/warm/hot transitions. Median + p95 for each, on a clean well. RAM cost per hot, disk cost per warm-state file. Write the numbers into `docs/state-tiers.md`.
  - [x] A.1.3.d — Activity-detection prototype. `lib/activity.ts`: host-side `lsof` probes for sig-6 (ssh ESTABLISHED count) and a sig-A "any TCP port" generalization. Pure functions over an injectable `LsofRunner` — 8 unit tests passing with mocked output. Live smoke against pete: 0/0 idle → 1/1 with active ssh → 0/0 after close. Wiring into watchdog + `well info` lives in A.1.3.f.3. Deferred sig-7 (bridge byte counters) and sig-8 (in-guest CPU) — sig-6/A coverage is enough to start; layer in if benchmarks show the host-side probes miss real activity.
  - [x] A.1.3.e.1 — Hot-tier lume patch. VM.swift gains `pause()`/`resume()`; LumeController.swift gains `pauseVM(name:)`/`resumeVM(name:)`; HTTP routes `POST /lume/vms/:name/pause` and `/resume`; matching handlers. All marked `@MainActor` to satisfy strict-concurrency (existing `stopVM` needed the same annotation — surfaced a latent issue). Build clean. **Live wire-up deferred** to A.1.3.f: system-installed `lume.app` auto-respawns on port 7777 and shadows our `bin/lume`; welld's `ensureLumeServe` reuses whatever lume serve it finds.
  - [ ] A.1.3.e.2 — Hibernation lume patch (~300 lines, build `saveState`/`restoreState` from scratch around `VZVirtualMachine.saveMachineState(to:)` / `restoreMachineState(from:)`). With the signing pipeline in place this is now end-to-end testable; renamed from "warm-tier" since the new model has no separate warm/cold split — hibernation IS the sleep state.
  - [x] A.1.3.e.3 — System-lume conflict resolved. Disabled `com.trycua.lume_daemon` (Pete's chosen path: kill the system daemon, not run our lume on a side port). Renamed `~/Library/LaunchAgents/com.trycua.lume_daemon.plist` to `.disabled-by-wells` so the disable survives reboot. Welld now spawns `/Users/pete/Projects/wells/bin/lume serve` directly. Live: pause/resume routes respond with our JSON, confirming the patch is reachable. **Architectural finding (next sub-box A.1.3.f):** lume serve's `SharedVM` only caches VMs lume serve itself launched. Welld currently uses `lume run` as a separate subprocess; that VM lives outside lume serve's cache, so pause/resume returns "not running" even when the VM is up. To make pause/resume work, welld's start path must POST `/lume/vms/{n}/run` to lume serve's HTTP API instead of spawning the `lume run` CLI directly. That refactor lives in A.1.3.f (wire tiers into welld).
  - [ ] A.1.3.f — Wire tiers into welld. **Signing unblock landed 2026-05-07.** `bin/lume.app` now Developer-ID signed + notarized + stapled with the virtualization entitlement; lume serve starts VMs through HTTP `/run`. Decomposed:
    - [x] A.1.3.f.1 — Investigated, then resolved. Discovery path: original "long-poll/MainActor" theory wrong (`handleRunVM` already uses `Task.detached`); real blocker was the entitlement gap (AMFI rejects unentitled binaries). Resolved via the full Apple Developer signing pipeline — App ID `md.cells.well.engine` registered (team 46622GTWYJ) with VMNet capability, Developer ID Application cert issued via Xcode, Developer ID provisioning profile generated, notarized + stapled. `scripts/build-lume.sh` extended with signed-build mode; `scripts/activate-signing.sh` wraps the one-shot. Late discovery: Apple migrated VMNet to a new entitlement key (`com.apple.developer.networking.vmnet`); current profiles authorize the new key, upstream lume's vendored entitlements still use the old key. Carry our own at `vendor/lume.patches/well-engine.entitlements`. Live-smoke 2026-05-07: pete starts via HTTP `/run` in 5s, pause 2ms, resume 6.5s, ssh-after-resume 100ms.
    - [x] A.1.3.f.2 — `startWell` switched to lume serve's HTTP `/run`. Removed the `lume run` subprocess + lume-run.log file plumbing. Existing `LumeClient.start(name, { noDisplay: true })` already POSTs the right shape; just swapped the `spawn(...)` for the HTTP call. Live-smoke 2026-05-07: stopped pete → welld start endpoint → pete running → pause via lume HTTP → succeeded WITHOUT manual `/run` intervention (proof the SharedVM cache populated). 176 unit tests still green.
    - [x] A.1.3.f.3a — Activity probe feeds watchdog. `runWatchdogTick` accepts a `probeActivity(name)` callback; if it reports active, we `touch(name)` before the sleep decision. Welld wires it via `readDhcpLease` + `sampleActivity`. 12 unit tests across `lib/watchdog.test.ts`. Runs every 30s alongside the existing tick. Probe failure is non-fatal — falls back to touch-only logic.
    - [x] A.1.3.f.4 — Watchdog auto-pauses on idle (replacing auto-stop). `lib/paused.ts` tracks pause state since lume's status field doesn't distinguish running from paused. `pauseWell`/`resumeWell` mutate the set; `ensureRunning` resumes-on-traffic if the cell is paused. Welld's startup runs a defensive `lume.resume` over every running VM to unstick anything left paused across a restart. Auto-paused cells stay in RAM (memory not freed until hibernation lands).
    - [ ] A.1.3.f.3b — Watchdog hibernate path. After A.1.3.e.2 lands (`saveState`/`restoreState` in lume), wire hibernation as the next step beyond pause: long-idle OR under memory pressure → save RAM to disk, free memory. Welld's `/v1/wells/{n}/hibernate` and `/wake` endpoints. `well info` surfaces state (alive vs hibernating). `--fresh` flag on wake to discard hibernation and boot clean.
  - [ ] A.1.3.g — Smoke: scenario coverage. Each scenario from A.1.3.a tested live (compile + check no-sleep, ssh session + check no-sleep, etc.). Tier transition smoke (hot→warm→cold and back) with measured wake budgets.
- [ ] **A.1.4 Pre-baked pool.** Welld keeps `pool_size` (default 1) of pre-baked, pre-booted-then-warmed wells in `pool/` (separate registry namespace). `well create <name>` adopts a pool member: rename, re-cidata for identity, restore from warm state. Target: <2s end-to-end. Pool refills async after adoption. Depends on A.1.3.
  - [x] **A.1.4.a — Pool storage layout + registry.** Storage namespace at `~/.wells/pool/` (separate from `~/.wells/vms/`). New `lib/poolRegistry.ts` with `PoolMember` shape (name, uuid, source_image, sizing, state ∈ {provisioning, warming, ready, adopting}, ready_at) + CRUD helpers (`add`, `find`, `list`, `setState`, `remove`, `countReady`) + an atomic `reserveReadyMember()` that transitions a ready member to `adopting` so concurrent adopt requests can't double-pop. `generatePoolMemberName()` produces `pool-XXXXXXXX` (8 hex from UUID); `validateWellName` reserves the `pool-` prefix so operator-chosen names can't collide. State paths in `lib/state.ts` gain `PATHS.pool()`, `PATHS.poolMemberDir(name)`, `PATHS.poolMemberHibernate(name)`, `PATHS.poolRegistry()`; `ensureStateDirs` creates the pool dir on welld startup. 16 unit tests covering name generation (prefix shape + uniqueness), CRUD round-trip, state-machine transitions with `ready_at` timestamping, atomic reserve guarding against double-pop, and the `pool-` prefix reservation in the well-name validator. 466 tests green.
  - [x] **A.1.4.b — Pool fill primitive.** New `lib/poolFill.ts` exports `fillPoolMember(opts)` — hatches one member end-to-end: validates source image, generates a `pool-XXXXXXXX` name + UUID, writes registry entry as `provisioning`, builds bundle (clonefile base disk, build pool-shaped cidata seed with member's hostname + welld's host pubkey + a per-member SSH key for warm-time probes), `lume.create` + `lume.start` with cidata, waits DHCP + SSH-ready, transitions to `warming`, sysrq fast-halt + waits disk-released, warming-restart without mount, waits DHCP + SSH-ready, `lume.saveState` to `PATHS.poolMemberHibernate(name)`, marks `ready` with `ready_at` timestamp. Reuses `waitForDhcpLease`, `waitForSshReady`, `detectHostPubkey` (now exported from `createWell.ts`), and `DEFAULT_BASE_IMAGE`. Failure path removes the registry entry + best-effort lume.delete to avoid leaking partial bundles. **Live-verified on dev 2026-05-09 19:14 PT:** hatched in 11655ms (clone+seed 3ms, first-boot DHCP+SSH 5624ms, halt+disk-release 558ms, warming-restart+SSH 5238ms, hibernate 189ms). Hibernate.bin written, registry shows `state=ready`. Welld-side background fill loop (decides _when_ to hatch) is the next sub-checkbox. New `scripts/exp-pool-fill.ts` is the one-shot driver used to live-verify; will become smoke-pool-adopt's setup step in A.1.4.e.
  - [ ] **A.1.4.b.ii — Welld background fill loop.** Welld watcher that maintains `pool_size` ready members. Calls `fillPoolMember` when `countReadyMembers() < pool_size`, async (doesn't block welld responses). Triggers on welld startup + after each adoption + on a slow housekeeping timer. `pool_size` defaults to 0 until cells team opts in (defaults.json).
  - [x] **A.1.4.c.i — Pool adoption skeleton.** New `lib/adoptFromPool.ts` exports `adoptFromPool({name, auth?})`: validates operator name, atomically reserves a ready pool member (`reserveReadyMember`, transitions to `adopting`), renames bundle dirs (`PATHS.poolMemberDir(member.name)` → `PATHS.vmDir(opts.name)`, `~/.lume/<member>/` → `~/.lume/<opts.name>/`; lume keys bundles by directory name only so `mv` is the canonical rename), captures the restore recipe from the renamed lume bundle, writes runtime.json with `state: hibernating` + `hibernate_ready: true` + `birth_media_detached_at: member.ready_at`, adds the wells registry entry, calls `wakeWell` to restore from `hibernate.bin`, then removes the pool member entry. New `PoolEmptyError` exposed for callers. Identity reset (so the in-guest hostname matches the operator's name) is deferred to A.1.4.c.ii — adopted well keeps the pool member's `pool-XXXXXXXX` hostname, machine-id, and SSH host keys. That's invisible to URL-based callers (cells via WELL_PUBLIC_BASE) but a UX wart for `well exec`. New `scripts/exp-pool-adopt.ts` driver. **Live-verification BLOCKED:** the wake step exposed a pre-existing architectural quirk — `engine/lume.ts:LumeClient` defaults to `http://127.0.0.1:7777` (stable's lume) regardless of `WELL_LUME_PORT`, AND `killAndRestartLumeServe` (called by `wakeWell`) pkills every lume serve on the host. So a direct-from-script wake races stable welld's supervisor for control of port 7777 and times out reaching the wrong lume. Both issues are wells-side fix, separate fire (A.1.4.c.iii — `LumeClient` honors env, `killAndRestartLumeServe` scopes to its own owned PID).
  - [ ] **A.1.4.c.ii — Identity reset on adoption.** Hot-swap or warm-restart to give the adopted well an in-guest identity matching the operator's chosen name (hostname, machine-id, SSH host keys, authorized_keys). Cells team's proposal favors a warm-restart with fresh cidata; SSH hot-swap is faster but riskier (DBus DUID, journald keying).
  - [x] **A.1.4.c.iii — Lume client port-honoring + targeted kill.** `engine/lume.ts:LumeClient`'s `DEFAULT_BASE` now reads `WELL_LUME_HOST`/`WELL_LUME_PORT` env vars (was hardcoded `http://127.0.0.1:7777` — meant any LumeClient constructed with no explicit base URL on dev welld was actually driving stable's lume; nobody noticed because the shared `~/.lume/` makes both lumes see the same bundles). `engine/lumeProcess.ts` refactored: `supervisedProcess: Subprocess | null` + `respawnInProgress: boolean` lifted to module scope so `killAndRestartLumeServe` and the supervisor coordinate. `killAndRestartLumeServe` now `process.kill(supervisedProcess.pid, "SIGKILL")` instead of `pkill -KILL -f "lume serve"` (which crossed dev/stable boundaries — surfaced in A.1.4.c.i live test where the wake step pkilled stable's lume). Falls back to old pkill behavior when `supervisedProcess` is null (lume started externally, no welld supervisor). The `respawnInProgress` gate prevents the supervisor from racing the kill+restart and double-spawning. 466 tests green.
  - [ ] **A.1.4.d — Wire createWell to attempt adoption first.** `createWell()` in `lib/createWell.ts` checks the pool for a ready member matching the requested sizing; if present, adopts; otherwise falls through to the legacy fresh-create path. Image mismatch + custom sizing both fall through (pool only serves the default profile).
  - [ ] **A.1.4.e — Adoption smoke test.** New `scripts/smoke-pool-adopt.ts`: pre-fill pool with N=2, adopt 3 wells back-to-back, measure each `create` end-to-end, assert ≤2s for the two pool-served and ≤15s for the third (cold-create fallback). Verifies pool refill kicks in async after adoption.
- [ ] **A.1.5 Pool config.** `~/.wells/defaults.json` gains `pool_size`. `well pool list|refill|drain` CLI. `GET /v1/wells/pool` endpoint for visibility.
- [ ] **A.1.6 Smoke: full lifecycle.** `scripts/smoke-warm-pool.sh` measures pool-adoption create, idles past auto-sleep, hits the URL, measures wake. Asserts targets: <2s create, <1s wake.

#### A.2 — Checkpoint sync to R2

R2 creds live per-well in `meta.json`. Well create accepts `--r2-endpoint`, `--r2-bucket`, `--r2-key`, `--r2-secret`; daemon stores them; checkpoint sync uses them. Each well's R2 path is `<bucket>/wells/<name>/checkpoints/<id>/disk.img`. (Cells's eventual integration: cells's worker creates the bucket+keys when birthing a well-backed cell and passes them in via the create body.)

- [x] **R2 client (`lib/r2.ts`).** Skeleton landed — `uploadCheckpoint`, `downloadCheckpoint`, `deleteCheckpoint`, `checkpointKey`. Uses bun's S3Client (no extra deps). Per-well creds via `WellRecord.r2`. CLI flags `--r2-endpoint`, `--r2-bucket`, `--r2-key`, `--r2-secret` on `well create` (all-or-nothing). Schema + daemon pass-through. Streaming PUT/GET wired but not yet smoke-tested live; live verification rolls into the next sub-checkbox below.
- [x] **`well checkpoint create` pushes to R2.** When the well has R2 configured (`record.r2`), after the local clonefile completes, the checkpoint module attempts an upload via `lib/r2.uploadCheckpoint`. Best-effort: on success the meta gets `r2_uploaded: true`, `r2_uploaded_at`, and `r2_key`; on failure the local checkpoint is unaffected and only a warning is logged. Both upload and delete are dependency-injected so tests run without R2. 3 new test cases (no-r2, success, failure).
- [x] **`well checkpoint restore --from-r2 <id>`.** Daemon `POST .../restore?from_r2=true` accepts the flag; CLI exposes `--from-r2` on `well checkpoint restore`. New `ensureCheckpointLocal` helper isolates the R2 fetch + meta synthesis from the VM ops so it's unit-testable. Implicit fetch also fires if local is missing and the well has R2 creds — that's the fresh-host hydration path. 4 new tests on the helper.
- [ ] **R2 GC tracks local retention.** When local retention rotates a checkpoint out, also remove the R2 object. New env `WELL_R2_RETAIN_FOREVER=1` to keep R2 forever.
- [ ] **Smoke: round-trip.** `scripts/smoke-r2-sync.sh` creates a checkpoint, verifies the R2 object, deletes the local checkpoint, restores from R2, verifies disk integrity.
- [ ] **Frozen tier (post-MVP).** R2 sync today handles checkpoints — point-in-time snapshots. The Frozen tier extends the same plumbing to *hibernation files*: when a cell has been hibernating locally for `auto_freeze_days`, upload its hibernation image to R2 and delete the local copy. Wake from frozen = thaw (download → restore-from-hibernation). Depends on hibernation patch (A.1.3.e.2) shipping. See [`docs/lifecycle.md`](lifecycle.md) § "What 'Frozen' means."

#### A.3 — Egress enforcement

The `POST /v1/wells/{n}/policy/network` endpoint already persists rules (Phase 10 chunk 3). What's missing is actually enforcing them on the wire.

**Blocked on design decisions** — see [`docs/proposals/A.3-egress-enforcement.md`](proposals/A.3-egress-enforcement.md) and `docs/BLOCKED.md`. Pete picks privilege model + DNS strategy, then implementation lands as A.3.1–A.3.5.

- [ ] **pf rule generation per well tap.** Each well has a vmnet tap interface (lume manages it). Welld generates pf rules to allow/deny traffic per the well's policy. Anchor per well (e.g. `well/<name>`) to keep state clean. Rules generated from `policy.json` on POST and on welld startup.
- [ ] **DNS-based deny for domain rules.** Run a per-host resolver (dnsmasq or unbound) that welld configures with the well's domain rules. Well's `/etc/resolv.conf` (set by cloud-init) points at the host resolver. Deny = NXDOMAIN. (Skipped in v1 if Pete picks DNS option 2B.)
- [ ] **`enforced: true` flag flips when rules are live.** The existing response field switches from stub to honest reporting.
- [ ] **Smoke: blocked vs. allowed.** `scripts/smoke-egress.sh` adds an allow rule for `github.com`, denies `evil.com`, exec's curl in the well, asserts the right outcomes.

#### A.4 — Retention with explicit expiration

- [x] **`well checkpoint create --retain-for <duration>`.** Duration parser handles `Ns/m/h/d`. CheckpointRecord gains `expires_at` + `retain_for_seconds`; daemon validates the format and 400s on garbage. CLI threads `--retain-for` through to the daemon body. Surfaced in CheckpointResource so the existing list output picks it up.
- [x] **`well checkpoint expire <id>`.** New `well checkpoint expire` subcommand → `DELETE /v1/wells/{n}/checkpoints/{id}` → `expireCheckpoint(name, id)` removes the dir + best-effort R2 cleanup. Idempotent (`removed: false` for missing).
- [x] **Configurable last-N.** `~/.wells/defaults.json` gains `checkpoint_retain_count` (default 5). `gcOldCheckpoints` reads it instead of the old hardcoded 5; new two-pass GC drops expired TTLs first, then applies last-N to whatever survived.

### Phase B — Cells deploys to wells (real integration)

Phase 10 made wells a *drop-in* for the sprites API contract — every cells shell-out and HTTP call shape works against welld verbatim. That's the protocol layer. Phase B is the *real* layer: cells's `birth/talk/checkpoint/sleep/wake/destroy` running against wells in production, with cells's pi-config + credentials + extensions plumbing actually exercised. This is where the hot-tier pause, cooperation API, and lifecycle model get tested under real LLM workloads.

**Branch:** `feature/phase-b`. Squash to `main` and tag `v0.2.5` when complete (interim release between v0.2.0 / Phase A and v0.3.0 / Phase E).

**Most of this phase's code lives in the cells repo, not wells.** Wells's job is mostly to be ready and to fix any contract gaps surfaced by real cells traffic.

**Backlog priority (2026-05-08):** B.0.7 (welld owns lifecycle truth) is the new top — lume is an actuator, not a source of truth. The state machine + reconciliation loop unblocks the rest of B (hibernation, multi-cell load, cooperation API). B.0.6 (lume SharedVM survives restart) shipped already; lifecycle truth is the next chokepoint.

#### B.0.7 — Welld owns lifecycle truth, lume is the actuator (TOP PRIORITY)

**Pete's directive (2026-05-08):** "lume is the actuator, not the source of truth. Wells should own the lifecycle truth and treat lume/VZ/processes as observed inputs that can lie, lag, or crash."

Today welld's lifecycle ops infer state from `lume.status` and react. lume reports `running` for paused VMs, `stopped` for hibernated ones, and stays `healthy` while a VZ XPC child is alive — every welld lifecycle bug we've hit traces to that mismatch. Treat lifecycle as a first-class state machine, persist it durably, reconcile observed truth against the record continuously.

**Explicit runtime states:**
- `alive_running` — VM live, CPU running
- `alive_paused` — VM in SharedVM, CPU paused, RAM resident
- `hibernating` — RAM dumped to `hibernate.bin`, no XPC child
- `stopped` — clean state, no hibernate file, no XPC child
- `restoring` — wake in progress
- `error_orphaned` — observed state contradicts record (XPC alive but lume says stopped, etc.)
- `missing` — registry says it exists but disk bundle gone

Sub-checkboxes (each fire ticks one):

- [x] **B.0.7.a — State machine schema + `runtime.json` per well.** Add `WellState` type with the 7 states and a `WellRuntime` interface (state, hibernate_path, last_transition_at, last_error, restore_recipe?). Persist at `~/.wells/vms/<n>/runtime.json`. New `lib/wellRuntime.ts` with read/write helpers + `validTransitions` table. Unit tests over the transition table.
- [x] **B.0.7.b — Per-well async keyed mutex.** `lib/wellLock.ts` with `withWellLock(name, async () => …)`. Every lifecycle op (start/stop/pause/resume/hibernate/wake/checkpoint/destroy/proxy-wake) acquires before mutating. Eliminates concurrent-pause/resume and stop-during-hibernate races. Unit tests with mocked timers.
- [x] **B.0.7.c — Restore recipe captured at hibernate time.** When `hibernateWell` runs, write a `hibernate.meta.json` next to `hibernate.bin` containing the device manifest: cidata path, MAC, network mode, CPU count, memory size, display string, mount list, NVRAM path, config hash. `wakeWell` reads the manifest, refuses with `error_orphaned` if any field drifted from the current bundle config (disk size grew, etc.).
- [x] **B.0.7.d — Reconciliation loop in welld.** `lib/reconcile.ts` runs on a 30s tick AND after every lifecycle op. For each registered well: read 5 truth sources (registry record, runtime.json, lume.list status, VZ process-table, DHCP/SSH probe) → derive observed state → if observed ≠ recorded, log + converge. New runtime states feed into `well info`/`well list`/`/healthz`.
- [x] **B.0.7.e — Every transition idempotent.** hibernate-on-hibernating, wake-on-running, stop-on-stopped, etc. all return success-shaped (no-op or appropriate transition). Failed restore lands in `error_orphaned` not ambiguous `stopped`. Test matrix covering all (current_state × verb) cells.
- [x] **B.0.7.f — XPC orphan detection in health.** `well doctor` walks `Virtualization.VirtualMachine` exec markers via `ps -A`, compares count vs `lume.vm_count`. Mismatch (xpc > vmCount) flags result as `degraded` with an ORPHAN banner listing pids. `/healthz` surfaces `vz_xpc_count` so external pollers (cells team's birth flow) can detect orphans without their own ps walk. Filter mirrors lume's `XPCChildLocator.swift` from B.0.6.
- [x] **B.0.7.g — Lifecycle handlers route through the state machine.** `lib/wellLifecycle.ts` got a `transitionWell(name, verb, actuators)` orchestrator: acquires `withWellLock`, reads runtime, dispatches via `dispatchTransition`, runs the actuator on `transition`, no-ops on `noop`, throws on `invalid`. `daemon/welld.ts` `handleLifecycle` (start/stop) and `handleHibernation` (hibernate/wake) wired through. `ensureRunning` extended: a hibernating well dispatches the wake verb transparently — closes the cells team wake-on-traffic contract (2026-05-08). Watchdog's auto-sleep + host.well `/sleep` now route through `transitionWell` and hibernate (not pause) — closes "cells sleep means hibernate" contract.

#### B.0.9 — Hibernate/wake config drift (open)

Cells team caught 2026-05-09: hibernate succeeds, wake returns 500 `lume restore-state error "invalid argument"`. First obvious cause was lume's `lume-config` SharedDirectory missing from the restore-time VZ config (boot path always added it, restore path passed `sharedDirectories: []`). Patched in `vendor/lume/src/VM/VM.swift` `restoreState`. Live-verified post-fix: still `invalid argument`, suggesting another field drifts between save-time and restore-time VZ config. Likely culprits:

- audio device host-references (`VZHostAudioInputStreamSource`/`VZHostAudioOutputStreamSink`) bind to runtime audio config; a host audio change between save and restore would mismatch
- USB controllers (`VZXHCIControllerConfiguration`) on macOS 15+ — same potential cross-version drift
- Rosetta share availability (only added when `VZLinuxRosettaDirectoryShare.availability == .installed`)

Open work to land:
- [x] **B.0.9.a — Diagnostic: log the full VZVirtualMachineConfiguration at save and restore in lume Swift, byte-compare programmatically.** New `VZConfigSnapshot.swift` fingerprints the effective device graph (storage, network, dir-shares, audio, USB, console, graphics, keyboard, pointing, platform, bootloader — class names + path/MAC/tag/readOnly details). `BaseVirtualizationService` caches the config at construction. `VM.swift saveState` writes a snapshot to `<bundle>/hibernate.config.json` next to `hibernate.bin`. `VM.swift restoreState` builds a fresh snapshot, loads the saved one, runs a per-field diff, and **fails fast with the field-level drift before calling Apple's `restoreMachineStateFrom`** (per cells team 2026-05-09 — turns the opaque "invalid argument" into "audio.0.source drifted from VZHostAudioInputStreamSource to nil"). Restore-time snapshot also persisted as `hibernate.config.restore.json` for offline diffing. Patched lume needs signed rebuild before next live test.
- [x] **B.0.9.b — Strip non-essential devices from wells's VZ config for headless cells.** `VMVirtualizationServiceContext` gains `headless: Bool`, driven by the `noDisplay` flag on `RunVMRequest`. When headless, `LinuxVirtualizationService.createConfiguration` skips the four classes that bind to host runtime state and could drift between save/restore: audio host source/sink, Spice clipboard console, Rosetta directory share, USB controller. `VZConfigSnapshot` records the flag so restoreState rebuilds the same shape (loads `headless` from `hibernate.config.json`, defaults to true since wells is the only save/restore caller). Live-verified: fresh fork from `ubuntu-25.10-base` boots clean with stripped device graph, save snapshot shows empty audio/console/usbControllers arrays. **Wake-side progress**: Apple's error narrowed from generic "invalid argument" to specific **"The storage device attachment is invalid"** — exactly cells team's prediction (2026-05-09): "if snapshots match and Apple still rejects, drift is in non-serializable host objects." Snapshot diff is byte-identical, so remaining drift is below VZ config — likely in `VZDiskImageStorageDeviceAttachment`'s internal file binding. Continued under B.0.9.d.
- [ ] **B.0.9.c — Live-verify hibernate/wake end-to-end against a fresh fork.** With the fixed lume binary built today, exercise the full save → release RAM → wake-on-traffic cycle and prove it. (Save-side proven; wake-side blocked by B.0.9.d storage attachment drift.)
- [x] **B.0.9.d.1 — Same-instance restore: structurally impossible.** Tested cells team's recommendation (2026-05-09) of keeping the VZ handle alive across save → restore to preserve storage attachment identity. Code shipped both layers: VM-level (don't null `virtualizationService` after save) + LumeController-level (don't `SharedVM.removeVM` after save, prefer cached VM in `restoreStateVM`). Live result: Apple errors **"Invalid virtual machine state transition. Transition from state 'paused' to state 'restoring' is invalid."** Per Apple docs, `saveMachineStateTo` leaves the VM in `.paused`, but `restoreMachineStateFrom` requires `.stopped` — and there's no public API path from paused → stopped on a live VZ instance. Reverting to the drop-handle pattern. The drift remaining ("storage device attachment is invalid") will be addressed by B.0.9.d.2 instead.
- [ ] **B.0.9.d.2 — Disk-only steady-state hibernation.** Per cells team (2026-05-09): hibernate's failure surface comes from the cidata.iso read-only attachment; treat cidata as birth-only. New flow: (1) boot with cidata, (2) wait for `/etc/.well-ready`, (3) stop the VM, (4) restart **without** mount, (5) only then allow hibernate/save-state. The hibernated steady-state VM is disk-only — Apple's restore equation has no auxiliary read-only storage to validate.

  **Progress 2026-05-09:** First piece shipped — `templates/cloud-init-well.yaml` runcmd writes `/etc/netplan/60-wells-dhcp.yaml` + `netplan generate` + `touch /etc/cloud/cloud-init.disabled` so subsequent boots come up via systemd-networkd alone (verified files land on disk after first boot).

  **Phase 1 measurement (live test):** stop a freshly-booted well, restart without mount, time the second boot. **Result: networking comes up at T+3s ✓ (the seal works for that part), but sshd never starts.** Cells team diagnosed (2026-05-09) it's Ubuntu 22.10+'s default SSH socket activation: `ssh.socket` listens on :22, on connection triggers `ssh.service`. On second boot without cidata, ssh.socket doesn't activate sshd. Recommended fix: replace socket activation with classic `ssh.service` during the seal runcmd (`ln -sf /dev/null /etc/systemd/system-generators/sshd-socket-generator`, `systemctl disable ssh.socket`, `systemctl enable ssh.service`).

  **Phase 2 attempt (live test):** applied cells team's fix to a running well, then ran the warming sequence. SSH still didn't come up post-warm — and recovery-with-cidata also failed to bring sshd back. The fix may have left `ssh.service` in a state that doesn't actually start (possibly because the unit still has internal `Requires=ssh.socket` baked in).

  **Open work:**
  - Why `ssh.service` doesn't start after applying cells team's recipe — needs VNC console inspection of a stuck second-boot well, or a fresh round of consultant guidance with the precise systemd output.
  - The TS-side warming sequence in `createWell` + `hibernate_ready` runtime gate were drafted this session and reverted (kept uncommitted) until the boot path is reliable. RestoreRecipe disk-only contract changes also reverted; reapply once Phase 2 works.
  - `saveImage` un-seal step: when bundling a forkable image from a sealed well, `unmask` SSH units + `rm /etc/cloud/cloud-init.disabled` before save (B.0.9.d.3 follow-up).

#### B.0.9.d.4 — Strip cloud-init from base image (decided 2026-05-09)

Three parallel research agents confirmed: cloud-init is the root of all this pain. Stripping it eliminates both blockers (cidata-less second-boot slowness AND ssh.socket activation failures) at the same time. Synthesis of the research:

- **ASIF disks** — verdict: don't pursue. Storage-perf feature (sparse APFS-backed, 5.8 GB/s), not a save/restore correctness fix. Still uses `VZDiskImageStorageDeviceAttachment`, same identity bug. Can't replace ISOs anyway (cidata stays ISO9660). [Apple's Tahoe release notes](https://developer.apple.com/forums/thread/787491) frame ASIF strictly around throughput, not lifecycle.
- **Apple Containerization framework** — verdict: don't pursue now, revisit macOS 27. Same VZ underneath. **No save/restore API at all** — only start/pause/resume/stop. Apple's own docs say "memory pages freed... are not relinquished to the host. You may need to occasionally restart [containers]" — worse RAM model than what we have. v0.1.0, breaking changes allowed. Tracker: [apple/container](https://github.com/apple/containerization).
- **Strip cloud-init** — verdict: yes, ~1.5 dev-days. Reference projects already in production: Apple's own [containerization](https://github.com/apple/containerization) uses `vminitd` (Swift init, no cloud-init); Proxmox golden-image guides apt-purge cloud-init after baking; [mvallim/cloud-image-ubuntu-from-scratch](https://github.com/mvallim/cloud-image-ubuntu-from-scratch) builds cloud-init-less Ubuntu images.

**The design:**

- A new `well-firstboot.service` (systemd one-shot, gated by `ConditionPathExists=!/etc/.well-ready`) replaces cloud-init for per-well identity injection. Reads variables + authorized_keys from `/dev/disk/by-label/cidata` (built host-side as a NoCloud-shaped seed disk). Applies hostname, SSH host keys, authorized_keys for ubuntu+well users, machine-id, swap, DNS pointer at host.well bridge resolver. Touches `/etc/.well-ready` at the end. Subsequent boots skip the unit in microseconds.
- The base image bake now installs the unit + script (via cloud-init's `write_files`), drops a permanent netplan (`/etc/netplan/01-well.yaml` matching all interfaces with DHCP), `systemctl enable well-firstboot.service`, then **`apt-get purge cloud-init`** at the very end. The saved disk has no cloud-init.
- Per-well forks: the `cidata.iso` produced by createWell becomes a NoCloud-shaped seed disk (label `cidata`, files `well.env` + `authorized_keys`) instead of cloud-config YAML. Wells's host-side seed builder (currently `lib/cloudInitWell.ts`) becomes a different shape. Tracked as B.0.9.d.4.b.
- Hibernate flow: createWell's warming sequence (boot with cidata → wait `/etc/.well-ready` → stop → restart without mount → SSH check → mark `hibernate_ready`) re-applies. Now reliable because second boot has no cloud-init/socket-activation hazards.

**Sub-tasks:**

- [x] **B.0.9.d.4.a — well-firstboot scaffolding.** New `templates/well-firstboot.sh` + `templates/well-firstboot.service`. `lib/cloudInit.ts composeBaseUserData` accepts optional `FirstbootArtifacts`; when supplied, writes them as cloud-init `write_files` entries. Bake script reads templates + threads through. `templates/cloud-init-base.yaml` runcmd: `systemctl enable well-firstboot.service`, drop permanent netplan, `apt-get purge cloud-init` + autoremove + `rm -rf /etc/cloud /var/lib/cloud /var/log/cloud-init*`. 7 cloudInit unit tests including 2 new for the firstboot embed/no-embed paths. 431 wells tests green.
- [x] **B.0.9.d.4.b — Per-well seed disk.** New `lib/wellSeed.ts` builds the seed-disk content: `composeWellEnv` produces shell-safe KEY=VALUE pairs (WELL_HOSTNAME, WELL_USER, optional /etc/environment additions); `composeAuthorizedKeys` produces one-key-per-line. `buildWellSeed` stages files + invokes `hdiutil makehybrid` to produce the ISO. 7 unit tests covering the formatters (single-quote escaping including `'` → `'\''`, env-key validation, newline rejection). Wiring into `createWell.ts` deferred to .d (paired with the warming sequence). 438 wells tests green (up from 431).
- [x] **B.0.9.d.4.c — Re-bake `ubuntu-25.10-base`.** Hand-baked over SSH (cloud-init kept hanging on auto bake). State on the new disk: cloud-init purged, `well-firstboot.service` ENABLED with `After=network-online.target` ordering (NOT `Before=systemd-networkd.service` — that ordering hung steady-state restarts when cidata was absent), permanent `/etc/netplan/01-well.yaml`, full toolchain (bun, pi+pi-web-access, claude-code, rust+cargo, go, ruby, node22, gh, ripgrep, bat, fzf, micro, etc; stoolap deferred — 25 min cargo install).
- [x] **B.0.9.d.4.d — Wire wellSeed + restore warming sequence.** `lib/createWell.ts` switched from `composeWellUserData/buildCidata` to `buildWellSeed` (well.env + authorized_keys ISO). Warming sequence: boot with cidata → wait `/etc/.well-ready` → SSH-shutdown the guest → wait for disk to be released (lsof) → restart without mount → re-resolve IP via `waitForDhcpLease` (machine-id regen produces a new DHCP lease) → wait SSH → write `runtime.json` with `hibernate_ready: true`. `lib/lifecycle.ts` `hibernateWell` gates on `hibernate_ready === true`; `wakeWell` drops the cidata mount. `lib/wellRuntime.ts` runtime gains the seal fields, `RestoreRecipe` flips to disk-only contract. 429 wells tests green.
- [x] **B.0.9.d.4.e — Live-verify hibernate/wake.** **WAKE WORKS.** Three structural fixes were required: (1) `killAndRestartLumeServe()` between save and restore to clear the VirtualMachine.xpc kernel state (lume's orphan-sweep on startup kills the XPC child; the fresh VZVirtualMachine then has truly clean kernel state — without this, Apple errors "Transition from state 'paused' to state 'restoring' is invalid"). (2) Linux VM machineIdentifier persistence — `VZGenericPlatformConfiguration().machineIdentifier` was random on every fresh instance, so save and restore configs had different IDs and Apple errored "invalid argument" even though textual config snapshots matched byte-for-byte. Fixed by pre-generating + persisting `VZGenericMachineIdentifier.dataRepresentation` to bundle's `config.json` on first run, deserializing on subsequent runs (same pattern macOS VMs already used; Linux didn't). (3) The earlier B.0.9.d.2 disk-only steady-state work was load-bearing — without it, restore fails on cidata storage device shape mismatch. Smoke results 3/3 cycles: hibernate 196ms / 12802ms (one-off) / 186ms; **wake 858ms / 856ms / 847ms**; ssh-after-wake 1164ms / 1215ms / 1166ms. Wake + ssh-after-wake both well under target on every cycle. Create+warm exceeds 15s target (16-31s); one-off hibernate slowness in cycle 2. These are tuning, not structural — tracked in B.0.9.d.5.
- [x] **B.0.9.d.5 — Create+warm latency tuning (P50 under target).** Three host-side optimizations dropped P50 create+warm from 16-31s to ~14.8s: (1) sysrq-trigger fast halt — replaced `sudo shutdown -h now` with `sudo sync && echo o | sudo tee /proc/sysrq-trigger`. The latter triggers an immediate kernel-level poweroff bypassing systemd's full poweroff.target service-stop sequence, releasing the disk in ~200ms instead of 4-5s. Saves ~600ms. Sysrq is enabled by default in Ubuntu's stock kernel. (2) Tightened `waitForDiskReleased` polling from 500ms to 100ms — was wasting up to 500ms when the guest halt finished mid-poll. (3) Tightened `waitForSshReady` ConnectTimeout from 4s to 2s + retry interval from 3s to 1s — local vmnet round-trip is sub-ms; the prior values were tuned for WAN. **Residual gap:** P95 still bumps 15-15.5s ~30% of the time. Two of three or three of five smoke cycles pass strict ≤15s; one cycle bumps over by 100-700ms. Structural cause is the dual ~4s DHCP phases (fresh DHCP on first boot + fresh DHCP on warming-restart because well-firstboot regenerates `/etc/machine-id` → systemd-networkd derives a new DUID). The proper fix is `dhcp-identifier: mac` in the base image's netplan + a rebake — turns warming-restart's DHCP into a fast renewal and saves ~2-3s. Rebake tracked in a follow-up; this checkbox marks the host-side wins shipped without rebake. Plus: welld supervisor's `sample`-on-respawn now waits for capture before SIGKILL (was racing in parallel and producing empty dumps).
- [x] **B.0.9.d.5.b — Re-bake `ubuntu-25.10-base` with `dhcp-identifier: mac` + pre-allocated swap.** Hand-baked on top of existing `ubuntu-25.10-base` (booted into a temporary well, modified `/etc/netplan/01-well.yaml` with `dhcp-identifier: mac`, `fallocate -l 512M /swap.img` + `mkswap` + `/etc/fstab` entry, rinsed identity bits, sysrq halt, replaced `~/.wells/images/ubuntu-25.10-base/disk.img` and `~/.wells-dev/...` with the modified disk). Pre-rebake backup at `disk.img.may9-pre-mac-dhcp`. **Result:** one-off creates dropped from ~14.5s to **~10.5s** (32% reduction). Surprise: the win was NOT from `dhcp-identifier: mac` (warming-restart DHCP still ~4s — networkd appears to ignore the persisted lease across reboots even with stable client-id) but from the pre-allocated swap eliminating per-well `fallocate`/`mkswap`/`swapon` overhead, which let well-firstboot finish faster, sysrq earlier, disk-release earlier (`diskReleased` phase dropped from 4-5s to ~0.3s). `templates/cloud-init-base.yaml` updated with the netplan change so future clean re-bakes inherit it (still hypothetically valuable for renewal scenarios). **Residual:** under heavy smoke load, lume's `@MainActor` still occasionally hangs (B.0.11.h fix reduced the rate dramatically but didn't eliminate it), causing ~20% of smoke cycles to bump 15-15.5s. The strict 3-clean-cycle gate isn't yet consistent under load; one-off P50 is solidly under. Real fix for the residual variance is more lume work (e.g. async probe machinery instead of bounded blocking).

`saveImage` un-seal mechanism (B.0.9.d.3) is moot: with cloud-init removed from the base, future image saves don't need an un-seal — well-firstboot's `ConditionPathExists` is the natural gate. Save-image semantically resets `/etc/.well-ready` to allow first-boot to fire again on next fork.

#### B.0.11 — Fork-from-saved-image hardening (cells team blockers, 2026-05-09)

Cells team reported (2026-05-09): bake of `cell-base` from a wells-warmed source produces a saved image whose forks (a) sometimes hang on first-boot DHCP, (b) sometimes hang at warming-restart waiting for SSH. Two root causes layered together:

1. `well-firstboot.service` had `ConditionPathExists=!/etc/.well-ready`. The wells warming sequence touches `/etc/.well-ready`; when cells team saves the warmed disk, that marker is baked in; downstream forks skip the unit and inherit the source's identity.
2. The wells warming sequence regenerates `/etc/machine-id`. Saved-disk machine-id is the same on every fork → networkd does DHCP with a stale DUID before well-firstboot can regenerate (well-firstboot runs `After=network-online.target`).

- [x] **B.0.11.a — Drop ConditionPathExists from well-firstboot.service.** Template fix (`eeb1401`); rebake landed (`a132e02`). Stable promoted to `wells-stable-2026-05-09b`.
- [x] **B.0.11.b — Rinse-on-save in welld.** New `lib/rinseWell.ts` exports `rinseGuest` + `shutdownGuest`. `POST /v1/wells/images` with `validate=true` (or explicit `rinse=true`) SSHes into the source, wipes /etc/machine-id, /etc/.well-ready, /var/lib/systemd/network/*, host SSH keys, and authorized_keys; clean-shuts down the guest; waits for disk-release; clonefiles. Saved meta gets `rinsed: true`. `SAVE_CHECKS` updated for the post-cloud-init substrate (`well-firstboot-script`, `well-firstboot-service`, `networkd-enabled`, `netplan-config`). `createWell.ts`'s old refusal of `rinsed:true` images was reversed (semantic flipped — `rinsed` is now positive "fork-ready"). 381 wells tests green.
- [x] **B.0.11.c — Lume client fetch timeout.** `engine/lume.ts`'s private `request` method now uses `AbortController.signal` with a per-call `timeoutMs` (default 35s, matches the supervisor respawn budget). `saveState`/`restoreState` override to 120s for hibernate/wake on big cells. Aborted requests throw a clear "timed out after Nms — lume serve likely hung mid-request" instead of hanging welld forever. Test: `engine/lume.test.ts` adds a hung-server case that asserts a 100ms timeout aborts in <2s. 432 tests green.
- [x] **B.0.11.b followup — SSH-subprocess timeout in rinseWell.** Same hang pattern as B.0.11.c, on the ssh subprocess side. Discovered live 2026-05-09 19:49: cells team's bake-1778356165 hung stable welld for 5+ minutes mid-rinse. Fix: `runWithTimeout` helper in `lib/rinseWell.ts` races the ssh subprocess against a wall-clock timer (default 60s for rinse, 30s for shutdown). Plus `ServerAliveInterval=10` + `ServerAliveCountMax=2` so a silent ssh dies in ~20s instead of hanging forever. Test pinned to require both shapes (timeout call + keepalive options).
- [x] **B.0.11.e — Cells team's blocker #3 root-caused + fixed + shipped (SSH reset under rapid calls).** Reproduced 2026-05-09 20:02: 10 rapid `ssh` calls from the host bridge hit `kex_exchange_identification: read: Connection reset by peer` consistently. Inside the guest, journalctl showed `drop connection #0 from [192.168.64.1]:NNNN penalty: connections without attempting authentication`. Root cause: OpenSSH 10 (Ubuntu 25.10) ships with `PerSourcePenalties` ON by default. Welld + lume-side ssh probes during create+warm trigger many "no auth" disconnects from `192.168.64.1` (host bridge); penalties stack at `noauth:1` + `min:15`, so a few minutes of normal usage → host bridge gets dropped for up to 10 minutes. Fix: `templates/well-firstboot.sh` writes `/etc/ssh/sshd_config.d/01-well-host-exempt.conf` with `PerSourcePenaltyExemptList 192.168.64.1` and reloads sshd. Re-baked into `ubuntu-25.10-base` iteration 3. Royal-treatment gauntlet (2026-05-09 20:45): 30/30 rapid serial SSH (was 0/30 pre-fix), 8/8 typical concurrent, 30/30 SSH on fork-of-saved-image, 15s cold fork. Template also adds `MaxStartups 30:30:100` + `MaxSessions 100` for parallel `well_exec` fan-out — bakes in on next clean rebake; cells team's existing guest-side workaround handles it in the meantime.
- [ ] **B.0.11.d — Investigate concurrent fork lume crash.** Three concurrent forks-from-image triggered "lume serve unresponsive; respawning" + the in-flight forks hung. May be related to bundle-creation race or VZ.framework concurrent-create constraints.
- [x] **B.0.11.f — Hibernate pre-flight check (with substrate fallback).** `assertHibernatable` in `lib/lifecycle.ts` refuses save-state when lume's view says the VM is broken (status != running, OR status=running + ipAddress=null + substrate probe confirms unreachable). Loosened from the original hard "ipAddress != null" check after the strict version blocked legit hibernates on freshly-created wells (lume's lease watcher lags ~13s after fresh create). Substrate-truth fallback: if lume reports ipAddress=null but welld can find an IP via vmnet's lease file AND TCP-probe port 22 succeeds, allow. The original cells-team flap motivation (sticky status=running after VZ crash) is still caught — the substrate probe fails when the VM is genuinely dead. 12 unit tests in `lib/lifecycle.test.ts` cover all four substrate states (alive, dead, unknown, lume-agrees).
- [x] **B.0.11.g — Hibernate.bin portability probe.** Wells-side capability question: can a saved-state file from VM A be restored into VM B with a different bundle? Probe at `scripts/exp-hibernate-portability.ts`; findings at `docs/findings-hibernate-portability.md`. Verdict: YES, when the destination bundle mirrors the source's `machineIdentifier`, `macAddress`, `memorySize`, `cpuCount`, and `nvram.bin`. Concurrent operation collides on shared MAC; sequential warming works. Unlocks an opt-in "fork from saved state" image primitive — but requires post-restore MAC randomization (separate probe) before concurrent forks are safe. Updates `docs/proposals/cells-pool-on-wells.md` (test #1 verdict).
- [x] **B.0.11.h — Cells-team flap fully root-caused + fixed at lume layer.** Two issues from the 2026-05-09 23:13 UTC report. (1) Stable's lume hung every 3-5 min with `unresponsive, exitCode:null`, supervisor SIGKILLing each time. Root cause confirmed via `sample` against PID 75872 (`/tmp/lume-stable-baseline-1778369707.txt`): `NetworkUtils.runWithTimeout` polling `process.isRunning` with `Thread.sleep(0.1)` AND `DHCPLeaseParser.getIPFromARP` running `arp -an` via unbounded `Process.waitUntilExit()`. Both block the calling thread; `getVMDetailsLightweight` runs on `@MainActor` (lume's HTTP server is single-threaded), so every info request held the actor for up to 6s per running VM. Under DHCP churn the unbounded ARP hung indefinitely. Fixes in `vendor/lume/`: DHCP file lookup short-circuits ARP fallback (NAT mode never needs ARP), ARP bounded with 2s `DispatchSemaphore.wait` timeout, `runWithTimeout` rewired to terminationHandler + single semaphore wait, inline `isSSHAvailable` probe removed from `getVMDetailsLightweight` and `VM.details`. (2) Side bug: stale-lease lookup in welld's `waitForDhcpLease` — vmnet keeps lease entries indefinitely; smoke-7 returned `192.168.64.134` in 15ms while real VM came up at .136. Fixed with snapshot-aware `isFreshLease` filter in `lib/createWell.ts` + `lib/createWell.test.ts` (6 cases). Plus: welld supervisor now captures `sample <pid>` stack dump to `/tmp/lume-hang-*` before SIGKILLing, so future regressions surface telemetry. Verified on dev: 4 back-to-back create+warm cycles ~14s each, zero respawns. Stable promoted to `wells-stable-2026-05-09h` (commit `5b897bb`). 451 tests green. Breaking change to lume API: `sshAvailable` is always null in `lume info`/`lume list` responses (cells doesn't read this field).

#### B.0.10 — Mount field regression (DONE 2026-05-09)

Cells team root-caused 2026-05-09: every fresh fork had been booting *without* its cidata.iso since commit `b5287ad` (May 8 19:04 PT, "patches → source"). That commit was supposed to bake `0001-add-mount-to-RunVMRequest.patch` permanently into `vendor/lume/src/`, but only the *SaveStateRequest* `mount` field made it across — the *RunVMRequest* `mount` field was dropped on the floor. Welld kept sending `{"mount": "/path/to/cidata.iso"}` on `POST /run`; lume's JSON decoder silently ignored the unknown key; cidata never attached; the VM booted with bake-time identity (hostname `splites-base-mou0ctzh`, build-key authorized only); fresh per-well SSH key never authorized; `waitForSshReady` timed out → welld auto-rolled-back. Three hours of "weird DHCP" debugging traced back here.

- [x] **B.0.10.a — Re-bake the mount patch into source.** `RunVMRequest` gains `let mount: String?`. `Handlers.handleRunVM` extracts it, logs it, parses to `Path`, threads through to `startVM(... mount:)`. `startVM` private helper accepts + logs + forwards to `vmController.runVM(... mount:)` (which already supported it). End-to-end live-verified: fresh fork from `ubuntu-25.10-base` reaches `running` + SSH ready in ~6s.
- [x] **B.0.10.b — Regression canary.** `tests/RunVMRequestTests.swift`: 3 swift-testing cases pin the contract — mount decodes from JSON, absent mount decodes nil, default constructor accepts nil mount. If anyone deletes the field again the suite goes red. Cells team also has the runtime canary (`curl POST /run -d '{"mount":"/no/such/file"}'` → expect "Mount file not found", not 202).
- [x] **B.0.7.h — Cells lifecycle signal endpoint.** `POST /lifecycle` on the `host.well:7879` bridge metadata server, body `{"state":"busy"|"idle"}`. Per the cells-team contract (2026-05-08): cells fires the signal from pi's `agent_start`/`agent_end` events; wells uses it as the primary "agent doing real work" gate for hibernation. Source-IP identifies the well (same as `/sleep`); maps onto the existing `markWorking`/`markIdle` busy tracker. New `lib/cellLifecycle.ts` with parser + applier; coexists with the older `/v1/cells/me/working` surface so existing cells keep working.

#### B.0.6 — Lume SharedVM survives lume serve restart (DONE 2026-05-08)

**Problem:** Lume's `[String: VM]` cache lives in-memory. When lume serve restarts (false-positive supervisor, real crash, OS pressure), every running VM dies because the new lume instance can't reattach to orphan `VirtualMachine.xpc` children. Cells team running 5+ wells loses everything on a hiccup. See [`docs/proposals/B.0.6-lume-shared-vm-restart.md`](proposals/B.0.6-lume-shared-vm-restart.md).

**Strategy:** Treat lume restart as full state loss for *processes*, not for *disk*. On lume serve startup, sweep orphan XPC children and clear stale session files. Welld's `ensureRunning` then brings VMs back via fresh boot (disk persists, in-RAM state lost — same as a real crash). Decomposed:

- [x] **B.0.6.a** — `xpcPid` added to `VNCSession` (Codable migration trivial, optional field decodes nil from legacy JSON). 3 swift-testing cases.
- [x] **B.0.6.b** — Initial attempt: capture VZ child PID at start via `proc_listchildpids()` — discovered it doesn't work because Apple launches XPC services via launchd (VZ child's PPID is 1, not lume's). Pivoted approach in B.0.6.c.
- [x] **B.0.6.c** — `XPCChildLocator.findAllVMProcesses()` walks `proc_listallpids()` filtering by executable path. `LumeController.cleanupOrphanedVMs()` SIGKILLs every match (at lume startup time, none are ours) and clears every stale session file. Hooked into `Server.start()` before bind. 4 unit tests; live-verified each lume start logs `orphan-sweep complete` and clears stale sessions.
- [x] **B.0.6.d** — Built + signed `bin/lume.app` with the Developer ID + virtualization entitlement. Welld picks it up on next start.
- [ ] **B.0.6.e** — Defense-in-depth: welld also invokes the sweep at its own startup. Skipped for now — sweep on lume start is sufficient for the supervisor model. Revisit if we observe sweep-misses.
- [x] **B.0.6.f** — Live: `orph-2` created, lume `kill -9`'d; Apple's framework cleaned up the VZ child at lume's death (no orphan to sweep that pass), then `welld` respawned lume, sweep ran and cleared orph-2's stale session. The kill path is exercised by the unit tests + by the architecture; the previous-session zombie case (PID 45498 running for hours) is exactly what the sweep was built for and would be cleaned on the next lume start.

**B.0.6 status:** ✅ Sweep is shipped and active. Every lume start runs it. lume crash → orphan VZ children + stale sessions cleared on next lume start. SharedVM cache empty after restart, but `well start <name>` brings VMs back via fresh boot (disk persists). Cells team's wells are no longer hostage to one process's uptime.

#### B.0 — Wells-side punch list (from cells team integration pass)

Surfaced when cells plumbed `cells birth --backend=well` end-to-end. Each item is a concrete wells-side fix that unblocks cells's birth flow.

- [x] **`sprite` user via cloud-init** — wells boot with a `/home/sprite` user (uid 1001, NOPASSWD sudo, host SSH keys). Cells's birth flow hardcodes `/home/sprite/...` paths; without this, the first DNS push faceplants. Implemented via `runcmd` in the template, not the cloud-init `users:` module (Ubuntu's cloud image bakes its own default user config and silently drops a second `users:` doc). Verified end-to-end on a fresh well.
- [x] **`/v1/sprites/...` API alias** — bare and prefixed paths both rewrite to `/v1/wells/...` in the daemon. Cells code calls `/v1/sprites/...` everywhere; this lets it work unchanged against welld.
- [x] **`well exec` wakes the well before SSH** — auto-sleep + a stopped well used to make `well exec` race the wake. CLI now POSTs `/v1/wells/{n}/start` before SSH; daemon's start handler calls `ensureRunning` (which also unpauses CPU-paused wells). Cold-start to first exec output: ~5s end-to-end.
- [x] **`--env KEY=VAL` injection at create time** — `well create cells-x --env CELLS_PROXY_SECRET=…` writes the pair to `/etc/environment` via cloud-init. PAM loads it on every session including SSH non-login, so cells's birth flow sees the var without a post-birth round-trip.
- [ ] **Domain unification (`*.cells.md` for wells)** — today wells use `*.wells.cells.md` (depth-2, requires ACM); sprites use `*.cells.md` (depth-1). Cells's CF Worker needs to fork on backend type to pick the DNS pattern. Unifying requires either moving wells to depth-1 (namespace collision with sprites) or moving sprites to depth-2. Architectural call — defer until we hit it under real load. **Not blocking.**

#### B.0.8 — Image contract + DHCP diagnostics (cells punchlist 2026-05-08)

Cells team's smoke from cell-base (saved with the old `clean:true` rinse) failed at "no DHCP lease for smoke-3 within 90000ms". Strategic guidance: don't paper over rinsed images; reject them up front, version saves so future incompatibilities fail fast, and make DHCP timeout self-explaining.

- [x] **B.0.8.a — Always write `/etc/netplan/50-cloud-init.yaml` via user-data write_files + `netplan apply` in runcmd.** cidata's network-config block is unreliable on forks (cloud-init doesn't reapply it on instance-id change for already-configured saved images). Writing the netplan ourselves is deterministic. `lib/cloudInitWell.ts` + template runcmd. Doesn't fix already-tainted cell-base, but is architecturally correct.
- [x] **B.0.8.b — Image contract versioning.** `image_contract_version`, `saved_with_welld_version`, `rinsed: bool` on `ImageMeta`. `saveImage` stamps `CURRENT_IMAGE_CONTRACT_VERSION`. `createWell` rejects images with `rinsed=true` or contract version `< current` with a clear "re-bake from ubuntu-25.10-base" error — bypassing the 90s DHCP wait. Updated the existing `cell-base` meta.json to mark it `rinsed: true` so cells's next birth fails fast with the right pointer.
- [x] **B.0.8.c — DHCP timeout includes lume.info.** `waitForDhcpLease` now reports the VM's lume status alongside the recent leases dump. Distinguishes "guest never booted" from "guest booted but no DHCP" without anyone shelling in.
- [x] **B.0.8.d — Pre-save image validation.** `lib/imageValidation.ts` SSHes into a running source well and asserts the four fork-time prerequisites (`/etc/netplan/50-cloud-init.yaml`, `/var/lib/cloud/data/`, `cloud-init.service` enabled, `systemd-networkd` enabled). Opt-in via `validate: true` on POST `/v1/wells/images` (or `--validate` on `well image save`). When validate=true the daemon requires source running, probes via SSH, refuses with `image_invalid_source` listing failed checks, then stops cleanly and clonefiles. Defense in depth alongside cells's post-save `--verify` flow.
- [x] **B.0.8.e — MAC-first lease lookup.** Netplan written via user-data now sets `dhcp-identifier: mac` (systemd-networkd's `ClientIdentifier=mac`). vmnet records the lease's hw_address as `01,<mac>` instead of an opaque DUID. `WellRecord.mac_address` populated at create time from lume's config.json. `resolveWellIp` order: pinned_ip → lease-by-MAC → lease-by-hostname. `findWellByIp` similarly cross-checks lease MAC against registered wells before hostname. Pre-MAC wells fall back transparently. New `parseDhcpLeasesForMac` + `normalizeMac` + 8 unit tests.
- [x] **B.0.8.f — Fork matrix smoke test.** `scripts/smoke-fork.ts <image> [--count=5] [--prefix=…] [--keep]`. Spawns N wells from a saved image serially, asserts each gets a unique IP + boots. Tears down at the end (or `--keep` for inspection). Run before phase rollovers / cells team integrations to catch fork-path regressions before birth.

#### B.0.1 — Stability follow-ups (queued during cells integration pass)

The cells team integration pass surfaced a class of lume-related instability that's been masked at the welld layer. These items address the underlying causes and operational hygiene. None are blocking the cells team's smoke; all are worth doing before scale-up.

- [x] **Lume SIGINT-on-destroy root cause.** Pinned to `vendor/lume/src/VM/VM.swift:451-454` — `kill(pid, SIGINT)` propagates back to lume serve via shared process-group semantics. Patched at `vendor/lume.patches/swift/0002-fix-SIGINT-process-group-leak.patch` (SIGTERM instead). **Plus a related bug surfaced**: `RunVMRequest` was missing a `mount` field, forcing wells to spawn `lume run` as a subprocess — those VMs aren't in lume serve's SharedVM cache, so pause/resume fail. Patched at `vendor/lume.patches/swift/0001-add-mount-to-RunVMRequest.patch`. `lib/createWell.ts` migrated to use the HTTP API path (commit `1372055`). End-to-end: pause/resume work first try on freshly-created wells; lume crashes drop from ~1+/cycle to ~1/3 cycles in 10-cycle stress.
- [x] **Dangling `lume run` subprocess GC.** When lume serve crashes mid-create, the welld-spawned `lume run <name>` subprocess (which is welld's child, not lume serve's) is orphaned. Visible in `ps aux | grep "lume run"` — often 5–10 dangling processes after a stress run. Add a sweep in welld that kills `lume run` processes whose VM is no longer in the registry. Cheap, contained. (`b72f4f4` — `lib/lumeRunGc.ts`, runs at startup + every watchdog tick.)
- [ ] **DHCP lease cleanup on stop.** `lib/dhcp.ts` now waits for a strictly newer lease post-boot (commit `dd7bf15`), which fixed the staleness bug. Optional follow-up: actively delete the stale entry from `/var/db/dhcpd_leases` on stop, so subsequent reads don't have to compare timestamps. Less load-bearing now that the wait-for-newer logic works; defer unless we hit a related issue.
- [ ] **Test coverage for B.0 changes.** Backfill unit tests for: daemon's `handleLifecycle("start")` using `ensureRunning` (paused → unpaused path), CLI exec wake (mock `/v1/wells/{n}/start` response), `--env` plumbing through `lib/createWell.ts`, lume supervisor's respawn logic. Currently verified by integration only.
- [x] **launchd plist for welld.** `scripts/welld.plist.template` + `scripts/install-launchd.sh` + `scripts/uninstall-launchd.sh`. The install script substitutes the operator's HOME / bun / project path / WELL_PUBLIC_BASE, drops the plist at `~/Library/LaunchAgents/md.cells.welld.plist`, and bootstraps via `launchctl`. KeepAlive on non-zero exit, RunAtLoad, ThrottleInterval=10s. Logs to `~/.wells/welld.log`. Idempotent reinstall. See `docs/install.md` § 9.
- [x] **Telemetry on supervisor respawns.** Sliding-window counter (1min/5min/1hour buckets) in `engine/lumeProcess.ts`; surfaced via GET `/healthz` (`lume.respawns_last_*`, `degraded` boolean). Threshold: 5 respawns in 5min → degraded + error log. Cells team can poll `/healthz` and back off when degraded. Commit `b9616eb`.

#### B.0.2 — Image store (fast forks for cells's birth flow)

Cells's birth flow rebuilds wells from `ubuntu-25.10-base` every time, paying ~3-5 minutes for cloud-init each. Saved disk images cut that to sub-millisecond clonefile + boot.

- [x] **Image store core** (`lib/imageStore.ts`). `saveImage`, `listImages`, `imageMeta`, `removeImage`, `validateImageName`, `imageExists`, `imageDiskPath`. APFS clonefile of the source well's bundle disk into `~/.wells/images/<name>/{disk.img, meta.json}`. 13 unit tests.
- [x] **Schemas** — `ImageResource`, `ImagesListResponse`, `ImageSaveRequest`. `CreateWellRequest.from_image` field added.
- [x] **Daemon routes** — `GET/POST /v1/wells/images`, `GET/DELETE /v1/wells/images/{name}`. Save endpoint refuses if source is `running` (clonefile of a hot disk gets a torn snapshot — 409 `well_running`). Sprites alias works for free.
- [x] **createWell** accepts `fromImage` option, defaults to `ubuntu-25.10-base`. Cloud-init template made idempotent (`id -u well || useradd …`) so re-running on a saved-then-cloned disk doesn't fail.
- [x] **CLI** — `well image (list [--json] | save <well> <name> [--notes=…] | rm <name> | info <name>)` + `well create --from-image=<name>`.
- [x] **Live verify** — image save from stopped `cells-1` clonefiled in <1s; from-image flag passes through end-to-end and the bundle disk gets cloned correctly.
- [x] **Rinse path removed — wasn't needed and broke forks.** Local repro proved it: a plain (no-rinse) save+fork of a fresh well DHCPs cleanly under the new hostname in ~5s, because cloud-init-well.yaml's runcmd already resets machine-id, ssh host keys, and hostname when the fork mounts cidata with a new instance-id. The welld-side rinse was over-aggressive — it stripped `/var/lib/cloud/data/`, `/etc/netplan/50-cloud-init.yaml`, and `/var/lib/systemd/network/`, which cloud-init's re-run depends on. Removed `--clean` flag, `clean`/`rinse_user` schema fields, the `lib/imageRinse.{ts,test.ts}` files, and the daemon-side rinse branch. The cidata-driven cloud-init re-run does the right thing on its own.

#### B.0.4 — Comms-layer speed (Lever 1: SSH ControlMaster, Lever 2: Bridge DNS)

Cells team's birth ritual makes ~8 `well exec` calls; each was paying ~150ms for a fresh SSH handshake. Multi-call agent loops at 50 bounces = 7.5s of pure SSH tax. Lever 1 of the comms-speed plan (`reflective-hatching-squirrel.md`).

- [x] **SSH ControlMaster on welld's exec spawns.** `lib/sshControl.ts` exports `ensureSshMaster()` (spawns `ssh -fN -M` detached + unref'd via `node:child_process` — Bun.spawn tears down detached children, verified empirically) and `sshControlArgs()` (just `ControlPath=…` + `ControlMaster=no` for client connections). Both HTTP and WS exec paths in `daemon/welld.ts` call `ensureSshMaster` before spawning the actual ssh. `lib/lifecycle.ts` (stopWell) and `lib/destroy.ts` close the master via `ssh -O exit` on lifecycle transitions so stale sockets don't accumulate. 12 unit tests.
- [x] **Verified live.** Direct ssh through master: **45ms p50** (was 145ms raw). 3.2× faster at the SSH layer; ~100ms saved per exec call. End-user CLI path (`bun run cli/well.ts exec`) stays at ~420ms because Bun startup + welld HTTP overhead dominate, but cells code that hits the welld HTTP API directly drops from ~250ms to ~150ms. 8-call birth ritual saves ~800ms.
- [x] **Lever 2: Bridge DNS** — `lib/dns.ts` exports `startBridgeDns()`, a UDP listener on `192.168.64.1:5353` that resolves `<name>.well` → registry-hit + (pinned IP or DHCP lease). Pure parse/build functions with 15 unit tests; A-records only, NXDOMAIN for unknown / non-A queries. Welld starts the DNS server alongside the metadata server (same `bridgeIp` gating). Cells cloud-init drops `/etc/systemd/resolved.conf.d/well.conf` with `DNS=$GATEWAY:5353` + `Domains=~well` so the cell's resolver routes `*.well` queries to bridge DNS and falls through to upstream for everything else. Live-smoked: `dig @192.168.64.1 -p 5353 cells-1.well` → `192.168.64.8`; `dig … ghost.well` → NXDOMAIN. 5353 (not 53) avoids macOS privileged-port problem; systemd-resolved 253+ supports `IP:PORT` syntax. Coexists fine with Chrome's `*:5353` mDNS bind because welld pins to the specific bridge IP.
- [x] **Lever 3 (a): Pinned-IP framework** — `lib/pinIp.ts` allocates from `192.168.64.100-249` (skipping any IP held by a current DHCP lease or another well's pin) with 7 unit tests. `WellRecord.pinned_ip?: string` persists the assignment. New `resolveWellIp(name)` helper in `lib/dhcp.ts` prefers `pinned_ip` from the registry over the DHCP-leases lookup; all callsites (welld HTTP / WS exec, lifecycle stop/start, watchdog probe, bridge DNS, wake) routed through it. `findWellByIp` (reverse lookup for the metadata server) also pinned-aware. `startWell` short-circuits the `waitForNewerLease` dance for pinned wells. Backward-compat: old wells (cells-1..5) without `pinned_ip` keep working via the DHCP fallback. **The framework is ready; nothing currently sets `pinned_ip`** — that's L3(b).
- [ ] **Lever 3 (b): Cell-side static netplan injection (REVERTED 2026-05-08, needs investigation).** Two implementation attempts to wire `pinnedIp` into the cell's cidata: (i) cidata `network-config` (static IP from the seed ISO), and (ii) `write_files` for `/etc/netplan/99-wells-pinned.yaml` + runcmd `netplan apply`. Approach (ii) had brief positive ARP signal — pin-1 and pin-2 each had ARP showing `.100` bound to their MAC within ~30s of `lume.start`. But cells stayed unreachable past the brief ARP window, and a longer test run (pin-3, after the watchdog fix landed) showed the cell completely losing networking — both DHCP IP and pinned IP unreachable on ICMP/SSH despite lume reporting `status: running`. Hypothesis: the merge of cloud-init's managed `50-cloud-init.yaml` (DHCP) with our `99-wells-pinned.yaml` (static, `dhcp4: false`) ends up in a state that breaks netplan apply or the resulting interface config. Reverted to keep cells team unblocked. The Lever 3 (a) framework (allocator, schema field, `resolveWellIp` helper) stays in place. **Reopening: needs VNC console access to watch the cell's cloud-init / netplan apply progression.** Possible fixes: replace cloud-init's 50-cloud-init.yaml entirely (remove the DHCP one before adding the static one); skip cidata's network-config if pinned (avoid the merge); use cloud-init's `network` module override at the user-data level; or write the netplan via `bootcmd` (earlier than `write_files`) so it's the only file present when network module first runs.

#### B.0.5 — Lume serve "unresponsive" false positives (FIXED 2026-05-08)

Watchdog in `engine/lumeProcess.ts` respawned lume serve when its HTTP loop went quiet for 30+s during VM spawn. Lume wasn't actually crashing — it was busy holding the HTTP actor while configuring `VZVirtualMachine` and bringing up the `Virtualization.VirtualMachine.xpc` child process. We were misreading "busy" as "dead" and killing healthy lume mid-fork; each respawn dropped the in-flight VM because lume's `SharedVM` cache lives in-memory. Cells team's birth flow regularly hit this on fresh boots.

- [x] **Bump `MISSES_BEFORE_RESPAWN` from 6 → 24.** 30s → 2 minutes before lume is considered dead. Empirically observed VM-spawn blocking is ~30-35s; 2min is 4× margin. Live verified: smoke-1 (fresh fork from `ubuntu-25.10-base`) went from `lume.start` to SSH-ready in **6 seconds** with no respawn — full clean boot.
- [x] **Fast-path real-exit detection.** The threshold bump traded false-positive respawns for slow recovery on actual crashes (we observed a freshie-stop call killing lume serve for real, and the supervisor took the full 2min to respawn). Now the supervisor checks `current.exitCode !== null` before incrementing the miss counter — if the spawned process has exited, respawn immediately. Slow path (HTTP unresponsive but process alive) still rides out the 2min threshold. Best of both.
- [ ] **Long-term: SharedVM survives lume serve restart.** The deeper architecture issue — every running VM is a hostage to one lume serve uptime — needs lume's in-memory cache to repopulate from disk state on startup. Out of scope for this fix; document for Phase B.0.6+ design pass.
- [x] **Lume crashes on welld stop() → ROOT CAUSE FOUND.** Welld's `stopWell` did SSH `shutdown -h now` on the guest *before* calling `lume.stop()`. By the time lume's `VZVirtualMachine.stop()` ran (5s later), the VZ child was in a transitional/halting state and Apple's framework crashed lume serve when called. Isolated by hitting `POST /lume/vms/<name>/stop` directly (no SSH preface) — clean 5s success, lume survived. Fix: removed the SSH-shutdown step from `stopWell`. `VZVirtualMachine.stop()` already does graceful guest poweroff via the VZ power signal; the SSH dance was redundant AND fatal. End-to-end welld stop now: **6 seconds, lume still running, VZ child gone clean.**

#### B.0.3 — Welld death hardening (cells team punch-list item #2)

Cells team observed welld vanishing ~14min into a single-cell birth — process gone (`ps` empty), no log artifacts since the manual launch path didn't tee stderr anywhere. Three defenses, smallest blast-radius first:

- [x] **Self-log when interactive.** `lib/log.ts` now also appends to `WELL_LOG_FILE` (in addition to stderr). `daemon/welld.ts` sets `WELL_LOG_FILE=~/.wells/welld.log` on startup when `process.stderr.isTTY` and the env isn't already set. Launchd-managed welld already redirects stderr to the same file via plist, so it doesn't set the env (would double-write). Manual `bun run daemon/welld.ts` now leaves an artifact if it dies. `docs/install.md` § 9 footnote updated.
- [x] **Global async-leak handlers.** `process.on("unhandledRejection")` and `process.on("uncaughtException")` log + continue instead of crashing. Without these, any fire-and-forget promise that rejects (or any sync throw outside a request handler) takes welld down silently. Bun's HTTP server catches request-handler throws and turns them into 500s without these — the handlers cover background timers, WS callbacks, and the supervisor.
- [x] **Fixed fire-and-forget on exec WS.** `daemon/welld.ts:474` had `proc.exited.then(async (code) => { … ws.close() })` with no `.catch()`. If `ws.close()` threw (e.g. socket already closed), it would bubble as an unhandled rejection. Now wrapped in `.catch()` + the `ws.close()` itself in try/catch.

#### B.1 — Cells flips default backend to wells

- [ ] **Cells-repo change**: cells's birth flow can target either sprites (today's default) or wells. Likely a config knob or per-host flag. Cells stays compatible with both.
- [ ] **Credentials passthrough**: cells's `CELLS_PROXY_SECRET` (used today to route LLM traffic via `proxy.cells.md`) needs to reach pi running inside a well cell. Likely seeded into the cell's environment at create time by the cells birth flow.
- [ ] **Pi config injection**: cells's pi extensions (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`) need to be installed in each well cell's `~/.pi/` at birth. Cells already has this plumbing for sprites; mirror it for wells.

#### B.2 — End-to-end smoke with a real LLM

- [ ] **Birth a cell on wells**: `cells birth pete-on-wells --backend=well` produces a working cell with pi configured, a model selected, and traffic routing through the proxy.
- [ ] **Talk to it**: `cells talk pete-on-wells "hello"` round-trips through the proxy → well → pi → Claude → response. End-to-end working.
- [ ] **Sleep + wake cycle**: cell goes idle, cooperation API fires `/sleep`, cell paused. Next `cells talk` traffic auto-resumes via `ensureRunning`. Verify session state preserved (the agent remembers the previous conversation).
- [ ] **Pulse-driven wake**: cell schedules a wake via `HEARTBEAT.md`, pulse fires `cells talk` at the scheduled time, cell resumes and processes.

#### B.3 — Multi-cell load test

The smoke test the cooperation API was built for, finally feasible because real pi sessions exist:

- [ ] **5 cells running concurrently**: each with a different routine task. Verify cooperation API logs show clean working/sleep cycles for all five. No paused cells stuck. No false-pause incidents.
- [ ] **Mixed workload test**: one heavy cell (autonomous coding session) + 4 routine cells (cron-style). Verify the heavy cell's chunks-or-allocation usage doesn't starve the others.
- [ ] **Stress test**: birth 10+ cells at once. Validate welld's wake-on-traffic dedup (`dedupedStart`) correctly handles concurrent wakes.

#### B.4 — Tuning defaults from real data

- [ ] **Measure actual pi working set**: instrument a cell, sample `free -m` over real pi sessions for several hours. Confirm the floor (currently estimated 250-700 MB, see `docs/memory-budget.md`).
- [ ] **Drop `auto_sleep_seconds` aggressively**: with cooperative pause shipping `/sleep` at every `agent_end`, the 60s outside-in fallback is rarely hit. Confirm it's safe to drop default to 5-10s for cells running well-cooperate. Or even keep 60s fallback for non-cooperative cells, with cooperative cells effectively using "instant pause."
- [ ] **Confirm or revise default cell memory**: based on the measurement, decide if 1 GB is right, or if we can drop to 768 MB or even 512 MB safely. `docs/memory-budget.md` captures the current first-principles estimate; this box replaces it with a measurement.

### Phase C — Memory chunks system

Implement the dynamic memory grant model described in `docs/memory-budget.md`. Lets the host pack 2-3× more cells than static allocation allows by reclaiming idle cells' RAM into a shared chunk pool. This phase is *most useful* after Phase B, when there are real cells running real workloads to exercise the controller.

**Branch:** `feature/phase-c`. Squash to `main` and tag `v0.2.7`.

#### C.1 — Lume balloon control

- [ ] **Lume Swift patch**: add `setBalloon(targetMB)` API on the running VM. Calls Apple's `setTargetVirtualMachineMemorySize` on the existing `VZVirtioTraditionalMemoryBalloonDevice`. The device is already wired in lume's VM config (`vendor/lume/src/Virtualization/VMVirtualizationService.swift:305,467`); we just need to expose the control. ~50-80 lines.
- [ ] **HTTP route**: `POST /lume/vms/:name/balloon` body `{target_memory_mb: 512}`.

#### C.2 — Welld wrapper + pressure controller

- [ ] **`LumeClient.setBalloon(name, mb)`** in `engine/lume.ts` — TypeScript wrapper for the new lume route.
- [ ] **Pressure controller** (~150-200 lines, new module `lib/memoryChunks.ts`):
  - On every cell start, inflate balloon by `(allocation - 512MB)` so the cell sees only its base reservation.
  - On `/sleep` (cooperation API, already shipped), if the cell holds chunks, inflate the balloon to reclaim them.
  - On grant requests (need a mechanism — possibly a new `/v1/cells/me/grant-chunk` endpoint the harness can call before heavy work), deflate by 512 MB.
  - Track total chunks granted, peak concurrent grants, denials.

#### C.3 — Metrics + warnings

- [ ] **Log chunks_granted over time**, exposed via `well info` and a new endpoint.
- [ ] **Warning thresholds**:
  - `p95_24h(capacity_utilization) > 85%` → "Colony regularly using >85% of burst capacity. Consider scaling up RAM."
  - Any moment of `chunks_granted == chunk_pool_size` → "Memory contention right now."
  - A cell requests a chunk and is denied → log a "grant pressure" event.

#### C.4 — Smoke + tuning

- [ ] **Smoke test**: spin up cells past the alive ceiling at the old static allocation. Verify chunks system grants and reclaims correctly. Verify cells under chunks pressure either get the memory they need or page to swap (not OOM).
- [ ] **Tune chunk size**: 512 MB is the design choice; confirm it's optimal vs 256 MB or 1 GB chunks. Smaller chunks = finer granularity but more controller overhead; larger = less overhead but coarser packing.

### Phase D — Multi-Lab Colony (multi-Mac on local network)

The Colony layer from `docs/naming.md` made real. A single Mac (one **Lab**) hits a hard ceiling around 100-200 cells alive (depending on RAM); past that, you add another Mac. This phase makes wells span multiple local-network Macs as one Colony.

**Crucial reframe (2026-05-07):** the original Phase E was "Linux hosting" — port to KVM-on-Hetzner-VPS. Pete's call: that's not the right move. Cloud VPS breaks the local-first thesis (latency, metered RAM, cooperative-pause economics — see `cells/docs/agency.md` § "Local-first, and the memory floor"). The path to scale is **more local Macs**, not cloud. A second Mac in your closet is a Lab; together they're a Colony.

**Branch:** `feature/phase-d`. Squash to `main` and tag `v0.3.0`.

#### D.1 — Multi-Lab discovery

- [ ] **Lab registry.** `~/.wells/labs.json` lists known Labs by hostname/IP and their welld endpoints. CLI: `well lab add <hostname>`, `well lab list`, `well lab remove`.
- [ ] **Cross-Lab CLI**: `well create my-cell --lab=mac-mini-2` creates the cell on the named Lab via that Lab's welld API. Cells already in a Lab are reachable from any other Lab in the same Colony.

#### D.2 — Lab-to-Lab cell migration

- [ ] **Cell migration via Frozen tier.** Hibernation file uploaded to R2, original cell destroyed locally, target Lab pulls from R2 and resumes. Identity preserved. Frozen tier (Phase A.2 + the lifecycle.md Frozen state) is the substrate.
- [ ] **`well move <cell> --to=<lab>`** CLI: orchestrates the migration end-to-end.

#### D.3 — Colony-aware routing

- [ ] **Cells's CF Worker bridge points at a Colony, not a single Lab.** When traffic comes to `pete.wells.cells.md`, the worker checks which Lab currently hosts pete and routes there. Updates atomically when pete migrates.
- [ ] **Pulse runs once per Colony**, scheduling wakes across all Labs. Single source of truth for HEARTBEAT.md state.

#### D.4 — Multi-Lab pressure balancing (uses chunks system from Phase C)

- [ ] **Cross-Lab memory pressure**: when one Lab is at chunk-pool capacity and another has headroom, automatically migrate a hibernating cell to the underutilized Lab. (Optional / advanced.)
- [ ] **Capacity reporting**: `well colony status` shows per-Lab and Colony-wide alive cells, chunk usage, durable cell counts.

### Phase E — Cloud hosting (deprioritized, possibly never)

Originally framed as "port wells to KVM-on-Hetzner-VPS." Deprioritized 2026-05-07: cloud hosting breaks the cooperation-first economics (metered RAM = paused cells aren't free) and adds latency that defeats the cell-to-host sub-millisecond pause/resume win.

If we ever do this, it's probably as cold-storage offload for Frozen-tier cells (R2 already covers that) or as a fallback for users who don't have local hardware. Neither is a near-term need.

**Status:** non-goal for the foreseeable future. If priorities change (someone insists on cloud-only deployment), reconstitute from the original plan in git history.

### (archived) Phase E — Linux hosting (engine pluralism) — DEPRIORITIZED

The Mac MVP proves the architecture. Phase E ports it to a Linux host so wells can live on a $20/mo VPS instead of a Mac in your closet. The user-facing surface (CLI verbs, REST shapes, cells integration) stays identical — only the engine boundary swaps. ADR: [`decisions/0003-multi-engine.md`](decisions/0003-multi-engine.md).

**Branch:** `feature/phase-e`. Squash to `main` and tag `v0.3.0` when all boxes are checked.

**Hosting target:** Hetzner CCX21 (4 vCPU, 16 GB RAM, KVM-enabled, ~$30/mo) or any KVM-enabled Linux VPS. Code targets generic KVM Linux; smoke runs against Hetzner.

#### E.1 — Engine boundary cleanup

- [ ] **Document the engine interface.** `engine/INTERFACE.md` enumerates the contract every engine satisfies: `create`, `delete`, `start`, `stop`, `info`, `list`, plus the disk path conventions and cidata expectations. `engine/lume.ts` is reference impl.
- [ ] **Engine selection.** `WELL_ENGINE` env var (`lume` | `firecracker`). Default by `os.platform()`: Darwin → lume, Linux → firecracker. Welld picks at startup.
- [ ] **Disk-clone abstraction (`lib/clonefile.ts` → `lib/diskClone.ts`).** Detect filesystem at startup: APFS uses `clonefile(2)`, btrfs/xfs uses `cp --reflink=auto`, fallback creates a qcow2 backing file. Same `cloneDisk(src, dst)` API regardless.
- [ ] **DHCP discovery abstraction.** `lib/dhcp.ts` already reads `/var/db/dhcpd_leases` on Mac. Add Linux readers for `dnsmasq.leases` and `systemd-networkd` lease files. Engine config tells which backend to use.

#### E.2 — Firecracker engine

- [ ] **`engine/firecracker.ts` skeleton.** Wraps the firecracker REST API (Unix socket `/tmp/firecracker-<n>.sock`). Implements the engine interface from E.1.
- [ ] **Boot flow.** Kernel + initrd path conventions; cidata ISO mounted as a second drive. Same Ubuntu 25.10 cloud image as Mac (it's KVM-bootable).
- [ ] **Network: tap + bridge.** Welld creates a tap per well, attaches to a bridge (`wells0`). DHCP via dnsmasq running on the host (configured by welld at startup).
- [ ] **Lifecycle parity smoke.** Same lifecycle.test.ts but pointing at firecracker engine. `bun test` passes on a Linux box.

#### E.3 — Hosting smoke

- [ ] **`scripts/install-linux-host.sh`.** One-shot setup for a fresh Hetzner box: install firecracker, dnsmasq, welld deps; configure systemd unit; download base image; enable IP forwarding. Idempotent.
- [ ] **`scripts/smoke-cells-call-shapes.sh` runs Linux-side.** Same smoke that gates Mac, against welld running on the VPS via a tunnel.
- [ ] **Cross-host checkpoint round-trip.** Create on Mac, push to R2 (Phase A.2), restore on Hetzner. Document any disk-format limitations discovered.

#### E.4 — Documentation

- [ ] **`docs/install-linux.md`.** Counterpart to `docs/install.md`. Hetzner-specific tips for cloudflared + ACM cert + firewall.
- [ ] **`docs/architecture.md` update.** Lifecycle diagram updated to show both engines side-by-side.

## Loop discipline

When the `/mvp-wells` loop fires, the running agent should:

1. Read this file. Find the first phase with unchecked items.
2. Identify the smallest next checkbox to make progress on.
3. Implement it. Write tests where it makes sense. Run them.
4. Commit with a clear message naming the phase + checkbox.
5. Update the checkboxes in this file. Commit the doc change too (or in the same commit).
6. If a whole phase is complete, append a short note under the phase title: `**Done — <yyyy-mm-dd>.**`, squash-merge that phase's branch to `main`, tag the version (Phase A → `v0.2.0`, Phase E → `v0.3.0`), then start the next phase.

**Bounded:** one loop run = roughly one focused chunk of work. If a checkbox is huge, decompose it into sub-checkboxes during the run; check the easy ones, defer the rest.

**Branch convention:** one feature branch per phase. MVP shipped on `feature/mvp` (already merged + tagged `v0.1.0`). Phase A lives on `feature/phase-a`, Phase E on `feature/phase-e`. Don't commit to `main` directly — only the phase-end squash-merge lands on `main`.

**When stuck:** write the blocker to `docs/BLOCKED.md` (date, what was tried, what's needed from Pete). Commit. Stop the run. The next run reads BLOCKED.md and skips new work until it's resolved.
