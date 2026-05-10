# splites — Current Status

**Updated:** 2026-05-10 04:30 UTC by `pete-session` (initial seed; subsequent updates by `steward`)
**Phase:** Phase A in flight. A.1 fully shipped (pre-warmed pool, sub-3s create); A.2 R2 partially shipped (client + push/pull wired; GC + round-trip smoke open).
**Health:** 🟢 Cells team unblocked. WS proxy 1011 fix promoted to `wells-stable-2026-05-10a` 04:22 UTC. 493 tests green. No active blockers.

## TL;DR

WS proxy 1011 fix shipped + promoted; cells team `cells talk` repro should now succeed without modification. Pete Loop infrastructure live on `feature/phase-a`. Worker queue ordered by Pete's three priorities: close out A.2 R2 polish (GC + smoke), then image library on R2 (proposal first), then lume `@MainActor` variance.

## What changed since last steward fire

(Initial state — first steward fire happens after the worker has accumulated some entries.)

- Cells team WS proxy 1011 fix shipped: `lib/proxy.ts:buildUpstreamWsInit` forwards client headers + subprotocols to upstream WS. Verified by 17 unit + e2e tests + `scripts/smoke-vhost-ws-proxy.ts` end-to-end smoke (7/7 checks).
- Promoted to stable: `wells-stable-2026-05-10a` (commit `3477980`). Stable welld restarted, healthy.
- `docs/cells-integration.md` updated with Promotions row + Stable-bump section.
- Pete Loop infrastructure created (`.claude/loops/`, `.claude/hooks/`, `.claude/commands/`, `BOARD.md`, `JOURNAL.md`).
- Setup guide drafted at `~/Desktop/pete-loop-setup-guide.md` + `docs/setting-up-pete-loop.md`.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| _(none)_ |  |  |

## Pete needs to decide

_(none right now — `NEEDS_PETE.md` is absent)_

## Cells team status

**Unblocked** as of 2026-05-10 04:22 UTC. Their `cells talk` repro should now succeed against `wells-stable-2026-05-10a`. Forward-message drafted on Pete's clipboard for him to send when he's ready. Cloud-path 1002 bug (separate from 1011) remains open — diagnosed in the forward-message as their CF Worker side, with curl diagnostic to split Worker vs cloudflared.

## Next planned cycle

Worker picks `W.1` (A.2 R2 GC tracks local retention). Should land in 1-2 fires.
