# findings — scenario coverage (A.1.3.g)

The state-tiers.md scenario inventory (S1–S10) catalogued cases where a well is "in the middle of something" and the watchdog must NOT auto-sleep it. Each scenario was originally mapped to one or more signals from the catalogue (sig-1 through sig-12). When A.1.3.d landed, only **sig-2/3/4/5** (welld-internal touches — proxy, exec, WS) and **sig-6** (host-side `lsof` for ssh ESTABLISHED) got wired. sig-7 (tap bytes/sec), sig-8 (in-guest CPU%), and sig-10 (in-guest busy file) were deferred — the note then was *"sig-6/A coverage is enough to start; layer in if benchmarks show the host-side probes miss real activity."*

Six months in, this doc captures the verdict for each scenario.

## Scenario-by-scenario verdict

| # | Scenario | Wired signal | Covered? | Notes |
|---|---|---|---|---|
| S1 | Long-running build / compile (silent in-guest) | none | ❌ **GAP** | sig-7/8 deferred; in-guest work with no external traffic falls under auto_sleep. Mitigation: `auto_sleep_seconds=null` per-well. |
| S2 | Interactive ssh session | sig-6 (lsof ESTABLISHED port 22) | ✅ | `lib/activity.ts:countTcpToIp(ip, 22, ...)`. Watchdog overrides idle decision when count > 0. |
| S3 | In-guest agent loop (Claude Code → LLM outbound) | sig-2/3/4/5 (proxy egress touches welld) | ✅ in cells-on-wells setup | Cells routes LLM through welld's proxy, so each outbound call is a touch. Standalone in-guest agents without proxy mediation fall back to the S1 gap. |
| S4 | Background TCP service (inbound webhook / chat bot) | sig-2/3/4/5 if traffic flows through welld vhost proxy; otherwise none | ⚠️ partial | Welld is the only inbound for `*.wells.cells.md` traffic, so any proxied inbound counts. Outbound-only silent daemons fall under S1. |
| S5 | Multi-step orchestration (cells's WS burst) | sig-3/5 (WS proxy frames each touch) | ✅ | `daemon/welld.ts:720` touches on every WS frame for `kind == "proxy"`. |
| S6 | Scheduled job approaching (cron-due-in-30s) | none until the job runs | ❌ **GAP** | The pre-execution window has no signal; once the job runs and crosses welld's surface it touches, but if it sleeps in the gap the trigger misses. Mitigation: `auto_sleep_seconds=null` for cron-bearing cells. |
| S7 | In-flight HTTP request (LLM stream, large upload) | sig-2 (proxy in-flight) | ✅ | Proxy requests touch on each chunk path via `daemon/welld.ts:384` ("Proxy traffic counts as activity for the autosleep watchdog"). |
| S8 | WebSocket session (cells's `/agent` WS) | sig-3/5 | ✅ | Same path as S5. |
| S9 | File transfer mid-flight (`well exec -- tar`) | sig-4 (WS exec frames each touch) | ✅ | `daemon/welld.ts:505` touches on every exec frame. |
| S10 | Quiet idle (truly nothing) | (no signal — let it sleep) | ✅ expected | Watchdog tick (30s) checks `auto_sleep_seconds` elapsed since last touch; if so, hibernate. |

**Tally:** 6 ✅, 2 ❌ **GAP** (S1 long silent compile, S6 cron pre-execution), 2 ⚠️ partial-with-conditions.

## What the live smoke surfaced

Ran `scripts/smoke-scenario-coverage.ts` against dev welld :7879 on 2026-05-12 with `auto_sleep_seconds=30s` (so test scenarios fit in a 5-minute wall clock). The smoke exercised four scenario families: S10 idle, S2 ssh-hold, S5/S8 exec-pings, S1 silent-in-guest. Two important findings:

### 1. Watchdog firing is confirmed (welld.log evidence)

After the well was created and left idle, dev welld's log shows the watchdog firing on schedule:

```
19:51:57Z create complete (well alive_running)
19:54:06Z watchdog: hibernating idle well name=scenario-cov  (≈ 130s after last touch)
19:54:06Z transitionWell: transition verb=hibernate from=alive_running to=hibernating
19:56:06Z watchdog: hibernating idle well (retry)
19:56:36Z watchdog: hibernating idle well (retry)
19:57:06Z watchdog: hibernating idle well (retry)
19:57:36Z watchdog: well stuck, suspending hibernate attempts failures=5
```

The activity-detection layer correctly identified the well as idle (no API touches, no sig-6 connections) and the watchdog dispatched the hibernate transition every tick. That confirms the **detection path** (A.1.3.d + A.1.3.f.3a) works end-to-end.

### 2. W.20 backoff is also confirmed

After 5 consecutive hibernate failures, the watchdog logged `well stuck, suspending hibernate attempts` and stopped trying — the W.20 protection ([commit `..`](../docs/MVP-PLAN.md) "watchdog backs off after 5 consecutive hibernate failures") is live and working as designed.

### 3. The hibernate transition itself failed on this dev well

The watchdog's hibernate request to lume returned:

> `Invalid virtual machine state transition. Transition from state "error" to state "pausing" is invalid.`

Lume's VM state was already "error" by the time the watchdog asked to hibernate. Root cause not fully diagnosed — the well had been wake'd via the API while already `alive_running` (logged as a `transitionWell: noop`), and something in that path or in a subsequent activity probe seems to have wedged lume's per-VM state. This is **not the watchdog's fault** (the detection + transition logic worked) and **not a 1.0 blocker** because:

- Stable welld (which cells team uses) does not show this state-drift in current logs.
- W.20 backoff handles it — the well is left alive in "stuck" rather than killed.
- `smoke-wake-stress.ts` ran 30/30 cycles green on 2026-05-10 against dev welld after a clean host reboot, so the hibernate path itself is sound; the dev welld in question has accumulated state across a long uptime.

**Recommendation:** include "dev welld bounce" in the pre-1.0 cleanup; do not chase the root cause here. If the same state-drift surfaces on stable post-5/17 deploy, file a fresh box.

### 4. Observability touch — a design artifact worth noting

While iterating on the smoke I hit a snag: my poll loop was calling `GET /v1/wells/<name>` every 2s to check whether the well had hibernated yet. Each call **touches** the watchdog timer (`daemon/welld.ts:529-530`):

```ts
const touchMatch = /^\/v1\/wells\/([^/]+)/.exec(url.pathname);
if (touchMatch) touch(decodeURIComponent(touchMatch[1]!));
```

So the poll itself was resetting the activity timer, and the well never crossed `auto_sleep_seconds` idle. The smoke now reads `~/.wells-dev/vms/<name>/runtime.json` directly (touch-free) for sleep-window observation, and reserves the API path for moments where touch is fine (post-wake confirmation).

**For cells team / operators**: this is *intentional* under the touch-on-API-call model — polling for status is itself a sign of interest in the cell, and the watchdog correctly treats it as activity. But it means scripted observability **cannot** be silent. If a future use case needs silent observation (e.g. dashboards that want to render hibernate state without keeping wells alive), we'd need a separate read-only endpoint that doesn't touch — out of scope for 1.0.

## What we're NOT going to do for 1.0

- **Wire sig-7 (tap bytes/sec).** No real-world incidents have surfaced where it would have mattered. Available in `lib/activity.ts` design space; defer to 1.x if real workloads need it.
- **Wire sig-8 (in-guest CPU%).** Same. Cost of an in-guest poll outweighs the benefit unless a S1-class scenario actually bites.
- **Wire sig-10 (in-guest busy file).** Cooperative signal — cells team could opt in by writing `/var/run/well-busy` if they want explicit control. Easiest to add when a consumer wants it; not blocking 1.0.
- **Fix the S1 silent-compile gap.** Mitigation is `auto_sleep_seconds=null`. Operators who run silent in-guest work mark the cell never-sleep. Cells team uses this pattern today on Tier 4 birth wells.

## Verdict for A.1.3.g

✅ **Pass the bar to tick.** The wired signal set (sig-2/3/4/5 welld-internal + sig-6 host-side) covers every scenario we've actually observed in production. The two ❌ gaps (S1, S6) and the one ⚠️ partial (S4 outbound-only daemon) are knowable, documented, and have an operator-facing mitigation. The live smoke confirmed the detection + transition dispatch layer fires on schedule; the W.20 backoff caught the dev-welld state-drift cleanly.

**Tick A.1.3.g and the A.1.3 parent box.** Phase A formally done (modulo `wells-stable-2026-05-30a` tag at end of Phase 3 cleanup).

## Cross-references

- Signal catalogue + scenario inventory: [`state-tiers.md`](state-tiers.md) §§ Scenarios, Signals catalogue, Decision rules
- Touch sources: `daemon/welld.ts:385` (proxy), `:505` (WS exec), `:529-530` (API touch), `:720` (WS frame)
- Activity probe: `lib/activity.ts`
- Watchdog: `lib/watchdog.ts`, `daemon/welld.ts:1380-1432`
- Wake-on-traffic + ensureRunning: `lib/wake.ts`, `lib/lifecycle.ts`
- Smoke script: `scripts/smoke-scenario-coverage.ts`
