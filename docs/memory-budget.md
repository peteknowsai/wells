# Memory budget — sizing cells and the chunks model

How splited thinks about RAM allocation per cell, and the future "chunks pool" mechanism that lets the host pack many more cells than naive allocation math allows.

**Status:** design + small defaults change shipped. Chunks controller deferred until after cells/splites integration (Phase C).

## The problem

Cells run pi (an LLM agent harness — Bun + a small TypeScript runtime). Pi's actual working set is small — kernel + bun + pi process + filesystem cache totals maybe 250-700 MB during typical work, with rare spikes to ~1 GB on heavy turns. But cell allocations of 4 GB (the original sprites-derived default) cap the alive ceiling on any host at `(host_RAM - overhead) / 4`. On a 64 GB Mac that's only 13 cells, despite each cell rarely using more than 600 MB in practice.

The right sizing approach has two moves:

1. **Drop the per-cell allocation** to something close to the working set. For pi, that's about 1 GB (with measurement, maybe 512 MB).
2. **Layer dynamic memory granting on top** so cells that occasionally need more can borrow from a shared pool, and idle cells return memory the host can re-loan.

This doc describes the model, the math, and how it wires up.

## Components of a pi cell's RAM use

Approximate, from first principles:

| Component | Resident RAM |
|---|---|
| Linux kernel (Ubuntu, our base image) | ~50 MB |
| systemd + sshd + minimal services | ~50 MB |
| Bun runtime | ~30 MB |
| Pi process (idle, session loaded) | ~80-150 MB |
| Pi process during active turn (LLM streaming + tool calls) | ~250-500 MB peak |
| Filesystem cache | takes whatever's available |
| Kernel free-memory slack | ~30 MB minimum |
| **Floor for an idle cell** | **~250-300 MB** |
| **Typical working set during a turn** | **~400-700 MB** |
| **95th percentile / heavy turn** | **~700-1,000 MB** |
| **Worst case (large file, big context, multiple tool spawns)** | **~1.0-1.2 GB** |

Most cells, most of the time, are below 600 MB. Worst case spikes to ~1 GB. We're not yet measuring this empirically — the numbers are first-principles estimates and should be confirmed before tightening defaults further.

## The static sizing recommendation

For now, with no measurement and no chunks controller:

- **Default per-cell allocation: 1 GB** (down from 4 GB). Safe ceiling for almost all turns.
- **Per-cell swap file: 512 MB**, in cloud-init. Effective ceiling becomes 1.5 GB for the rare burst; pages out to disk slowly rather than OOM-killing.
- **Heavy cells opt for more via `splite create --memory 2GB`** when the user knows the cell will run heavy workloads (e.g. an autonomous coding agent processing big repos).

What this gives at allocation density (no balloon, no chunks):

| Machine | RAM | Alive cells at 1 GB |
|---|---|---|
| Mac mini M5 (24 GB) | 24 | ~13 |
| Mac mini M5 Pro maxed (64 GB) | 64 | ~54 |
| Mac Studio M5 Max maxed (128 GB) | 128 | ~118 |
| Mac Studio M5 Ultra maxed (512 GB) | 512 | ~502 |

vs. ~13/29/125 at the old 4 GB default. **3-4× density improvement just from sizing.**

## The chunks model (future)

Static allocation has a problem: if 90% of cells need ≤500 MB at any moment but allocations are 1 GB, half the RAM is reserved-but-unused. We should be able to do better.

**The chunks abstraction:**

- **Base reservation**: 512 MB per cell, always committed at boot. Every cell gets one.
- **Chunk pool**: a shared pool of 512 MB blocks. Sized at boot from the host's spare RAM after base reservations.
- **Grant**: when a cell pushes against its base, splited grants it a chunk from the pool. Cell now has 1 GB working room. (Or 1.5 GB if it grabs two chunks — limited by the cell's allocation ceiling.)
- **Return**: when the cell idles (typically when `agent_end` fires), splited reclaims the chunk back to the pool.

So at any moment, the host's total RAM = `base_reservations + chunks_granted + chunks_in_pool + host_overhead`.

Underlying mechanism: Apple's VZ memory ballooning, which is already wired in lume's VM config (`VZVirtioTraditionalMemoryBalloonDeviceConfiguration` at `vendor/lume/src/Virtualization/VMVirtualizationService.swift:305,467`). The balloon device is present in every VM but nothing currently *controls* it — its target size stays at default (no reclamation). The "chunks" model is just ballooning with discretized 512 MB steps and a coordinator on the host side.

### Math under the chunks model

Sizing a host becomes:

```
required_RAM = host_overhead + N_cells × 512 MB + chunk_pool_size × 512 MB
```

Pick N (durable cell count), pick chunk_pool_size (peak concurrent burst capacity), do the arithmetic:

| Goal | Math | Min RAM |
|---|---|---|
| 50 cells, 15 concurrent bursts | 10 + 25 + 7.5 = 42.5 GB | 48 GB Mac |
| 100 cells, 30 concurrent bursts | 10 + 50 + 15 = 75 GB | 96 GB+ |
| 200 cells, 50 concurrent bursts | 10 + 100 + 25 = 135 GB | 192 GB+ |
| 500 cells, 80 concurrent bursts | 10 + 250 + 40 = 300 GB | 512 GB Ultra |

The chunk pool size is what lets the host claim "we support N cells" — it's the peak concurrent activity capacity.

### Operational metric

The chunks model produces a beautiful health signal:

```
capacity_utilization = chunks_granted / chunk_pool_size
```

Track this over time. Trigger warnings:

- `p95_24h(capacity_utilization) > 85%` → "Your colony is regularly using >85% of burst capacity. Consider scaling up RAM or reducing concurrent active agents."
- Any moment of `chunks_granted == chunk_pool_size` → "Memory contention right now. Some cells are paging."
- A cell requests a chunk and is denied → "Grant pressure event."

This is more useful than raw "RAM 90% used" because it tells the operator exactly what's happening (bursts can't get the memory they want) and what to do about it (more RAM, fewer cells, or smaller cells).

## Implementation order

When the chunks work picks up (Phase C, post-cells-integration):

1. **Lume Swift patch** (~50-80 lines, `vendor/lume.patches/`):
   - New API on the running VM: `setBalloon(targetMB)` calling Apple's `setTargetVirtualMachineMemorySize`.
   - HTTP route: `POST /lume/vms/:name/balloon` body `{target_memory_mb: 512}`.

2. **Splited TypeScript wrapper** (~20 lines, `engine/lume.ts`):
   - `LumeClient.setBalloon(name, mb)` that calls the new lume route.

3. **Splited pressure controller** (~150-200 lines, new module):
   - On every cell start: inflate balloon by `(allocation - 512MB)` so the cell sees only its base reservation.
   - On `/sleep` (cooperation API, already shipped): if the cell holds chunks, inflate the balloon to reclaim them.
   - On signals of guest pressure (need a mechanism — possibly extending the cooperation API with a `/grant-chunk` endpoint the harness can call before heavy work): deflate by 512 MB.
   - Track total chunks granted, peak concurrent grants, denials.

4. **Metrics + thresholds** (~50 lines):
   - Log chunks_granted over time.
   - Expose via `splite info` — show colony-wide capacity utilization.
   - Trigger warnings on the conditions above.

Total estimate: 1-2 days of focused work to ship the chunks system end-to-end.

## What's deferred to cells/splites integration

The chunks model is most useful when we have many real cells running real LLM workloads concurrently. Until then we'd be optimizing without empirical data on what the working sets actually are or how often they spike.

Cells/splites integration brings:
- Real pi sessions with real LLM traffic (provisioning + secrets + extensions all come for free from cells).
- A natural multi-cell load where we can measure working set distributions across cell types.
- A reason to actually pack cells dense, which today's pete-only setup doesn't motivate.

So the order is:
1. (now) Drop static default to 1 GB + add 512 MB swap. Document the chunks model.
2. (Phase B) Cells/splites integration. Brings real pi sessions, lets us measure.
3. (Phase C) Implement the chunks controller. Tune defaults based on measurement.

## What's done now

- Default cell allocation drops 4 GB → 1 GB in `lib/defaults.ts`.
- Swap file creation added to `templates/cloud-init-splite.yaml`. Every new cell gets 512 MB swap automatically.
- This doc captures the chunks model so future-Pete and future-Claude know the design when Phase C work begins.

## In plain English

Cells today are over-allocated. Most of them sit using 500 MB while we've reserved 4 GB for them — that's 87% of the reservation wasted. Just dropping to a smaller default (1 GB) buys a 4× density gain immediately. The smarter thing — a "chunks pool" where cells can borrow extra memory when they're working hard and give it back when they're idle — buys another 1.5-2× on top, and produces a cleaner operational signal ("we're at 85% of burst capacity") than raw RAM usage. We're shipping the simple win now and parking the chunks controller until we have real cells to test it against.
