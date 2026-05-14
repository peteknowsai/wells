# State tiers — design notes

> **⚠ Superseded 2026-05-07.** The simplified canonical model now lives in [`docs/lifecycle.md`](lifecycle.md): two states (Alive, Hibernating) plus a future Frozen tier (R2 offload). The three-tier hot/warm/cold framing in this doc was the original investigation; it's preserved for archaeology and to keep the activity-detection / signals catalogue still useful. Read `lifecycle.md` for the current architecture; come back here for the deeper analysis of *what we considered and why we collapsed it.*
>
> Why we collapsed: pause-in-RAM is sub-second to resume and preserves the agent's working memory exactly (model context, in-flight tokens, open sockets). With owned hardware where disk is cheap, "cold" (= stopped, no preserved RAM image) costs you the agent's mental state to save disk that wasn't scarce. Pete's call: drop cold from the active vocabulary, treat hibernation (saved RAM on disk) as the universal sleep state, reserve "cold" semantics for a future Frozen tier that offloads hibernated state to R2.

The substrate that lets wells be aggressive about idle without breaking the user. The three-tier framing below (cold, warm, hot) plus an activity-detection layer pre-dates the simplification — useful as design archaeology and for the still-applicable signals catalogue.

## Why this matters

Phase A.1.1 ships an autosleep watchdog. Phase A.1.2 ships wake-on-demand. Together they make a well act ephemeral: idle for 60s → stopped → traffic comes in → started. But two problems with that v1:

1. **The 60s threshold is wasted time.** When work finishes, the well has nothing to do. Why wait 60s? A finer "are we actually busy" signal lets us downshift immediately.
2. **The "touch on API call" model is too coarse.** Real activity often doesn't hit the API:
   - In-guest compile / build / install
   - Interactive ssh session held open
   - In-guest agent (Pi, Claude Code) talking to outside services
   - Background TCP service holding inbound connections
   - Long-running exec command
   - Mid-flight HTTP response or file transfer

   With v1 only, the watchdog could stop a well mid-job. That's worse than not having autosleep.

The tier model + activity detection answers both: stop earlier when truly idle, never stop when busy.

**In plain English:** Right now, a well goes to sleep after 60 seconds of no API hits. That's a problem in two ways. (1) Sometimes the well is *actually* busy — it's running a build, or someone's ssh'd in, or an agent is working — but doesn't happen to be hitting our API. We'd kill it mid-job. (2) Sometimes the well is genuinely done with its work, but we make it wait the full 60 seconds before sleeping. Both are fixable with a smarter "is this thing busy" detector and a richer set of sleep depths than just "running" and "stopped."

## Tiers

| Tier | RAM cost | Disk cost (beyond disk.img) | Wake cost |
|---|---|---|---|
| **Hot** (pause) | full VM allocation (default 1GB) | 0 | 2ms pause / ~6.5s resume (single sample, see § Benchmarks) |
| **Warm** (hibernate) | **0** | `hibernate.bin` ≈ 28% of allocated RAM (~280MB for 1GB well) | hibernate p95 201ms / wake p95 829ms / ssh-after-wake p95 1147ms |
| **Cold** (stop+start) | 0 | 0 | ~4–6s pure boot (full create from cloud-image p95 17.4s) |

The critical thing: **warm uses zero RAM.** The memory has been dumped to disk and the VM process has exited. When you wake it, the file is read back. Disk space is the only ongoing cost.

### Sizing for the 300-cell scenario

A realistic cells-on-wells fleet: ~300 cells, only 5–10 concurrent at any moment. The tier defaults should target this shape:

| Population | Tier | RAM cost (1GB/well) | Disk cost (~280MB hibernate.bin/well) |
|---|---|---|---|
| 5–10 active right now | hot | 5–10 GB | 0 |
| ~50 recently-used | warm | 0 | ~14 GB |
| 240+ long tail | cold | 0 | 0 |
| **Total** | — | **5–10 GB RAM** | **~14 GB disk** |

This works comfortably on a 64GB Mac Mini (RAM headroom for the host + apps). Disk pressure is also much lighter than originally estimated — VZ's saved-state format is sparse, so `hibernate.bin` runs ~28% of allocated RAM (measured 2026-05-12 across live pool eggs). The original estimate assumed ≈ RAM size; benchmarks landed it at ~280MB per 1GB-allocated well, so the warm population could grow well past 50 before disk becomes a real constraint.

**Wake-from-hot** is the user-experience target for the 5–10 active cells. They tap, it's there.

**Wake-from-warm** is the workhorse for the long tail of 50 recently-used cells. ~1s is acceptable.

**Wake-from-cold** is fine for the 240+ archival cells. ~5s once a day or once a week is unnoticeable.

The watchdog (A.1.1.c, already shipped) only knows "running → cold." Adding tiers is A.1.3.

**In plain English:** Three sleep depths instead of one. **Hot** is like closing the laptop lid — the VM is paused but its memory stays in RAM. Wake is instant. Costs RAM. **Warm** is like hibernating to SSD — the VM's memory dumps to a file on disk, the VM exits, the file gets read back on wake. ~1 second wake. **Costs zero RAM** — just disk space (a few GB per well). **Cold** is full power-off. ~5 seconds to boot back up. Costs nothing extra. For a 300-cell setup where only 5-10 are concurrent: 5-10 stay hot (using ~30GB RAM), maybe 50 stay warm (using ~200GB disk for fast wake), and the rest sleep cold. Warm is where most wells live at scale — RAM headroom isn't the constraint, disk is.

## Scenarios — "in the middle of something"

Every scenario below must NOT trigger a sleep, even if the API touch timestamp is stale. Each row maps to one or more signals from the catalogue below.

| # | Scenario | Example | Failure mode if missed |
|---|---|---|---|
| S1 | Long-running build/compile | `cargo build --release` (5 min) | build dies, user re-runs |
| S2 | Interactive ssh session | dev typing in `well console` | connection drops, lost edit |
| S3 | In-guest agent loop | Claude Code making LLM calls outbound | agent killed mid-conversation, lost context |
| S4 | Background TCP service | webhook receiver, chat bot daemon | clients disconnect, reconnect storm |
| S5 | Multi-step orchestration | cells's bridge sending bursts of agent messages | session torn down between turns |
| S6 | Scheduled job approaching | cron job due in 30s | job misses its window |
| S7 | In-flight HTTP request | LLM streaming response, large file upload | client disconnected mid-response |
| S8 | WebSocket session | cells's persistent `/agent` WS | session torn down |
| S9 | File transfer mid-flight | `tar c \| well exec -- tar xz` | transfer interrupted |
| S10 | Quiet idle (truly nothing) | well booted, sshd listening, no work | (this IS the sleep candidate) |

S1–S9 must trigger a "stay awake" decision. S10 must trigger "go warm." The activity-detection layer is what tells these apart.

**In plain English:** This is the list of "don't kill me, I'm working" cases we have to handle. A 5-minute compile shouldn't die because no API call hit welld. An ssh session shouldn't drop while you're typing. A Claude agent loop shouldn't get terminated mid-thought. Each row is a real failure if we get it wrong. Only S10 (genuinely doing nothing) is fair game for sleep.

## Signals catalogue

Each signal has a cost (how expensive to sample), granularity (live vs. snapshot vs. windowed), and reach (which scenarios it covers).

| # | Signal | Source | Cost | Granularity | Covers |
|---|---|---|---|---|---|
| sig-1 | Authed API touch | welld (already wired in A.1.1.a) | free | per-request | inbound to welld |
| sig-2 | Proxy HTTP request in-flight | welld tracks open fetch promises | free | live | S7 |
| sig-3 | Proxy WS frame within last 5s | welld touches on every frame (A.1.1.a) | free | live | S5, S8 |
| sig-4 | Active inbound exec (HTTP or WS) | welld's open subprocesses + open WS sessions | free | live | exec scenarios |
| sig-5 | Active outbound WS session in proxy bridge | welld's WS proxy session map | free | live | S5, S8 |
| sig-6 | TCP connections to guest:22 (ssh) | host-side `lsof -iTCP:22 -sTCP:ESTABLISHED` | low (poll) | snapshot | S2, also surfaces well exec since it's ssh |
| sig-7 | Tap interface bytes/sec | host-side `netstat -I bridge100 -b` (or analogous) | low (poll) | windowed | S1, S3, S4, S9 (anything pushing bytes) |
| sig-8 | In-guest CPU% | ssh + `awk` over `/proc/stat` | medium (ssh poll) | windowed | S1, S3 |
| sig-9 | In-guest active sshd sessions | ssh + `who \| wc -l` | medium (ssh poll) | snapshot | S2 (overlaps sig-6) |
| sig-10 | In-guest "I'm busy" file | guest writes `/var/run/well-busy`, welld polls via ssh | low (ssh poll) | explicit | any scenario where the workload cooperates |
| sig-11 | In-guest systemd unit state | ssh + `systemctl is-active --state=running` | medium (ssh poll) | snapshot | S4, S6 |
| sig-12 | Pending scheduled jobs | ssh + `systemd-analyze timers` or cron next-run query | medium | snapshot | S6 |

**Signal selection — what we'll actually wire:**

A.1.3.d (prototype) implements the smallest set that covers most scenarios. Order of likely value:

1. **sig-2, sig-3, sig-4, sig-5** (already in welld; free) — covers all proxy and exec scenarios (S5, S7, S8, exec).
2. **sig-6** (host-side ssh connection count) — covers S2 directly. Cheap. No guest cooperation needed.
3. **sig-7** (tap bytes/sec) — broad coverage of S1, S3, S4, S9. Sample every 10s, average over 30s.
4. **sig-8** (in-guest CPU%) — covers S1, S3 specifically. More expensive (per-tick ssh) but precise.
5. **sig-10** (in-guest busy file) — opt-in, for guest workloads that want to be explicit. Needed for S6 (a cron-aware agent could write busy before its job and remove after).

The sig-2/3/4/5 group costs nothing because welld is already the proxy and the daemon — it sees those events directly. Start there. Layer the host-side polls (sig-6, sig-7) next. In-guest polls (sig-8, sig-10) only if needed.

**In plain English:** This is the list of clues we could watch to figure out whether a well is busy. Some are free (we already see them — every API call, every WS frame). Some cost a little (peeking at the host's network traffic stats every 10s). Some cost more (ssh'ing into the guest to check CPU usage). Some require the workload to cooperate (an agent writing a "busy" file when it starts work). We start with the free ones and add cheap host-side ones; we only reach into the guest if the cheaper signals don't cover what we need.

## Decision rules

The watchdog's job each tick: combine signals → pick a tier action.

```
For each running well:
  If ANY of {sig-2, sig-3, sig-4, sig-5} active right now → STAY HOT
  Else if last activity within hot_window (default 5 min) → STAY HOT
  Else if last activity within warm_window (default 1 hour) → DROP TO WARM
  Else → DROP TO COLD

  Override: if sig-6 (ssh sessions > 0) → STAY HOT (ssh users expect immediate)
  Override: if sig-10 (busy file) present → STAY HOT
  Override: if sig-7 > N bytes/sec windowed → STAY HOT (work is happening)
  Override: if record.auto_sleep_seconds === null → STAY HOT (per-well never-sleep)
```

`hot_window`, `warm_window`, and the sig-7 threshold all need calibration from the benchmarks in A.1.3.c.

**"Last activity"** is the max of all touch sources: API touch, proxy frame, exec frame, sig-7 last sustained activity.

**In plain English:** Every 30 seconds, the watchdog walks each well and asks: "is something happening right now? was something happening recently?" If yes, the well stays running (hot). If recently-but-not-now, it drops to warm. If nothing's happened in an hour, it goes cold. There are some "always stay running" overrides — like an active ssh session, or pete being explicitly pinned to never-sleep.

## Mid-job safety

Before any tier-down (running → warm or running → cold), welld runs a final guard:

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

`engine/vwell-src/src/Virtualization/VMVirtualizationService.swift:93-119` already implements `pause()` and `resume()` against `VZVirtualMachine.pause` / `.resume`. The Swift code works today. What's missing:

- **No HTTP endpoints exposing it.** Lume's REST surface (`engine/vwell-src/src/Server/Server.swift:200-388`) routes: list, get, delete, create, clone, run, stop, setup, ipsw, pull, prune, images, config, logs, push, host/status. No `/pause` or `/resume`.
- **No CLI commands.** `engine/vwell-src/src/Commands/` has Stop.swift, Run.swift, but no Pause.swift or Resume.swift.
- **No `LumeController` orchestration.** The methods exist on `VMVirtualizationService` (the per-VM Swift service) but nothing in `LumeController.swift` (the user-facing orchestrator) calls them.

**Warm tier (save/restore) — needs deeper work.**

`engine/vwell-src/src/` contains zero references to `saveMachineState`, `restoreMachineState`, `saveState(to:)`, or any persistent-VM-state code path. The VZ APIs are available (macOS 14+) but lume hasn't wrapped them at any layer.

**Cold tier — already works.** `lume stop` does this today.

### What the patch needs to add

Two patches in `engine/vwell-src/ (formerly patched separately under vendor/lume.patches/swift/)`:

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

These get applied during the build via `scripts/build-vwell.sh` (already the convention from MVP Phase 1).

### Welld-side wiring

Once patches are in:

- `engine/vwell.ts` (the daemon's lume client) gains `pause(name)`, `resume(name)`, `save(name)`, `restore(name)`.
- `lib/lifecycle.ts` exports `pauseWell`, `resumeWell`, `saveStateWell`, `restoreStateWell`.
- The watchdog from A.1.1.c picks tier based on idle duration + activity signals (A.1.3.f).

### Lume's process model — the SharedVM cache problem

A subtle but load-bearing finding from A.1.3.e/f:

**Lume's `pause`/`resume` (and prospective `save`/`restore`) only work on VMs that lume serve itself launched.** lume serve maintains an in-memory `SharedVM` cache holding the live `VZVirtualMachine` reference for each running VM. Pause/resume need that reference. If welld spawns `lume run <n>` as a separate subprocess, the VM lives in THAT subprocess — not in lume serve. lume serve's cache is empty for it. Pause/resume return `Virtual machine not running` even though the VM is up.

Two integration paths:

**(a) Switch welld's startWell to lume serve's HTTP `/lume/vms/{n}/run` endpoint.** This is the documented "right way" — VM ends up in lume serve's cache, pause/resume just work. The first attempt failed and we wrongly diagnosed it as a "long-poll" issue. The actual reading from lume's source: `handleRunVM` is fire-and-forget (returns 202 immediately, dispatches the VM start in `Task.detached`). The poll path was fine. The real failure (A.1.3.f.1, 2026-05-06) is **the entitlement gap** below.

**(b) Run lume serve from the same process that owns the VM.** Bigger architectural change: instead of welld supervising lume serve as a child + speaking HTTP, welld could embed lume's Swift runtime directly. Or — more realistic — welld stays in TypeScript but uses a thin Swift "lume worker" process per VM that lume serve registers with. Pete's prior cells/sprites context and the way Fly does this is probably similar.

### The entitlement gap (A.1.3.f.1, 2026-05-06)

Captured lume serve's stderr (it had been silently `/dev/null`'d in `engine/lumeProcess.ts`) and got the real error:

```
ERROR: Failed in VM.run name=pete errorType=NSError
error=Invalid virtual machine configuration. The process doesn't have the
"com.apple.security.virtualization" entitlement.
```

Why `lume run` (subprocess path) works and `lume serve` HTTP doesn't is the same source binary in both cases, but with a wrinkle: **the shell `lume` resolves to `~/.local/bin/lume`, which is a wrapper script that execs `~/.local/share/lume/lume.app/Contents/MacOS/lume`** — upstream's notarized, Developer-ID-signed, provisioning-profile-bearing binary. Our `bin/vwell` (built via `scripts/build-vwell.sh`) is the same source code with our hot patches, but adhoc-signed only. macOS treats `com.apple.security.virtualization` as a restricted entitlement: even if the binary carries the entitlement file, the kernel rejects it unless the binary is signed by an Apple-issued Developer ID **and** has a matching `embedded.provisionprofile`. Adhoc signing alone fails — verified by signing into a `.app` bundle and still hitting the same error.

Path forward (tracked in `docs/BLOCKED.md`):
- Pete has an Apple Developer account.
- Need a Developer ID Application certificate + provisioning profile authorizing the entitlement on a wells-owned bundle ID.
- `scripts/build-vwell.sh` updates to build a `.app` bundle and sign with the real cert (mirror upstream's `scripts/build/build-release.sh`).
- Until then: hot tier (and any future warm-tier patch) is implemented in code but can't be live-tested. Cold tier (the existing `lume run` subprocess path) works because it goes through the entitled upstream binary.

**In plain English:** When wells starts a VM by running `lume run` as a separate command, that command secretly runs Apple's official lume binary — which has special permission to start virtual machines. Our patched-and-rebuilt copy of lume doesn't have that permission yet, because Apple only grants it through a developer signing certificate. So our patches *exist*, the daemon *talks* to them, but when the daemon asks lume to actually start a VM, macOS says no. Pete has the developer account we need; getting the certificate set up is a one-time chore that unblocks the whole hot/warm tier story.

**In plain English:** Good news on hot tier: macOS already supports pause/unpause, and lume's Swift code already calls those APIs — they just aren't reachable from the outside. Adding ~150 lines of glue code (HTTP route + CLI command + orchestrator method) makes them reachable. So hot tier is real-doable. Bad news on warm tier: save-VM-to-disk-then-restart isn't anywhere in lume yet, even at the Swift level. We'd need to write that wrapper from scratch using Apple's API. ~300 lines, more work but bounded — the underlying macOS feature is there. Cold tier already works (it's the existing stop).

## Benchmarks (A.1.3.c, landed 2026-05-12)

The numbers below are pulled from production findings docs that accumulated through the A.1.3.e/f sub-boxes — there was no separate benchmark fire. Sources cited inline so future tier work can re-measure or extend.

### Wake-cost distributions

**Warm tier — hibernate / wake (saveState / restoreState).** Source: [`findings-wake-stress-2026-05-10.md`](findings-wake-stress-2026-05-10.md), 30 cycles on dev welld :7879 post-W.27, single well, steady-state Ubuntu 25.10.

| phase | min | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| hibernate (saveState) | 191ms | 193ms | **201ms** | 217ms | 217ms |
| wake (restoreState) | 818ms | 826ms | **829ms** | 831ms | 831ms |
| ssh-after-wake | 1128ms | 1143ms | **1147ms** | 1210ms | 1210ms |

Tight distribution (max-wake within 2ms of p95). Confirms the original ~1s wake-from-warm target and the "warm doesn't lose appeal vs. cold" question from § Open questions.

**Hot tier — pause / resume.** Source: A.1.3.f.1 live-smoke 2026-05-07 (single sample, see [`MVP-PLAN.md`](MVP-PLAN.md) § A.1.3.f.1). No distribution captured because hot tier got superseded by hibernate-on-idle (B.0.7 contract) before wider benchmarking — pause/resume remain operator-only primitives.

| phase | sample |
|---|---|
| pause | **2ms** |
| resume | **~6.5s** (anomalous vs. VZ's expected sub-second; one-shot measurement on a heavily-loaded session host) |
| ssh-after-resume | 100ms |

**Cold tier — full create from cloud-image.** Source: [`findings-create-warm-distribution-2026-05-10.md`](findings-create-warm-distribution-2026-05-10.md), 125 samples across two weeks of production traffic. This is end-to-end `well create --from-image` (includes warming sequence), not just `stop → start` on an existing well — the latter is roughly `lumeStart2 + dhcp2 + ssh2` ≈ 4–6s on a clean substrate.

| metric | p50 | p95 | p99 |
|---|---|---|---|
| total (create + warm) | 14.16s | **17.4s** | 82.7s |
| diskReleased (post-halt fsync) | 3.85s | 4.54s | 10.3s |
| dhcp2 (post-warm boot) | 4.00s | 4.01s | 34.0s |
| ssh2 (post-warm SSH ready) | 1.29s | 1.86s | 2.07s |

The long p99/max tail (~83s) tracks vmnet DHCP contention (W.13 found the ceiling at 4 concurrent forks). Steady-state p95 of 17.4s is dominated by `diskReleased` and the two DHCP waits.

**Thaw — multi-VM from one hibernated bundle.** Source: [`findings-thaw.md`](findings-thaw.md), single-host concurrent thaw experiment 2026-05-10. Not a tier in the original framing — it's a derived primitive: thaw materializes N running clones from one `hibernate.bin` + clonefile'd disk.img.

| phase | sample |
|---|---|
| per-thaw wall-clock | **~481ms** (clonefile disk + small file copies + restoreState) |
| concurrent ceiling | N=2 verified; serialized through `lib/thaw.ts` module-level promise chain (VZ's `restoreState` ceiling is 1) |

### Resource cost per tier

**Hot — RAM cost.** Allocated VM memory stays resident (default 1GB per well; configurable per `lib/defaults.ts:48`). VZ's pause doesn't free pages. Population ceiling = host RAM ÷ per-well allocation, minus host headroom.

**Warm — `hibernate.bin` size.** Measured 2026-05-12 across live pool eggs (1GB-allocated):

| well | hibernate.bin |
|---|---|
| egg-a1ba58 | 280M |
| egg-c0ecdf | 280M |
| egg-c27c8a | 272M |

→ ~28% of allocated RAM. VZ writes a sparse format that compresses unused pages aggressively. The original estimate (state file ≈ RAM size) was conservative by ~3.5×.

**Cold — disk cost.** Zero beyond `disk.img` (~50GB sparse rootfs). Existing storage, no incremental cost.

### What changed since A.1.3.a

The original framework called for `hot_window`, `warm_window`, and signal thresholds calibrated from these benchmarks. Two of those tunables got absorbed by architectural changes:

- **The three-tier model collapsed to two (Alive + Hibernating) on 2026-05-07.** Hot tier remained as an operator primitive but never became watchdog-driven; the contract is now "watchdog hibernates on idle, traffic resumes via wake-on-demand" (B.0.7). `hot_window` and `warm_window` are no longer used — `auto_sleep_seconds` (default 60s) is the single knob.
- **Activity-detection prototype landed (A.1.3.d) with sig-6 only.** Host-side `lsof` for ESTABLISHED ssh — the cheapest sufficient signal. sig-7 (tap bytes/sec) and sig-8 (in-guest CPU%) were deferred; six months in, sig-6 has covered every observed scenario.

### Open questions resolved

The five questions from § Open questions land thus:

1. ✅ **Does lume's HTTP API expose pause/resume/saveState/restoreState directly?** No — required ~150-line hot-tier patch (A.1.3.b) and ~300-line warm-tier patch (A.1.3.e.2). Both shipped.
2. ✅ **What's the actual cost of a hot well (RAM)?** Full allocation (1GB default). No reduction from VZ's pause.
3. ✅ **What's the actual wake-from-warm time on M-series?** 829ms p95. Comfortably under the 2s threshold for warm-vs-cold appeal.
4. ✅ **Do we need an in-guest agent for sig-10 (busy file)?** No. Host-side sig-6 + welld's own proxy-touch coverage has been sufficient.
5. **Does sprites use a separate edge layer for wake polish?** Architectural — captured in memory `splites_worker_layer.md`. Wells's daemon-side wake is sufficient for sprites-parity today.

**In plain English:** The numbers we cared about all measure in: hibernate is ~200ms, wake from hibernate is ~830ms, ssh-after-wake adds another 300ms or so. Cold boot is ~5 seconds. The hibernate file on disk is only ~280MB for a 1GB-allocated well, not the full 1GB we feared — VZ writes a sparse format. So the disk pressure of keeping lots of warm wells is much lighter than originally planned. Hot-tier (pause-in-RAM) ended up being unused — the warm tier is fast enough that we never needed it for the watchdog.

## Implementation roadmap

Each fire ticks one sub-box. Sequence:

1. **A.1.3.a** *(this doc)* — scenario + signal framework. ✓
2. **A.1.3.b** — discovery: VZ docs + lume source read. ✓ — `vendor/lume.patches/swift/` design (now in-tree at `engine/vwell-src/`).
3. **A.1.3.c** — benchmark cold→running, warm→running, hot→running. RAM cost per hot. Disk cost per warm-state file. ✓ — see § Benchmarks above.
4. **A.1.3.d** — activity-detection prototype: wire sig-6 (sig-7/8 deferred). ✓ — `lib/activity.ts`.
5. **A.1.3.e** — lume patch. ✓ — hot tier (e.1) + warm/hibernate tier (e.2) shipped.
6. **A.1.3.f** — wire tiers into welld. ✓ — auto-hibernate on idle, wake-on-traffic, `well info` surfaces state.
7. **A.1.3.g** — scenario coverage smoke: S1–S10 tested live. *In progress — Phase 3 of road-to-1.0.*

## Open questions

Re-evaluate after each sub-phase:

1. ~~Does lume's HTTP API expose pause/resume/saveState/restoreState directly? If yes, we patch nothing.~~ **Answered (A.1.3.b, 2026-05-06).** No. Hot tier needs a small (~150 line) patch to expose existing Swift pause/resume; warm tier needs a larger (~300 line) patch implementing saveState/restoreState from scratch. Both go in `engine/vwell-src/ (formerly patched separately under vendor/lume.patches/swift/)`. See § Discovery above.
2. **What's the actual cost of a hot well (RAM)?** A.1.3.c measures. Determines how many we can keep hot.
3. **What's the actual wake-from-warm time on M-series?** A.1.3.c measures. If >2s, "warm" loses its appeal vs. cold.
4. **Do we need an in-guest agent for sig-10 (busy file), or do host-side signals cover everything?** A.1.3.d validates against scenarios.
5. **Does sprites use a separate edge layer (CF Worker) for the wake polish, or do they wake at the daemon?** Probably both, but our daemon-side wake is sufficient for parity. (Captured in `~/.claude/.../wells_worker_layer.md`.)

**In plain English:** Five things we don't know yet. (1) Does lume already do what we need? (2) How much RAM does a paused VM actually take? (3) Is wake-from-warm really 1s on Apple silicon, or slower? (4) Can we get away without asking the well to cooperate? (5) How does sprites do this in their cloud setup? Each fire chips away at one or more of these.

## Cross-references

- Phase A.1 lives in `docs/MVP-PLAN.md`.
- Watchdog implementation: `lib/watchdog.ts`, `lib/idle.ts`.
- Wake-on-demand: `lib/wake.ts`.
- Lume engine wrapper: `engine/vwell.ts`, `engine/lumeProcess.ts`.
- Memory notes: `~/.claude/projects/-Users-pete-Projects-wells/memory/wells_activity_detection.md`, `wells_tier_strategy.md`.
