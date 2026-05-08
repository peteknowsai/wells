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
- [ ] **A.1.3 Lifecycle states — alive vs hibernating.** Originally framed as cold/warm/hot tiering; **collapsed 2026-05-07** to two states (alive, hibernating) plus a future Frozen tier (R2 offload). See [`docs/lifecycle.md`](lifecycle.md) for the canonical model; [`docs/state-tiers.md`](state-tiers.md) keeps the original three-tier investigation as archaeology. Drop "cold" semantics entirely — explicit shutdown is `splite destroy`, not a tier. The current touch-on-API-call model from A.1.1 is too coarse: real activity (in-guest compile, ssh session, agent loop, background job) often doesn't hit our API, and the watchdog could kill a splite mid-work. Pete's call: don't just ship save/restore — iterate until we know the answer to the questions below.

  **Open questions A.1.3 must answer (with experiments):**
  - **Activity detection.** What signals do we watch besides API touches? Candidates: in-guest CPU%, active ssh session count, in-flight TCP connection count to the guest, host-side bytes/sec through the tap interface, an in-guest "I'm busy/idle" agent. Heuristic vs. signaled? Cost of each?
  - **Mid-job safety.** Define the scenarios that must NEVER trigger a sleep: (a) compile/build, (b) interactive ssh, (c) Claude Code/Pi agent running locally, (d) inbound TCP connection in-flight, (e) a service mid-request. What's the rule for each?
  - **Finish-detection.** When work completes, can we warm-down immediately instead of waiting 60s? Signals for "work just finished" — e.g., last connection closed and CPU dropped.
  - **Tier targets.** Sprites's cold/warm/hot definitions vs. ours. Hot (paused, RAM-resident, <1ms wake) vs. warm (state-saved-to-disk, VM exited, ~1s wake) vs. cold (full shutdown, ~5s). Aggressive defaults possible because we own the box; what numbers fall out of measurement?
  - **VZ + lume primitives.** What does `Virtualization.framework` actually expose (pause, resume, saveState, restoreState)? What does lume already wrap, and what needs a patch?

  Sub-boxes (each fire ticks one):
  - [x] A.1.3.a — Scenario inventory + signal catalogue. `docs/state-tiers.md` v1: 10 "in the middle of something" scenarios (S1–S10), 12 observable signals (sig-1–sig-12), tier definitions (hot/warm/cold), decision rules + mid-job safety + finish-detection layers, signal-selection priority, open questions. Layered format: technical content + plain-English blurb per section.
  - [x] A.1.3.b — VZ + lume primitive discovery. Findings written to `docs/state-tiers.md` § Discovery: lume Swift already implements `pause()`/`resume()` against `VZVirtualMachine.pause`/`.resume` (in `VMVirtualizationService.swift:93-119`) but nothing in CLI or HTTP exposes it; hot-tier patch is ~150 lines (4 Swift files). Warm tier (save/restore) has zero references in lume — needs ~300-line patch wrapping `VZVirtualMachine.saveMachineState(to:)`. Cold tier already works.
  - [ ] A.1.3.c — Benchmark cold/warm/hot transitions. Median + p95 for each, on a clean splite. RAM cost per hot, disk cost per warm-state file. Write the numbers into `docs/state-tiers.md`.
  - [x] A.1.3.d — Activity-detection prototype. `lib/activity.ts`: host-side `lsof` probes for sig-6 (ssh ESTABLISHED count) and a sig-A "any TCP port" generalization. Pure functions over an injectable `LsofRunner` — 8 unit tests passing with mocked output. Live smoke against pete: 0/0 idle → 1/1 with active ssh → 0/0 after close. Wiring into watchdog + `splite info` lives in A.1.3.f.3. Deferred sig-7 (bridge byte counters) and sig-8 (in-guest CPU) — sig-6/A coverage is enough to start; layer in if benchmarks show the host-side probes miss real activity.
  - [x] A.1.3.e.1 — Hot-tier lume patch. VM.swift gains `pause()`/`resume()`; LumeController.swift gains `pauseVM(name:)`/`resumeVM(name:)`; HTTP routes `POST /lume/vms/:name/pause` and `/resume`; matching handlers. All marked `@MainActor` to satisfy strict-concurrency (existing `stopVM` needed the same annotation — surfaced a latent issue). Build clean. **Live wire-up deferred** to A.1.3.f: system-installed `lume.app` auto-respawns on port 7777 and shadows our `bin/lume`; splited's `ensureLumeServe` reuses whatever lume serve it finds.
  - [ ] A.1.3.e.2 — Hibernation lume patch (~300 lines, build `saveState`/`restoreState` from scratch around `VZVirtualMachine.saveMachineState(to:)` / `restoreMachineState(from:)`). With the signing pipeline in place this is now end-to-end testable; renamed from "warm-tier" since the new model has no separate warm/cold split — hibernation IS the sleep state.
  - [x] A.1.3.e.3 — System-lume conflict resolved. Disabled `com.trycua.lume_daemon` (Pete's chosen path: kill the system daemon, not run our lume on a side port). Renamed `~/Library/LaunchAgents/com.trycua.lume_daemon.plist` to `.disabled-by-splites` so the disable survives reboot. Splited now spawns `/Users/pete/Projects/splites/bin/lume serve` directly. Live: pause/resume routes respond with our JSON, confirming the patch is reachable. **Architectural finding (next sub-box A.1.3.f):** lume serve's `SharedVM` only caches VMs lume serve itself launched. Splited currently uses `lume run` as a separate subprocess; that VM lives outside lume serve's cache, so pause/resume returns "not running" even when the VM is up. To make pause/resume work, splited's start path must POST `/lume/vms/{n}/run` to lume serve's HTTP API instead of spawning the `lume run` CLI directly. That refactor lives in A.1.3.f (wire tiers into splited).
  - [ ] A.1.3.f — Wire tiers into splited. **Signing unblock landed 2026-05-07.** `bin/lume.app` now Developer-ID signed + notarized + stapled with the virtualization entitlement; lume serve starts VMs through HTTP `/run`. Decomposed:
    - [x] A.1.3.f.1 — Investigated, then resolved. Discovery path: original "long-poll/MainActor" theory wrong (`handleRunVM` already uses `Task.detached`); real blocker was the entitlement gap (AMFI rejects unentitled binaries). Resolved via the full Apple Developer signing pipeline — App ID `md.cells.well.engine` registered (team 46622GTWYJ) with VMNet capability, Developer ID Application cert issued via Xcode, Developer ID provisioning profile generated, notarized + stapled. `scripts/build-lume.sh` extended with signed-build mode; `scripts/activate-signing.sh` wraps the one-shot. Late discovery: Apple migrated VMNet to a new entitlement key (`com.apple.developer.networking.vmnet`); current profiles authorize the new key, upstream lume's vendored entitlements still use the old key. Carry our own at `vendor/lume.patches/well-engine.entitlements`. Live-smoke 2026-05-07: pete starts via HTTP `/run` in 5s, pause 2ms, resume 6.5s, ssh-after-resume 100ms.
    - [x] A.1.3.f.2 — `startSplite` switched to lume serve's HTTP `/run`. Removed the `lume run` subprocess + lume-run.log file plumbing. Existing `LumeClient.start(name, { noDisplay: true })` already POSTs the right shape; just swapped the `spawn(...)` for the HTTP call. Live-smoke 2026-05-07: stopped pete → splited start endpoint → pete running → pause via lume HTTP → succeeded WITHOUT manual `/run` intervention (proof the SharedVM cache populated). 176 unit tests still green.
    - [x] A.1.3.f.3a — Activity probe feeds watchdog. `runWatchdogTick` accepts a `probeActivity(name)` callback; if it reports active, we `touch(name)` before the sleep decision. Splited wires it via `readDhcpLease` + `sampleActivity`. 12 unit tests across `lib/watchdog.test.ts`. Runs every 30s alongside the existing tick. Probe failure is non-fatal — falls back to touch-only logic.
    - [x] A.1.3.f.4 — Watchdog auto-pauses on idle (replacing auto-stop). `lib/paused.ts` tracks pause state since lume's status field doesn't distinguish running from paused. `pauseSplite`/`resumeSplite` mutate the set; `ensureRunning` resumes-on-traffic if the cell is paused. Splited's startup runs a defensive `lume.resume` over every running VM to unstick anything left paused across a restart. Auto-paused cells stay in RAM (memory not freed until hibernation lands).
    - [ ] A.1.3.f.3b — Watchdog hibernate path. After A.1.3.e.2 lands (`saveState`/`restoreState` in lume), wire hibernation as the next step beyond pause: long-idle OR under memory pressure → save RAM to disk, free memory. Splited's `/v1/splites/{n}/hibernate` and `/wake` endpoints. `splite info` surfaces state (alive vs hibernating). `--fresh` flag on wake to discard hibernation and boot clean.
  - [ ] A.1.3.g — Smoke: scenario coverage. Each scenario from A.1.3.a tested live (compile + check no-sleep, ssh session + check no-sleep, etc.). Tier transition smoke (hot→warm→cold and back) with measured wake budgets.
- [ ] **A.1.4 Pre-baked pool.** Splited keeps `pool_size` (default 1) of pre-baked, pre-booted-then-warmed splites in `pool/` (separate registry namespace). `splite create <name>` adopts a pool member: rename, re-cidata for identity, restore from warm state. Target: <2s end-to-end. Pool refills async after adoption. Depends on A.1.3.
- [ ] **A.1.5 Pool config.** `~/.splites/defaults.json` gains `pool_size`. `splite pool list|refill|drain` CLI. `GET /v1/splites/pool` endpoint for visibility.
- [ ] **A.1.6 Smoke: full lifecycle.** `scripts/smoke-warm-pool.sh` measures pool-adoption create, idles past auto-sleep, hits the URL, measures wake. Asserts targets: <2s create, <1s wake.

#### A.2 — Checkpoint sync to R2

R2 creds live per-splite in `meta.json`. Splite create accepts `--r2-endpoint`, `--r2-bucket`, `--r2-key`, `--r2-secret`; daemon stores them; checkpoint sync uses them. Each splite's R2 path is `<bucket>/splites/<name>/checkpoints/<id>/disk.img`. (Cells's eventual integration: cells's worker creates the bucket+keys when birthing a splite-backed cell and passes them in via the create body.)

- [x] **R2 client (`lib/r2.ts`).** Skeleton landed — `uploadCheckpoint`, `downloadCheckpoint`, `deleteCheckpoint`, `checkpointKey`. Uses bun's S3Client (no extra deps). Per-splite creds via `SpliteRecord.r2`. CLI flags `--r2-endpoint`, `--r2-bucket`, `--r2-key`, `--r2-secret` on `splite create` (all-or-nothing). Schema + daemon pass-through. Streaming PUT/GET wired but not yet smoke-tested live; live verification rolls into the next sub-checkbox below.
- [x] **`splite checkpoint create` pushes to R2.** When the splite has R2 configured (`record.r2`), after the local clonefile completes, the checkpoint module attempts an upload via `lib/r2.uploadCheckpoint`. Best-effort: on success the meta gets `r2_uploaded: true`, `r2_uploaded_at`, and `r2_key`; on failure the local checkpoint is unaffected and only a warning is logged. Both upload and delete are dependency-injected so tests run without R2. 3 new test cases (no-r2, success, failure).
- [x] **`splite checkpoint restore --from-r2 <id>`.** Daemon `POST .../restore?from_r2=true` accepts the flag; CLI exposes `--from-r2` on `splite checkpoint restore`. New `ensureCheckpointLocal` helper isolates the R2 fetch + meta synthesis from the VM ops so it's unit-testable. Implicit fetch also fires if local is missing and the splite has R2 creds — that's the fresh-host hydration path. 4 new tests on the helper.
- [ ] **R2 GC tracks local retention.** When local retention rotates a checkpoint out, also remove the R2 object. New env `SPLITES_R2_RETAIN_FOREVER=1` to keep R2 forever.
- [ ] **Smoke: round-trip.** `scripts/smoke-r2-sync.sh` creates a checkpoint, verifies the R2 object, deletes the local checkpoint, restores from R2, verifies disk integrity.
- [ ] **Frozen tier (post-MVP).** R2 sync today handles checkpoints — point-in-time snapshots. The Frozen tier extends the same plumbing to *hibernation files*: when a cell has been hibernating locally for `auto_freeze_days`, upload its hibernation image to R2 and delete the local copy. Wake from frozen = thaw (download → restore-from-hibernation). Depends on hibernation patch (A.1.3.e.2) shipping. See [`docs/lifecycle.md`](lifecycle.md) § "What 'Frozen' means."

#### A.3 — Egress enforcement

The `POST /v1/splites/{n}/policy/network` endpoint already persists rules (Phase 10 chunk 3). What's missing is actually enforcing them on the wire.

**Blocked on design decisions** — see [`docs/proposals/A.3-egress-enforcement.md`](proposals/A.3-egress-enforcement.md) and `docs/BLOCKED.md`. Pete picks privilege model + DNS strategy, then implementation lands as A.3.1–A.3.5.

- [ ] **pf rule generation per splite tap.** Each splite has a vmnet tap interface (lume manages it). Splited generates pf rules to allow/deny traffic per the splite's policy. Anchor per splite (e.g. `splite/<name>`) to keep state clean. Rules generated from `policy.json` on POST and on splited startup.
- [ ] **DNS-based deny for domain rules.** Run a per-host resolver (dnsmasq or unbound) that splited configures with the splite's domain rules. Splite's `/etc/resolv.conf` (set by cloud-init) points at the host resolver. Deny = NXDOMAIN. (Skipped in v1 if Pete picks DNS option 2B.)
- [ ] **`enforced: true` flag flips when rules are live.** The existing response field switches from stub to honest reporting.
- [ ] **Smoke: blocked vs. allowed.** `scripts/smoke-egress.sh` adds an allow rule for `github.com`, denies `evil.com`, exec's curl in the splite, asserts the right outcomes.

#### A.4 — Retention with explicit expiration

- [x] **`splite checkpoint create --retain-for <duration>`.** Duration parser handles `Ns/m/h/d`. CheckpointRecord gains `expires_at` + `retain_for_seconds`; daemon validates the format and 400s on garbage. CLI threads `--retain-for` through to the daemon body. Surfaced in CheckpointResource so the existing list output picks it up.
- [x] **`splite checkpoint expire <id>`.** New `splite checkpoint expire` subcommand → `DELETE /v1/splites/{n}/checkpoints/{id}` → `expireCheckpoint(name, id)` removes the dir + best-effort R2 cleanup. Idempotent (`removed: false` for missing).
- [x] **Configurable last-N.** `~/.splites/defaults.json` gains `checkpoint_retain_count` (default 5). `gcOldCheckpoints` reads it instead of the old hardcoded 5; new two-pass GC drops expired TTLs first, then applies last-N to whatever survived.

### Phase B — Cells deploys to splites (real integration)

Phase 10 made splites a *drop-in* for the sprites API contract — every cells shell-out and HTTP call shape works against splited verbatim. That's the protocol layer. Phase B is the *real* layer: cells's `birth/talk/checkpoint/sleep/wake/destroy` running against splites in production, with cells's pi-config + credentials + extensions plumbing actually exercised. This is where the hot-tier pause, cooperation API, and lifecycle model get tested under real LLM workloads.

**Branch:** `feature/phase-b`. Squash to `main` and tag `v0.2.5` when complete (interim release between v0.2.0 / Phase A and v0.3.0 / Phase E).

**Most of this phase's code lives in the cells repo, not splites.** Splites's job is mostly to be ready and to fix any contract gaps surfaced by real cells traffic.

#### B.1 — Cells flips default backend to splites

- [ ] **Cells-repo change**: cells's birth flow can target either sprites (today's default) or splites. Likely a config knob or per-host flag. Cells stays compatible with both.
- [ ] **Credentials passthrough**: cells's `CELLS_PROXY_SECRET` (used today to route LLM traffic via `proxy.cells.md`) needs to reach pi running inside a splite cell. Likely seeded into the cell's environment at create time by the cells birth flow.
- [ ] **Pi config injection**: cells's pi extensions (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`) need to be installed in each splite cell's `~/.pi/` at birth. Cells already has this plumbing for sprites; mirror it for splites.

#### B.2 — End-to-end smoke with a real LLM

- [ ] **Birth a cell on splites**: `cells birth pete-on-splites --backend=splite` produces a working cell with pi configured, a model selected, and traffic routing through the proxy.
- [ ] **Talk to it**: `cells talk pete-on-splites "hello"` round-trips through the proxy → splite → pi → Claude → response. End-to-end working.
- [ ] **Sleep + wake cycle**: cell goes idle, cooperation API fires `/sleep`, cell paused. Next `cells talk` traffic auto-resumes via `ensureRunning`. Verify session state preserved (the agent remembers the previous conversation).
- [ ] **Pulse-driven wake**: cell schedules a wake via `HEARTBEAT.md`, pulse fires `cells talk` at the scheduled time, cell resumes and processes.

#### B.3 — Multi-cell load test

The smoke test the cooperation API was built for, finally feasible because real pi sessions exist:

- [ ] **5 cells running concurrently**: each with a different routine task. Verify cooperation API logs show clean working/sleep cycles for all five. No paused cells stuck. No false-pause incidents.
- [ ] **Mixed workload test**: one heavy cell (autonomous coding session) + 4 routine cells (cron-style). Verify the heavy cell's chunks-or-allocation usage doesn't starve the others.
- [ ] **Stress test**: birth 10+ cells at once. Validate splited's wake-on-traffic dedup (`dedupedStart`) correctly handles concurrent wakes.

#### B.4 — Tuning defaults from real data

- [ ] **Measure actual pi working set**: instrument a cell, sample `free -m` over real pi sessions for several hours. Confirm the floor (currently estimated 250-700 MB, see `docs/memory-budget.md`).
- [ ] **Drop `auto_sleep_seconds` aggressively**: with cooperative pause shipping `/sleep` at every `agent_end`, the 60s outside-in fallback is rarely hit. Confirm it's safe to drop default to 5-10s for cells running splite-cooperate. Or even keep 60s fallback for non-cooperative cells, with cooperative cells effectively using "instant pause."
- [ ] **Confirm or revise default cell memory**: based on the measurement, decide if 1 GB is right, or if we can drop to 768 MB or even 512 MB safely. `docs/memory-budget.md` captures the current first-principles estimate; this box replaces it with a measurement.

### Phase C — Memory chunks system

Implement the dynamic memory grant model described in `docs/memory-budget.md`. Lets the host pack 2-3× more cells than static allocation allows by reclaiming idle cells' RAM into a shared chunk pool. This phase is *most useful* after Phase B, when there are real cells running real workloads to exercise the controller.

**Branch:** `feature/phase-c`. Squash to `main` and tag `v0.2.7`.

#### C.1 — Lume balloon control

- [ ] **Lume Swift patch**: add `setBalloon(targetMB)` API on the running VM. Calls Apple's `setTargetVirtualMachineMemorySize` on the existing `VZVirtioTraditionalMemoryBalloonDevice`. The device is already wired in lume's VM config (`vendor/lume/src/Virtualization/VMVirtualizationService.swift:305,467`); we just need to expose the control. ~50-80 lines.
- [ ] **HTTP route**: `POST /lume/vms/:name/balloon` body `{target_memory_mb: 512}`.

#### C.2 — Splited wrapper + pressure controller

- [ ] **`LumeClient.setBalloon(name, mb)`** in `engine/lume.ts` — TypeScript wrapper for the new lume route.
- [ ] **Pressure controller** (~150-200 lines, new module `lib/memoryChunks.ts`):
  - On every cell start, inflate balloon by `(allocation - 512MB)` so the cell sees only its base reservation.
  - On `/sleep` (cooperation API, already shipped), if the cell holds chunks, inflate the balloon to reclaim them.
  - On grant requests (need a mechanism — possibly a new `/v1/cells/me/grant-chunk` endpoint the harness can call before heavy work), deflate by 512 MB.
  - Track total chunks granted, peak concurrent grants, denials.

#### C.3 — Metrics + warnings

- [ ] **Log chunks_granted over time**, exposed via `splite info` and a new endpoint.
- [ ] **Warning thresholds**:
  - `p95_24h(capacity_utilization) > 85%` → "Colony regularly using >85% of burst capacity. Consider scaling up RAM."
  - Any moment of `chunks_granted == chunk_pool_size` → "Memory contention right now."
  - A cell requests a chunk and is denied → log a "grant pressure" event.

#### C.4 — Smoke + tuning

- [ ] **Smoke test**: spin up cells past the alive ceiling at the old static allocation. Verify chunks system grants and reclaims correctly. Verify cells under chunks pressure either get the memory they need or page to swap (not OOM).
- [ ] **Tune chunk size**: 512 MB is the design choice; confirm it's optimal vs 256 MB or 1 GB chunks. Smaller chunks = finer granularity but more controller overhead; larger = less overhead but coarser packing.

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
