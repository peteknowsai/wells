# Cooperation — the off-switch

The substrate that lets cells turn themselves off the moment the agent finishes a turn. From the agent's perspective, it's always on; in reality the host hibernates the VM during every gap between turns and wakes it transparently when traffic arrives. Hibernate dumps RAM to disk (~1-3s); wake reads it back (~1s); agent state (model context, conversation memory, in-flight reasoning) is preserved bit-perfectly because hibernate is `VZVirtualMachine.saveMachineState(to:)` and wake is `restoreMachineState(from:)` — every byte of RAM round-trips through `hibernate.bin`.

**Status:** shipped (off-switch + pi extension). 2026-05-07. **Updated 2026-05-11:** semantics flipped from pause-based to hibernate-based per Pete's B.0.7 contract — sleep means hibernate, not pause; the substrate guarantee cells team relies on is RAM release, not just CPU release.

## The contract

One verb. The off-switch.

```
POST http://host.well:7879/v1/cells/me/sleep      "Turn me off."
```

The harness's hook fires it on `agent_end` — a deterministic state-machine transition that means "the LLM has stopped generating, all tool calls have completed, the turn is closed." No agent introspection. No judgment. Hook fires, cell turns off, done.

(There's also a `/v1/cells/me/working` endpoint in welld's surface for "don't auto-pause me, I'm working" overrides. It's optional — the off-switch alone is enough for cooperative cells, since the cell is *already* paused before the watchdog could ever decide to pause it on idleness.)

A cell calls them from inside its own VM. Welld identifies the caller by source IP via reverse DHCP lookup. No Bearer auth — the network is the trust boundary; only vmnet-leased cells can reach the metadata server.

`host.well` is a stable hostname seeded into `/etc/hosts` at first boot by `well-firstboot.service` (cloud-init was purged from `ubuntu-25.10-base` in B.0.9.d.4 — see `docs/MVP-PLAN.html` § B.0.9.d.4), pointing at the vmnet gateway IP. Cells never have to know an IP, never have to discover a port — the contract is "POST to host.well:7879."

## Who calls what

| Caller | Calls | Why |
|---|---|---|
| Agent harness (e.g. pi) hook | `/sleep` | On `agent_end` — turn over, cell off. |
| User CLI | `/sleep` | Explicit "turn this cell off now" command. |
| (rare) harness hook | `/working` | Optional override if the harness has a long-blocking phase that would falsely look idle to the watchdog. Cooperative cells almost never need it because they fire `/sleep` immediately at agent_end and there's nothing for the watchdog to pause. |

**Welld never validates whether the call "makes sense."** If the cell says `/sleep`, welld pauses. Validation isn't needed because `agent_end` is a deterministic harness state-machine transition: by the time it fires, the LLM has stopped generating, all tool calls have completed, the turn is closed. The harness has already decided; welld just acts.

## Behavior on the welld side

`/working`:
- `markWorking(name)` — adds the cell to welld's busy set
- Watchdog respects busy as a hard "don't pause" override, regardless of touch time, activity probes, or auto-sleep thresholds
- Returns `{ok: true, name, state: "working"}` immediately

`/sleep`:
- `markIdle(name)` — clears the busy flag
- `queueMicrotask(transitionWell(name, "hibernate", ...))` — defers the actual hibernate so the response can flush before the VM's RAM is dumped (the response goes through the same vmnet bridge that's about to halt)
- Returns `{ok: true, name, state: "hibernating"}` synchronously
- Hibernate happens within milliseconds of the response — RAM written to `~/.wells/vms/<name>/hibernate.bin`, then memory released

When a hibernating cell receives any inbound traffic (proxy, exec, ssh-via-tunnel), `ensureRunning` reads `runtime.json`, sees `state: "hibernating"`, and triggers `wakeWell` (`lib/lifecycle.ts:wakeWell`) — typically ~1-3s end-to-end. Agent state survives intact because the saveState/restoreState round-trip is bit-identical for the guest.

## Trust model

Source-IP validation against DHCP leases is the single trust mechanism in v1.

- Welld's metadata server binds only to the vmnet bridge IP (`192.168.64.1:7879` typically). Not 0.0.0.0; not loopback.
- Each request's source IP must match an active DHCP lease in `/var/db/dhcpd_leases`.
- The matching lease's `name` field becomes the cell identity.
- No Bearer token, no shared secret — both would be brittle without a clean place to store the secret inside the cell.

This is enough for single-tenant Pete's-Mac scenarios. For multi-tenant Colony deployment later, add per-cell tokens.

## The pi extension

`extensions/pi/well-cooperate/` is the canonical reference. Whole extension:

```typescript
export default function (pi: any) {
  pi.on("agent_end", async () => {
    await fetch("http://host.well:7879/v1/cells/me/sleep", { method: "POST" });
  });
}
```

That's it. Pi's `agent_end` fires when the agent has fully finished a turn — LLM done, tool calls done. The hook fires `/sleep`, the cell pauses. Drop into `.pi/extensions/` on any cell.

The agent never sees this hook fire. From its perspective, time is continuous and it's always on. The fact that it's actually paused 99% of the time is invisible to it.

Live-smoked end-to-end inside `pete-well` 2026-05-07: extension loaded, fired `agent_end` → welld logged `cell self-paused` and the VM actually paused (verified by ssh hanging during the pause window). Resume on next traffic was sub-second.

## Why this shape — design conversation

The two-verb API is deliberately minimal. We talked through several alternatives before landing here.

### Why not three states?

Earlier sketch had `/working`, `/idle`, and `/sleep-now`. The middle `/idle` state was "I'm done, but please pause me whenever — not necessarily right now." Pete's pushback was correct: there's no actual reason for the agent to want that delay. If the agent knows it's done, just pause. If another turn is imminent, keep `/working` set. Two-verb API drops `/idle` entirely.

### Why not a metadata-server-on-loopback with bearer token?

Considered routing cell traffic through welld's existing `127.0.0.1:7878` API with a per-cell token baked at create time. Pros: one server, standard auth. Cons: the cell can't reach loopback from inside the VM; we'd need to bind on `0.0.0.0` (broader exposure) and store a secret in each cell (lifecycle complexity). The bridge-IP-only metadata server is a smaller surface with simpler trust.

### Why not have welld validate "did the agent really mean it?"

Tempting to have welld refuse `/sleep` if it looks like the agent was mid-tool-call. But welld has no view into the agent's state machine — no access to the conversation log, the tool-call queue, or the LLM's reasoning chain. The harness HAS that view. Validation belongs there. Three reasonable safety-net layouts, none in welld:

1. **In the hook** (deterministic, cheapest). The agent's `agent_end` handler checks the harness's own state — pending tool call? incomplete response? — and refuses to call `/sleep` if anything looks unclean. Milliseconds, no LLM call, perfect knowledge of agent state.
2. **In a tiny model** (slow but smart). Send the last N tokens to a small model with "did this look like a clean stop?" 100-300ms; useful when the harness state isn't easily inspectable.
3. **Post-hoc reviewer agent** (safety net). A separate agent walks paused cells periodically, reviews their last log entry, and if a pause looks accidental, sends a wake signal. Catches what the hook misses; the cell's already paused so the only cost is delayed wake.

Pete's call: ship the simple version, add validation later if/when accidents actually happen. Trust the agent.

### Why doesn't welld handle scheduled wakes (`wake-at(time)`)?

Cells already has the `pulse` agent (`docs/pulse.md` in the cells repo) — a print-mode pi that runs every 60s under launchd, reads each cell's `HEARTBEAT.md`, and fires wake-ups via `cells talk`. Pulse owns scheduling and judgment. Welld owns mechanism. Subjective wake ("only wake me if a reviewer agent says yes") is just pulse running a sub-agent decision before firing the wake; welld never knows.

Anything that *would* generate a wake — an alarm, a webhook, a message, another agent's decision — only needs to **send traffic to the cell**. Inbound traffic auto-resumes the cell via `ensureRunning`. Wake is a *consequence* of traffic, not a separate welld primitive.

## Layered vocabulary

The agent's full lifecycle vocabulary, viewed across layers:

| What the agent wants | Where it goes |
|---|---|
| "Pause me when I'm done with this turn" | welld `/sleep` |
| "Don't pause me, I'm waiting on a tool call" | welld `/working` |
| "Pause me right now" | welld `/sleep` |
| "Wake me at 2pm" | cells `HEARTBEAT.md` → pulse fires `cells talk` |
| "Wake me when this PR merges" | cells HEARTBEAT subscribed to event → pulse → traffic |
| "Wake me only if a reviewer says yes" | pulse runs the reviewer agent → traffic if approved |
| "Never wake me again, I'm done" | `well destroy` (with checkpoint to come back) |

Welld surface stays small and orthogonal. The richer vocabulary composes from `welld primitives + pulse scheduling + cells-level judgment`.

## Defaults — current and where they're going

Today, `auto_sleep_seconds` defaults to **60** in `defaults.json`. That's a 60-second outside-in safety blanket: if the watchdog sees no activity for 60s, it pauses the cell.

With cooperative signaling, the practical floor is much lower. A cell that signals `/working` reliably at the start of every turn doesn't need a 60s blanket — the busy flag itself is the safety. Default could drop to 5s, 2s, even 1s once we have empirical confidence agents are signaling correctly.

**That tuning is deferred** until the cells/wells integration phase (see "What's deferred" below). Until cells deploys to wells, wells cells don't have pi pre-configured, so the cooperative signaling isn't reliable enough to drop the default aggressively.

## What's deferred (to cells/wells integration)

The pi-with-real-LLM load testing isn't done yet. The smoke we ran inside pete used a mock event emitter, not a real pi session, because pete-well doesn't have:

- An LLM provider configured (no `defaultProvider`, no `defaultModel`)
- A token (no `CELLS_PROXY_SECRET` or equivalent)
- The cells DNA's pi extensions (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`)

All of this comes for free once cells deploys *to* wells. Cells already has the pi config + secrets + extensions plumbing for sprites. The cells/wells integration phase replaces sprites' API endpoint with welld's API endpoint; the pi-side config is unchanged.

So the work that's blocked on integration:

1. **Real-pi load test.** Spin up N wells running real pi, give each a task, watch welld's logs for clean working/sleep cycles.
2. **Default tuning.** Once we have empirical data, drop `auto_sleep_seconds` from 60s to whatever's safe with cooperative signaling.
3. **Per-cell credential plumbing.** Whatever cells uses to inject `CELLS_PROXY_SECRET` into a sprite's environment, mirror it for wells.
4. **Multi-cell concurrency stress.** Verify the cooperation API stays correct when N cells are simultaneously toggling working/sleep.

These are not welld-side problems to solve in isolation. They land naturally as part of the cells/wells integration.

## What's done independent of integration

- Two-verb API on welld's metadata server, source-IP authenticated, live-tested
- Pi extension reference implementation
- `host.well` /etc/hosts entry seeded by `well-firstboot.service` for new wells (cloud-init was purged in B.0.9.d.4; firstboot owns identity injection now)
- Watchdog respects `/working` as a hard "don't pause" override
- Auto-resume on inbound traffic to a paused cell

That's enough to deploy cells onto wells once the integration phase begins; the cooperation API is ready to be exercised.

## Cross-references

- `docs/lifecycle.md` — alive/hibernating/frozen state vocabulary
- `extensions/pi/well-cooperate/` — pi extension implementation
- `daemon/welld.ts` — metadata server, watchdog, ensureRunning paths
- `lib/cellState.ts` — busy state tracker
- `lib/dhcp.ts` `findWellByIp` — reverse lookup for source-IP identification
- `templates/well-firstboot.sh` — `host.well` /etc/hosts seed (formerly cloud-init-well.yaml)
- `docs/pulse.md` (in cells repo) — the scheduling layer that handles wake-at and event-driven wake

---

**In plain English:** Cells inside a VM tell welld "I'm doing something" before they start working and "I'm done" when they finish. Welld believes them and pauses or doesn't pause accordingly. The agent-harness's hooks (in pi: `agent_start` and `agent_end`) call those endpoints automatically — the agent author drops in a 5-line extension and gets aggressive pause-on-idle for free. Real-world testing with real LLMs is parked until the broader cells/wells integration phase begins, because that's where the pi configuration and credentials come from.
