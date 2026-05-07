# Cooperation — how cells signal their busy/idle state to splited

The substrate that lets splited's watchdog be aggressive about pausing without breaking agents mid-thought. Cells inside a VM signal their own state via a tiny HTTP API; splited treats those signals as ground truth and acts accordingly.

**Status:** shipped (working/sleep verbs + pi extension). 2026-05-07.

## The contract

Two verbs. That's it.

```
POST http://host.splite:7879/v1/cells/me/working    "I'm doing something — don't pause me"
POST http://host.splite:7879/v1/cells/me/sleep      "I'm done — pause me now"
```

A cell calls them from inside its own VM. Splited identifies the caller by source IP via reverse DHCP lookup. No Bearer auth — the network is the trust boundary; only vmnet-leased cells can reach the metadata server.

`host.splite` is a stable hostname seeded into `/etc/hosts` at first boot via cloud-init, pointing at the vmnet gateway IP. Cells never have to know an IP, never have to discover a port — the contract is "POST to host.splite:7879."

## Who calls what

| Caller | Calls | Why |
|---|---|---|
| Agent harness (e.g. pi) hook | `/working` | Before starting a turn / tool call. Prevents the watchdog from pausing mid-thought. |
| Agent harness hook | `/sleep` | After the turn ends. Pauses immediately rather than waiting for the watchdog's idle threshold. |
| User CLI / future Pi tool | `/sleep` | Explicit "I'm done with this cell, pause it" command. |

**Splited never validates whether the call "makes sense."** If the cell says `/working`, splited believes it. If the cell says `/sleep`, splited pauses. Validation (e.g. "did the agent really mean to sleep, or was it mid-thought?") belongs in the hook layer or a post-hoc reviewer agent — not in splited's primitives.

## Behavior on the splited side

`/working`:
- `markWorking(name)` — adds the cell to splited's busy set
- Watchdog respects busy as a hard "don't pause" override, regardless of touch time, activity probes, or auto-sleep thresholds
- Returns `{ok: true, name, state: "working"}` immediately

`/sleep`:
- `markIdle(name)` — clears the busy flag
- `queueMicrotask(pause)` — defers the actual pause so the response can flush before the VM freezes (the response goes through the same vmnet bridge that's about to halt)
- Returns `{ok: true, name, state: "sleeping"}` synchronously
- Watchdog takes over from there: pause happens within milliseconds of the response

When a paused cell receives any inbound traffic (proxy, exec, ssh-via-tunnel), `ensureRunning` auto-resumes via `resumeSplite` — sub-second from the agent's perspective, agent state preserved exactly (frozen-mid-instruction in RAM).

## Trust model

Source-IP validation against DHCP leases is the single trust mechanism in v1.

- Splited's metadata server binds only to the vmnet bridge IP (`192.168.64.1:7879` typically). Not 0.0.0.0; not loopback.
- Each request's source IP must match an active DHCP lease in `/var/db/dhcpd_leases`.
- The matching lease's `name` field becomes the cell identity.
- No Bearer token, no shared secret — both would be brittle without a clean place to store the secret inside the cell.

This is enough for single-tenant Pete's-Mac scenarios. For multi-tenant Colony deployment later, add per-cell tokens.

## The pi extension

`extensions/pi/splite-cooperate/index.ts` is the canonical reference integration. Two events, two HTTP calls:

```typescript
pi.on("agent_start", async () => signal("working"));
pi.on("agent_end",   async () => signal("sleep"));
```

That's the whole extension (apart from error handling and an environment-variable override for the metadata URL). Pi's `agent_start` fires when the LLM begins processing a user prompt; `agent_end` fires when the agent completes its work. Both map cleanly to our two verbs.

Drop the extension into `~/.pi/agent/extensions/splite-cooperate/` on any cell that runs pi. No SDK to install, no harness coupling — just an event handler that POSTs to splited.

Live-smoked end-to-end inside `pete-splite` 2026-05-07: extension loaded, fired `agent_start` → splited logged `cell signaled working`, fired `agent_end` → splited logged `cell self-paused` and the VM actually paused (verified by ssh hanging during the pause window).

## Why this shape — design conversation

The two-verb API is deliberately minimal. We talked through several alternatives before landing here.

### Why not three states?

Earlier sketch had `/working`, `/idle`, and `/sleep-now`. The middle `/idle` state was "I'm done, but please pause me whenever — not necessarily right now." Pete's pushback was correct: there's no actual reason for the agent to want that delay. If the agent knows it's done, just pause. If another turn is imminent, keep `/working` set. Two-verb API drops `/idle` entirely.

### Why not a metadata-server-on-loopback with bearer token?

Considered routing cell traffic through splited's existing `127.0.0.1:7878` API with a per-cell token baked at create time. Pros: one server, standard auth. Cons: the cell can't reach loopback from inside the VM; we'd need to bind on `0.0.0.0` (broader exposure) and store a secret in each cell (lifecycle complexity). The bridge-IP-only metadata server is a smaller surface with simpler trust.

### Why not have splited validate "did the agent really mean it?"

Tempting to have splited refuse `/sleep` if it looks like the agent was mid-tool-call. But splited has no view into the agent's state machine — no access to the conversation log, the tool-call queue, or the LLM's reasoning chain. The harness HAS that view. Validation belongs there. Three reasonable safety-net layouts, none in splited:

1. **In the hook** (deterministic, cheapest). The agent's `agent_end` handler checks the harness's own state — pending tool call? incomplete response? — and refuses to call `/sleep` if anything looks unclean. Milliseconds, no LLM call, perfect knowledge of agent state.
2. **In a tiny model** (slow but smart). Send the last N tokens to a small model with "did this look like a clean stop?" 100-300ms; useful when the harness state isn't easily inspectable.
3. **Post-hoc reviewer agent** (safety net). A separate agent walks paused cells periodically, reviews their last log entry, and if a pause looks accidental, sends a wake signal. Catches what the hook misses; the cell's already paused so the only cost is delayed wake.

Pete's call: ship the simple version, add validation later if/when accidents actually happen. Trust the agent.

### Why doesn't splited handle scheduled wakes (`wake-at(time)`)?

Cells already has the `pulse` agent (`docs/pulse.md` in the cells repo) — a print-mode pi that runs every 60s under launchd, reads each cell's `HEARTBEAT.md`, and fires wake-ups via `cells talk`. Pulse owns scheduling and judgment. Splited owns mechanism. Subjective wake ("only wake me if a reviewer agent says yes") is just pulse running a sub-agent decision before firing the wake; splited never knows.

Anything that *would* generate a wake — an alarm, a webhook, a message, another agent's decision — only needs to **send traffic to the cell**. Inbound traffic auto-resumes the cell via `ensureRunning`. Wake is a *consequence* of traffic, not a separate splited primitive.

## Layered vocabulary

The agent's full lifecycle vocabulary, viewed across layers:

| What the agent wants | Where it goes |
|---|---|
| "Pause me when I'm done with this turn" | splited `/sleep` |
| "Don't pause me, I'm waiting on a tool call" | splited `/working` |
| "Pause me right now" | splited `/sleep` |
| "Wake me at 2pm" | cells `HEARTBEAT.md` → pulse fires `cells talk` |
| "Wake me when this PR merges" | cells HEARTBEAT subscribed to event → pulse → traffic |
| "Wake me only if a reviewer says yes" | pulse runs the reviewer agent → traffic if approved |
| "Never wake me again, I'm done" | `splite destroy` (with checkpoint to come back) |

Splited surface stays small and orthogonal. The richer vocabulary composes from `splited primitives + pulse scheduling + cells-level judgment`.

## Defaults — current and where they're going

Today, `auto_sleep_seconds` defaults to **60** in `defaults.json`. That's a 60-second outside-in safety blanket: if the watchdog sees no activity for 60s, it pauses the cell.

With cooperative signaling, the practical floor is much lower. A cell that signals `/working` reliably at the start of every turn doesn't need a 60s blanket — the busy flag itself is the safety. Default could drop to 5s, 2s, even 1s once we have empirical confidence agents are signaling correctly.

**That tuning is deferred** until the cells/splites integration phase (see "What's deferred" below). Until cells deploys to splites, splites cells don't have pi pre-configured, so the cooperative signaling isn't reliable enough to drop the default aggressively.

## What's deferred (to cells/splites integration)

The pi-with-real-LLM load testing isn't done yet. The smoke we ran inside pete used a mock event emitter, not a real pi session, because pete-splite doesn't have:

- An LLM provider configured (no `defaultProvider`, no `defaultModel`)
- A token (no `CELLS_PROXY_SECRET` or equivalent)
- The cells DNA's pi extensions (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`)

All of this comes for free once cells deploys *to* splites. Cells already has the pi config + secrets + extensions plumbing for sprites. The cells/splites integration phase replaces sprites' API endpoint with splited's API endpoint; the pi-side config is unchanged.

So the work that's blocked on integration:

1. **Real-pi load test.** Spin up N splites running real pi, give each a task, watch splited's logs for clean working/sleep cycles.
2. **Default tuning.** Once we have empirical data, drop `auto_sleep_seconds` from 60s to whatever's safe with cooperative signaling.
3. **Per-cell credential plumbing.** Whatever cells uses to inject `CELLS_PROXY_SECRET` into a sprite's environment, mirror it for splites.
4. **Multi-cell concurrency stress.** Verify the cooperation API stays correct when N cells are simultaneously toggling working/sleep.

These are not splited-side problems to solve in isolation. They land naturally as part of the cells/splites integration.

## What's done independent of integration

- Two-verb API on splited's metadata server, source-IP authenticated, live-tested
- Pi extension reference implementation
- `host.splite` /etc/hosts entry seeded by cloud-init for new splites
- Watchdog respects `/working` as a hard "don't pause" override
- Auto-resume on inbound traffic to a paused cell

That's enough to deploy cells onto splites once the integration phase begins; the cooperation API is ready to be exercised.

## Cross-references

- `docs/lifecycle.md` — alive/hibernating/frozen state vocabulary
- `extensions/pi/splite-cooperate/` — pi extension implementation
- `daemon/splited.ts` — metadata server, watchdog, ensureRunning paths
- `lib/cellState.ts` — busy state tracker
- `lib/dhcp.ts` `findSpliteByIp` — reverse lookup for source-IP identification
- `templates/cloud-init-splite.yaml` — `host.splite` /etc/hosts seed
- `docs/pulse.md` (in cells repo) — the scheduling layer that handles wake-at and event-driven wake

---

**In plain English:** Cells inside a VM tell splited "I'm doing something" before they start working and "I'm done" when they finish. Splited believes them and pauses or doesn't pause accordingly. The agent-harness's hooks (in pi: `agent_start` and `agent_end`) call those endpoints automatically — the agent author drops in a 5-line extension and gets aggressive pause-on-idle for free. Real-world testing with real LLMs is parked until the broader cells/splites integration phase begins, because that's where the pi configuration and credentials come from.
