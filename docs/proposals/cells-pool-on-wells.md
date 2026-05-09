# Hand-off: cells pool / eggs on wells

**To:** cells team
**From:** wells team
**Date:** 2026-05-09
**Status:** Wells hibernate/wake is verified production-ready. Cells's existing pool/eggs primitives translate directly. This document is the integration spec.

---

## What just landed on wells

Hibernate/wake works end-to-end. Verified empirically across 10 cycles (`scripts/verify-press-release.ts`):

| Metric                | min     | p50     | p95     | p99     | max     |
|-----------------------|---------|---------|---------|---------|---------|
| Hibernate (RAM → disk)| 186ms   | **188ms** | 189ms   | 189ms   | 196ms   |
| Wake (disk → ready)   | 832ms   | **842ms** | 846ms   | 846ms   | 874ms   |
| SSH-after-wake        | 1129ms  | 1140ms  | 1145ms  | 1145ms  | 1170ms  |

A backgrounded process started before the cycles (`nohup sleep 99999`) survives every hibernate→wake with the same PID. **This isn't reboot-from-disk** — Apple's `saveStateTo` / `restoreMachineStateFrom` actually freezes and restores kernel state.

What this means for cells:
- A cell can be hibernated when idle and consume **zero RAM**, then wake on first traffic in <1s
- In-flight CPU/process state is preserved. Open file descriptors, pipes, kernel timers, all alive after wake
- TCP sockets to *external* services (LLM APIs etc.) probably die during hibernation (remote times out), but local-process state is intact — the agent just reconnects on next call

---

## Pool / eggs translation

Sprites already has the eggs concept: pre-frozen agent images that hatch into a running cell on demand, giving `cells init` a sub-second feel from the user's first touch. The same pattern fits wells with one tweak — wells's hibernation primitive is identical in shape (saveState file + bundle disk + identity injection), so eggs map cleanly.

**Suggested architecture:**

```
   ┌─────────────────────────────────────┐
   │  ~/.wells/eggs/                     │
   │    └── claude-code-default/         │  ← egg = base bundle + warm hibernate.bin
   │         ├── disk.img                │
   │         ├── nvram.bin
   │         ├── config.json
   │         └── hibernate.bin           │  ← saved memory state of a fully-warmed cell
   │
   │  ~/.wells/pool/                     │
   │    ├── pool-001/  (warm, in-RAM)    │  ← N pre-hatched cells, identity not yet applied
   │    ├── pool-002/  (warm, in-RAM)    │
   │    └── pool-003/  (hibernated)      │
   └─────────────────────────────────────┘

   `cells birth my-agent` →
     1. Pop pool-001 from pool registry
     2. Re-cidata with my-agent's identity (hostname, ssh keys, env)
     3. (If hibernated) wake from hibernate.bin via wells's existing wake path
     4. Inject identity via well-firstboot.service
     5. Hand back as my-agent — sub-2-second from API call to ready
   Pool refills async in background (hatch a new one from the egg).
```

**Key insight from the wells side:** `well-firstboot.service` runs once per VM (gated by `/etc/.well-ready`). For pool adoption, we'd reset that marker before re-applying cidata so identity injection runs again on the new identity. This is a small wells-side change (`scripts/reset-firstboot.sh` or a `POST /v1/wells/{n}/reset-identity` endpoint) — let me know if you need it and we'll ship it.

---

## Optimizations cells should pursue

These all live in cells, not wells. We've verified the wells primitives support them.

### 1. **In-RAM pool tier** (always-warm)

Keep K cells (default 1-2) booted and idle in RAM, never hibernated. Pool member adoption = identity reset only, no wake step. Should be sub-500ms. Costs ~50-100MB RAM per pooled cell — worth it for the magic feel on first user interaction.

Wells primitive used: just lume.start with mount=null (steady-state boot). Already works.

### 2. **Hibernated pool tier** (cold-but-fast)

Pool members hibernated to disk. Adoption = wake (842ms p50) + identity reset. Sub-1.5s adoption. No RAM cost while idle.

Wells primitive used: hibernate.bin per-egg + per-pool-member. Wake path already verified.

### 3. **Egg = saved-state image** (the "init magic")

At `cells init` time, hatch K pool members from a single egg's `hibernate.bin`. **One saved-state image, multiple VMs.** Each gets its own bundle disk (clonefile from egg's disk.img) + same nvram.bin + same hibernate.bin. Apple's `restoreMachineStateFrom` accepts the same saved state into multiple VZ instances IF the disk identities match.

We haven't tested this on the wells side yet — the verified case is one save, one restore. **This is the test cells should run first**: clonefile the egg's disk.img to two locations, restore the same hibernate.bin into both, verify both wake to running cells with distinct network identities (different MACs, machine identifiers). If it works, this is the killer optimization for `cells init` UX.

If it doesn't work because Apple binds saved-state to a specific disk path: fallback is per-pool-member hibernate.bin (each pool member has its own pre-warmed memory snapshot).

### 4. **Pre-bake at `cells init`**

`cells init` triggers the bake of the base image AND warm-hatches the initial pool. Once init returns, the user's first `cells birth` is sub-2-second.

If this takes too long for `cells init`, run pool warming async in the background and serve the first cells creates from a synchronous bake while pool fills.

---

## Tests cells should run

Order by usefulness:

1. **Single-egg multi-hatch test.** Take a wells hibernate.bin from a working warmed cell. Clonefile its disk.img + copy nvram.bin to two new bundle locations. Issue restore-state to both via lume's API. Verify both wake successfully and have independent network identities.

   This determines whether eggs need 1 hibernate.bin or N.

2. **Pool adoption latency.** Pre-warm a pool of 3 cells (keep them hibernated). Adopt one with identity injection (reset `/etc/.well-ready` + new cidata + wake). Measure end-to-end. Target: <2s.

3. **Pool refill under load.** Adopt all 3 pool members in quick succession. Verify the pool refills async without blocking subsequent adoptions. Target: pool depth recovers within 30s.

4. **`cells init` cold-start.** Measure end-to-end from `cells init` (no prior state) to first `cells birth` returning a ready cell. Target: ≤30s for init, ≤2s for first birth.

5. **Hibernate/wake under steady traffic.** A pooled cell takes traffic, sleeps after auto_sleep_s, takes traffic again. Verify no traffic is dropped during transition.

---

## What wells will keep working on

While cells implements pool/eggs:

- `B.0.9.d.4.f` — bring create+warm under 15s (currently 16-31s; the warming sequence has slack)
- Reset-identity endpoint if cells needs it for pool adoption
- Multi-host colony substrate (Phase D — wells-to-wells WAN registry sync) so a colony of Mac minis can balance pool depth across machines

---

## Coordination

If cells team needs:
- A `POST /v1/wells/{n}/reset-identity` endpoint (un-touch `/etc/.well-ready`, accept new cidata, restart well-firstboot.service)
- Multi-VM restore from a single hibernate.bin (we'd test this on wells first)
- Egg/pool semantics in welld's registry (separate namespace)

→ Reply on this doc or open an issue in the wells repo. We'll ship.

The hibernate/wake primitive is solid. What's left is product-shaped, not engine-shaped.
