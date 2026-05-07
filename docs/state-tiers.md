# State tiers — design notes

The substrate that lets splites be aggressive about idle without breaking the user. Three tiers (cold, warm, hot) plus an activity-detection layer that decides when each is safe.

This is a working document. Treat the numbers as targets-to-validate, not promises. Sub-phase A.1.3 in `docs/MVP-PLAN.md` enumerates the experiments that will set the values. Update this file as those land.

## Why this matters

Phase A.1.1 ships an autosleep watchdog. Phase A.1.2 ships wake-on-demand. Together they make a splite act ephemeral: idle for 60s → stopped → traffic comes in → started. But two problems with that v1:

1. **The 60s threshold is wasted time.** When work finishes, the splite has nothing to do. Why wait 60s? A finer "are we actually busy" signal lets us downshift immediately.
2. **The "touch on API call" model is too coarse.** Real activity often doesn't hit the API:
   - In-guest compile / build / install
   - Interactive ssh session held open
   - In-guest agent (Pi, Claude Code) talking to outside services
   - Background TCP service holding inbound connections
   - Long-running exec command
   - Mid-flight HTTP response or file transfer

   With v1 only, the watchdog could stop a splite mid-job. That's worse than not having autosleep.

The tier model + activity detection answers both: stop earlier when truly idle, never stop when busy.

**In plain English:** Right now, a splite goes to sleep after 60 seconds of no API hits. That's a problem in two ways. (1) Sometimes the splite is *actually* busy — it's running a build, or someone's ssh'd in, or an agent is working — but doesn't happen to be hitting our API. We'd kill it mid-job. (2) Sometimes the splite is genuinely done with its work, but we make it wait the full 60 seconds before sleeping. Both are fixable with a smarter "is this thing busy" detector and a richer set of sleep depths than just "running" and "stopped."

## Tiers

| Tier | RAM cost | Disk cost (beyond disk.img) | Wake cost |
|---|---|---|---|
| **Hot** | full VM allocation (e.g. 4GB) | 0 | sub-millisecond |
| **Warm** | **0** | state file ≈ RAM size (~4GB per splite) | ~1s (target, validate in A.1.3.c) |
| **Cold** | 0 | 0 | ~5s (4.9s measured Phase 5) |

The critical thing: **warm uses zero RAM.** The memory has been dumped to disk and the VM process has exited. When you wake it, the file is read back. Disk space is the only ongoing cost.

### Sizing for the 300-cell scenario

A realistic cells-on-splites fleet: ~300 cells, only 5–10 concurrent at any moment. The tier defaults should target this shape:

| Population | Tier | RAM cost (4GB/splite) | Disk cost (4GB state file/splite) |
|---|---|---|---|
| 5–10 active right now | hot | 20–40 GB | 0 |
| ~50 recently-used | warm | 0 | ~200 GB |
| 240+ long tail | cold | 0 | 0 |
| **Total** | — | **20–40 GB RAM** | **~200 GB disk** |

This works on a 64GB Mac Mini (RAM headroom for the host + apps), but the ~200GB of warm-state files is real disk pressure on a typical SSD. Two levers:

1. **Tighter `warm_window`.** Drop to cold faster — say 30 minutes instead of 1 hour. Keeps warm population smaller.
2. **Compressed state files.** VZ may already write a sparse/compact format; if not, we can gzip on save and decompress on restore (adds wake latency). Benchmark in A.1.3.c.

**Wake-from-hot** is the user-experience target for the 5–10 active cells. They tap, it's there.

**Wake-from-warm** is the workhorse for the long tail of 50 recently-used cells. ~1s is acceptable.

**Wake-from-cold** is fine for the 240+ archival cells. ~5s once a day or once a week is unnoticeable.

The watchdog (A.1.1.c, already shipped) only knows "running → cold." Adding tiers is A.1.3.

**In plain English:** Three sleep depths instead of one. **Hot** is like closing the laptop lid — the VM is paused but its memory stays in RAM. Wake is instant. Costs RAM. **Warm** is like hibernating to SSD — the VM's memory dumps to a file on disk, the VM exits, the file gets read back on wake. ~1 second wake. **Costs zero RAM** — just disk space (a few GB per splite). **Cold** is full power-off. ~5 seconds to boot back up. Costs nothing extra. For a 300-cell setup where only 5-10 are concurrent: 5-10 stay hot (using ~30GB RAM), maybe 50 stay warm (using ~200GB disk for fast wake), and the rest sleep cold. Warm is where most splites live at scale — RAM headroom isn't the constraint, disk is.

## Scenarios — "in the middle of something"

Every scenario below must NOT trigger a sleep, even if the API touch timestamp is stale. Each row maps to one or more signals from the catalogue below.

| # | Scenario | Example | Failure mode if missed |
|---|---|---|---|
| S1 | Long-running build/compile | `cargo build --release` (5 min) | build dies, user re-runs |
| S2 | Interactive ssh session | dev typing in `splite console` | connection drops, lost edit |
| S3 | In-guest agent loop | Claude Code making LLM calls outbound | agent killed mid-conversation, lost context |
| S4 | Background TCP service | webhook receiver, chat bot daemon | clients disconnect, reconnect storm |
| S5 | Multi-step orchestration | cells's bridge sending bursts of agent messages | session torn down between turns |
| S6 | Scheduled job approaching | cron job due in 30s | job misses its window |
| S7 | In-flight HTTP request | LLM streaming response, large file upload | client disconnected mid-response |
| S8 | WebSocket session | cells's persistent `/agent` WS | session torn down |
| S9 | File transfer mid-flight | `tar c \| splite exec -- tar xz` | transfer interrupted |
| S10 | Quiet idle (truly nothing) | splite booted, sshd listening, no work | (this IS the sleep candidate) |

S1–S9 must trigger a "stay awake" decision. S10 must trigger "go warm." The activity-detection layer is what tells these apart.

**In plain English:** This is the list of "don't kill me, I'm working" cases we have to handle. A 5-minute compile shouldn't die because no API call hit splited. An ssh session shouldn't drop while you're typing. A Claude agent loop shouldn't get terminated mid-thought. Each row is a real failure if we get it wrong. Only S10 (genuinely doing nothing) is fair game for sleep.

## Signals catalogue

Each signal has a cost (how expensive to sample), granularity (live vs. snapshot vs. windowed), and reach (which scenarios it covers).

| # | Signal | Source | Cost | Granularity | Covers |
|---|---|---|---|---|---|
| sig-1 | Authed API touch | splited (already wired in A.1.1.a) | free | per-request | inbound to splited |
| sig-2 | Proxy HTTP request in-flight | splited tracks open fetch promises | free | live | S7 |
| sig-3 | Proxy WS frame within last 5s | splited touches on every frame (A.1.1.a) | free | live | S5, S8 |
| sig-4 | Active inbound exec (HTTP or WS) | splited's open subprocesses + open WS sessions | free | live | exec scenarios |
| sig-5 | Active outbound WS session in proxy bridge | splited's WS proxy session map | free | live | S5, S8 |
| sig-6 | TCP connections to guest:22 (ssh) | host-side `lsof -iTCP:22 -sTCP:ESTABLISHED` | low (poll) | snapshot | S2, also surfaces splite exec since it's ssh |
| sig-7 | Tap interface bytes/sec | host-side `netstat -I bridge100 -b` (or analogous) | low (poll) | windowed | S1, S3, S4, S9 (anything pushing bytes) |
| sig-8 | In-guest CPU% | ssh + `awk` over `/proc/stat` | medium (ssh poll) | windowed | S1, S3 |
| sig-9 | In-guest active sshd sessions | ssh + `who \| wc -l` | medium (ssh poll) | snapshot | S2 (overlaps sig-6) |
| sig-10 | In-guest "I'm busy" file | guest writes `/var/run/splite-busy`, splited polls via ssh | low (ssh poll) | explicit | any scenario where the workload cooperates |
| sig-11 | In-guest systemd unit state | ssh + `systemctl is-active --state=running` | medium (ssh poll) | snapshot | S4, S6 |
| sig-12 | Pending scheduled jobs | ssh + `systemd-analyze timers` or cron next-run query | medium | snapshot | S6 |

**Signal selection — what we'll actually wire:**

A.1.3.d (prototype) implements the smallest set that covers most scenarios. Order of likely value:

1. **sig-2, sig-3, sig-4, sig-5** (already in splited; free) — covers all proxy and exec scenarios (S5, S7, S8, exec).
2. **sig-6** (host-side ssh connection count) — covers S2 directly. Cheap. No guest cooperation needed.
3. **sig-7** (tap bytes/sec) — broad coverage of S1, S3, S4, S9. Sample every 10s, average over 30s.
4. **sig-8** (in-guest CPU%) — covers S1, S3 specifically. More expensive (per-tick ssh) but precise.
5. **sig-10** (in-guest busy file) — opt-in, for guest workloads that want to be explicit. Needed for S6 (a cron-aware agent could write busy before its job and remove after).

The sig-2/3/4/5 group costs nothing because splited is already the proxy and the daemon — it sees those events directly. Start there. Layer the host-side polls (sig-6, sig-7) next. In-guest polls (sig-8, sig-10) only if needed.

**In plain English:** This is the list of clues we could watch to figure out whether a splite is busy. Some are free (we already see them — every API call, every WS frame). Some cost a little (peeking at the host's network traffic stats every 10s). Some cost more (ssh'ing into the guest to check CPU usage). Some require the workload to cooperate (an agent writing a "busy" file when it starts work). We start with the free ones and add cheap host-side ones; we only reach into the guest if the cheaper signals don't cover what we need.

## Decision rules

The watchdog's job each tick: combine signals → pick a tier action.

```
For each running splite:
  If ANY of {sig-2, sig-3, sig-4, sig-5} active right now → STAY HOT
  Else if last activity within hot_window (default 5 min) → STAY HOT
  Else if last activity within warm_window (default 1 hour) → DROP TO WARM
  Else → DROP TO COLD

  Override: if sig-6 (ssh sessions > 0) → STAY HOT (ssh users expect immediate)
  Override: if sig-10 (busy file) present → STAY HOT
  Override: if sig-7 > N bytes/sec windowed → STAY HOT (work is happening)
  Override: if record.auto_sleep_seconds === null → STAY HOT (per-splite never-sleep)
```

`hot_window`, `warm_window`, and the sig-7 threshold all need calibration from the benchmarks in A.1.3.c.

**"Last activity"** is the max of all touch sources: API touch, proxy frame, exec frame, sig-7 last sustained activity.

**In plain English:** Every 30 seconds, the watchdog walks each splite and asks: "is something happening right now? was something happening recently?" If yes, the splite stays running (hot). If recently-but-not-now, it drops to warm. If nothing's happened in an hour, it goes cold. There are some "always stay running" overrides — like an active ssh session, or pete being explicitly pinned to never-sleep.

## Mid-job safety

Before any tier-down (running → warm or running → cold), splited runs a final guard:

- In-flight proxy requests > 0 → block, retry next tick
- Open WS proxy sessions > 0 → block
- Open WS exec sessions > 0 → block
- Active sshd sessions > 0 → block
- sig-7 above noise floor in last 5s → block

This is belt-and-suspenders on top of the decision rules. A scenario that slips through the rules (e.g. sig-8 polling missed a CPU burst) gets caught by the guard.

**In plain English:** Right before pulling the plug, the watchdog does one last "wait, is anything actually open right now?" check. If yes — open ssh, in-flight HTTP request, recent network activity — it bails out and tries again in 30 seconds. Defense in depth so that a single missed signal doesn't kill a live job.

## Finish detection

Companion to mid-job safety: when a workload finishes, downshift immediately rather than waiting `hot_window`.

Heuristics for "just finished":
- Last open inbound TCP closed AND CPU dropped below idle threshold within 5s
- All ssh sessions disconnected
- Busy file removed (explicit signal)

When detected: skip the hot_window timer, drop to warm now. The user sees no difference (next request rewakes), but RAM is freed earlier.

**In plain English:** The flip side of mid-job safety. If we can clearly see the work just finished — last connection closed, CPU went quiet, ssh user logged out — we don't need to wait the full 5 minutes before sleeping. Drop to warm immediately. The user never notices because the next request wakes it back up just as fast.

## Lume + Virtualization.framework

Apple's Virtualization.framework supports:

- **Pause/resume** for hot tier: `VZVirtualMachine.pause` / `.resume`. Memory stays in RAM.
- **Save/restore** for warm tier: `VZVirtualMachine.saveMachineState(to:)` / `.restoreMachineState(from:)`. Memory dumps to a state file. Available macOS 14+.

### Discovery (A.1.3.b, 2026-05-06)

Lume's source has been read. The findings:

**Hot tier (pause/resume) — implementable with a small patch.**

`vendor/lume/src/Virtualization/VMVirtualizationService.swift:93-119` already implements `pause()` and `resume()` against `VZVirtualMachine.pause` / `.resume`. The Swift code works today. What's missing:

- **No HTTP endpoints exposing it.** Lume's REST surface (`vendor/lume/src/Server/Server.swift:200-388`) routes: list, get, delete, create, clone, run, stop, setup, ipsw, pull, prune, images, config, logs, push, host/status. No `/pause` or `/resume`.
- **No CLI commands.** `vendor/lume/src/Commands/` has Stop.swift, Run.swift, but no Pause.swift or Resume.swift.
- **No `LumeController` orchestration.** The methods exist on `VMVirtualizationService` (the per-VM Swift service) but nothing in `LumeController.swift` (the user-facing orchestrator) calls them.

**Warm tier (save/restore) — needs deeper work.**

`vendor/lume/src/` contains zero references to `saveMachineState`, `restoreMachineState`, `saveState(to:)`, or any persistent-VM-state code path. The VZ APIs are available (macOS 14+) but lume hasn't wrapped them at any layer.

**Cold tier — already works.** `lume stop` does this today.

### What the patch needs to add

Two patches in `vendor/lume.patches/`:

1. **`hot-tier.patch`** — Expose existing pause/resume.
   - Add `pause(name:)` and `resume(name:)` to `LumeController.swift`, calling the existing `VMVirtualizationService.pause()` / `.resume()`.
   - Add `POST /lume/vms/:name/pause` and `POST /lume/vms/:name/resume` to `Server/Server.swift` + `Server/Handlers.swift`.
   - Add `Pause.swift` and `Resume.swift` CLI commands (mirror the existing Stop.swift pattern).
   - Estimated diff: ~150 lines across 4 Swift files.

2. **`warm-tier.patch`** — Build save/restore from scratch.
   - Add `saveState(to:)` and `restoreState(from:)` to `VMVirtualizationService.swift`, wrapping `VZVirtualMachine.saveMachineState(to:)` / `.restoreMachineState(from:)`.
   - Add orchestration in `LumeController` that handles the lifecycle: pause first, save state, then exit the VM process. On restore: load from state file, resume.
   - Add HTTP + CLI surface for `save` and `restore` (or extend `stop --warm`).
   - The state file goes alongside the existing `disk.img` in the bundle dir (e.g. `vmstate.bin`).
   - Estimated diff: ~300 lines.

These get applied during the build via `scripts/build-lume.sh` (already the convention from MVP Phase 1).

### Splited-side wiring

Once patches are in:

- `engine/lume.ts` (the daemon's lume client) gains `pause(name)`, `resume(name)`, `save(name)`, `restore(name)`.
- `lib/lifecycle.ts` exports `pauseSplite`, `resumeSplite`, `saveStateSplite`, `restoreStateSplite`.
- The watchdog from A.1.1.c picks tier based on idle duration + activity signals (A.1.3.f).

### Lume's process model — the SharedVM cache problem

A subtle but load-bearing finding from A.1.3.e/f:

**Lume's `pause`/`resume` (and prospective `save`/`restore`) only work on VMs that lume serve itself launched.** lume serve maintains an in-memory `SharedVM` cache holding the live `VZVirtualMachine` reference for each running VM. Pause/resume need that reference. If splited spawns `lume run <n>` as a separate subprocess, the VM lives in THAT subprocess — not in lume serve. lume serve's cache is empty for it. Pause/resume return `Virtual machine not running` even though the VM is up.

Two integration paths:

**(a) Switch splited's startSplite to lume serve's HTTP `/lume/vms/{n}/run` endpoint.** This is the documented "right way" — VM ends up in lume serve's cache, pause/resume just work. The first attempt failed and we wrongly diagnosed it as a "long-poll" issue. The actual reading from lume's source: `handleRunVM` is fire-and-forget (returns 202 immediately, dispatches the VM start in `Task.detached`). The poll path was fine. The real failure (A.1.3.f.1, 2026-05-06) is **the entitlement gap** below.

**(b) Run lume serve from the same process that owns the VM.** Bigger architectural change: instead of splited supervising lume serve as a child + speaking HTTP, splited could embed lume's Swift runtime directly. Or — more realistic — splited stays in TypeScript but uses a thin Swift "lume worker" process per VM that lume serve registers with. Pete's prior cells/sprites context and the way Fly does this is probably similar.

### The entitlement gap (A.1.3.f.1, 2026-05-06)

Captured lume serve's stderr (it had been silently `/dev/null`'d in `engine/lumeProcess.ts`) and got the real error:

```
ERROR: Failed in VM.run name=pete errorType=NSError
error=Invalid virtual machine configuration. The process doesn't have the
"com.apple.security.virtualization" entitlement.
```

Why `lume run` (subprocess path) works and `lume serve` HTTP doesn't is the same source binary in both cases, but with a wrinkle: **the shell `lume` resolves to `~/.local/bin/lume`, which is a wrapper script that execs `~/.local/share/lume/lume.app/Contents/MacOS/lume`** — upstream's notarized, Developer-ID-signed, provisioning-profile-bearing binary. Our `bin/lume` (built via `scripts/build-lume.sh`) is the same source code with our hot patches, but adhoc-signed only. macOS treats `com.apple.security.virtualization` as a restricted entitlement: even if the binary carries the entitlement file, the kernel rejects it unless the binary is signed by an Apple-issued Developer ID **and** has a matching `embedded.provisionprofile`. Adhoc signing alone fails — verified by signing into a `.app` bundle and still hitting the same error.

Path forward (tracked in `docs/BLOCKED.md`):
- Pete has an Apple Developer account.
- Need a Developer ID Application certificate + provisioning profile authorizing the entitlement on a splites-owned bundle ID.
- `scripts/build-lume.sh` updates to build a `.app` bundle and sign with the real cert (mirror upstream's `scripts/build/build-release.sh`).
- Until then: hot tier (and any future warm-tier patch) is implemented in code but can't be live-tested. Cold tier (the existing `lume run` subprocess path) works because it goes through the entitled upstream binary.

**In plain English:** When splites starts a VM by running `lume run` as a separate command, that command secretly runs Apple's official lume binary — which has special permission to start virtual machines. Our patched-and-rebuilt copy of lume doesn't have that permission yet, because Apple only grants it through a developer signing certificate. So our patches *exist*, the daemon *talks* to them, but when the daemon asks lume to actually start a VM, macOS says no. Pete has the developer account we need; getting the certificate set up is a one-time chore that unblocks the whole hot/warm tier story.

**In plain English:** Good news on hot tier: macOS already supports pause/unpause, and lume's Swift code already calls those APIs — they just aren't reachable from the outside. Adding ~150 lines of glue code (HTTP route + CLI command + orchestrator method) makes them reachable. So hot tier is real-doable. Bad news on warm tier: save-VM-to-disk-then-restart isn't anywhere in lume yet, even at the Swift level. We'd need to write that wrapper from scratch using Apple's API. ~300 lines, more work but bounded — the underlying macOS feature is there. Cold tier already works (it's the existing stop).

## Implementation roadmap

Each fire ticks one sub-box. Sequence:

1. **A.1.3.a** *(this doc)* — scenario + signal framework. ✓
2. **A.1.3.b** — discovery: VZ docs + lume source read. Output: "lume can do X today; warm needs Y patch."
3. **A.1.3.c** — benchmark cold→running, warm→running, hot→running. RAM cost per hot. Disk cost per warm-state file. Numbers go in this doc.
4. **A.1.3.d** — activity-detection prototype: wire sig-6, sig-7, sig-8 (or whichever subset benchmarks suggest). Validate against scenarios S1–S9.
5. **A.1.3.e** — lume patch (if needed for warm tier).
6. **A.1.3.f** — wire tiers into splited: `stopSplite(name, {tier})`, watchdog tier selection, `splite info` surfaces tier.
7. **A.1.3.g** — scenario coverage smoke: each S1–S9 in this doc tested live.

Tunable defaults that this doc holds (filled in as benchmarks land):

| Knob | Today | After A.1.3.c | Notes |
|---|---|---|---|
| `auto_sleep_seconds` (idle threshold) | 60 | TBD (likely smaller with smart detection) | Phase A.1.1 default |
| `hot_window` (running → warm) | n/a | target 5 min | drops if RAM pressured |
| `warm_window` (warm → cold) | n/a | target 1 hour | |
| `sig-7 threshold` (bytes/sec to count as activity) | n/a | TBD | calibrate to ignore lume's own keepalive |
| `sig-8 threshold` (CPU% to count as busy) | n/a | TBD | likely 5–10% |

**In plain English:** Seven steps, one per loop fire. This doc was step 1 — figuring out what we're solving. Step 2 reads lume's code. Step 3 measures actual hot/warm/cold timing on the Mac Mini. Step 4 builds the busy-detector. Steps 5-6 wire it all in. Step 7 runs the scenarios live to prove they work. Total: roughly 7 fires (~14 hours of loop time) until the tier system is real.

## Open questions

Re-evaluate after each sub-phase:

1. ~~Does lume's HTTP API expose pause/resume/saveState/restoreState directly? If yes, we patch nothing.~~ **Answered (A.1.3.b, 2026-05-06).** No. Hot tier needs a small (~150 line) patch to expose existing Swift pause/resume; warm tier needs a larger (~300 line) patch implementing saveState/restoreState from scratch. Both go in `vendor/lume.patches/`. See § Discovery above.
2. **What's the actual cost of a hot splite (RAM)?** A.1.3.c measures. Determines how many we can keep hot.
3. **What's the actual wake-from-warm time on M-series?** A.1.3.c measures. If >2s, "warm" loses its appeal vs. cold.
4. **Do we need an in-guest agent for sig-10 (busy file), or do host-side signals cover everything?** A.1.3.d validates against scenarios.
5. **Does sprites use a separate edge layer (CF Worker) for the wake polish, or do they wake at the daemon?** Probably both, but our daemon-side wake is sufficient for parity. (Captured in `~/.claude/.../splites_worker_layer.md`.)

**In plain English:** Five things we don't know yet. (1) Does lume already do what we need? (2) How much RAM does a paused VM actually take? (3) Is wake-from-warm really 1s on Apple silicon, or slower? (4) Can we get away without asking the splite to cooperate? (5) How does sprites do this in their cloud setup? Each fire chips away at one or more of these.

## Cross-references

- Phase A.1 lives in `docs/MVP-PLAN.md`.
- Watchdog implementation: `lib/watchdog.ts`, `lib/idle.ts`.
- Wake-on-demand: `lib/wake.ts`.
- Lume engine wrapper: `engine/lume.ts`, `engine/lumeProcess.ts`.
- Memory notes: `~/.claude/projects/-Users-pete-Projects-splites/memory/splites_activity_detection.md`, `splites_tier_strategy.md`.
