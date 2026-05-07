# Lifecycle — alive, hibernating, frozen

The state model for cells (called "wells" at the runtime layer; see [docs/naming.md in the cells repo](../../cells/docs/naming.md) for full vocabulary). This is the canonical reference; [`state-tiers.md`](state-tiers.md) is the original three-tier investigation, kept for archaeology.

**Status:** locked 2026-05-07.

## The three states

| State | Memory | Disk | Wake | Agent state |
|---|---|---|---|---|
| **Alive** | full RAM (≈4GB) | filesystem (~5GB used) | already up; ~100ms if currently CPU-paused | preserved (continuous) |
| **Hibernating** | 0 | filesystem + RAM image (~9GB total) | ~1–3s | preserved (frozen mid-thought) |
| **Frozen** *(future)* | 0 | filesystem only (~5GB) | ~30s+ (R2 download + restore) | preserved (in cloud) |

Plus the trivially-named end states:

- **Destroyed** — VM gone, but a checkpoint can resurrect it.
- **Created-but-never-alive** — fresh from `splite create`, a transitional state that auto-progresses to Alive.

## What "Alive" means in detail

Alive is "the VM is in RAM and responsive." Internally it has two sub-states the watchdog uses:

- **Running** — CPU active, doing work
- **Paused** — CPU parked but memory still mapped (`VZVirtualMachine.pause`)

These look identical from a *resource* perspective: same memory cost. They differ only in CPU. The watchdog pauses idle alive cells to free CPU; users don't see the distinction. If you `talk pete` and pete is paused, lume's resume happens transparently in <100ms before your message reaches the agent.

So when we say "alive," it means *responsive within sub-second*, regardless of which CPU sub-state.

## What "Hibernating" means

The VM's RAM is written to a file on local disk; the memory is freed. From `lume`'s perspective, the VM is stopped — no `VZVirtualMachine` instance exists. Wake = `VZVirtualMachine.restoreState(from:)` reads the file back, allocates memory, and resumes execution from exactly where pause left off.

Cost: ~4GB of saved-RAM file on disk per hibernating cell. Hibernation files only exist while a cell is hibernating; on wake, the file is consumed and deleted. Going back to sleep writes a fresh one.

Wake latency: dominated by disk read + memory allocation. On NVMe SSDs it's typically 1–3 seconds. The agent inside the cell never noticed; its in-memory state is bit-identical post-restore.

**Implementation note:** the warm-tier patch (A.1.3.e.2 in MVP-PLAN.md) is what lets us call `saveState`/`restoreState` on a running VM. lume doesn't expose these primitives today; we'll patch lume to add them, similar to how we added pause/resume.

## What "Frozen" means (future)

Long-tail cells — used last week, last month, never again — hibernate forever and waste local disk. The Frozen tier moves the hibernation file to remote object storage (R2 by default; any S3-compatible target works) and removes the local copy. Just the cell's filesystem stays on the host; the RAM image lives in the cloud.

Wake from Frozen = thaw: download the RAM image from R2, then restore-from-hibernation as usual. Practically: 30 seconds-plus depending on bandwidth and image size, but agent state is fully preserved.

The infrastructure landed in Phase A.2 (R2 client, `splite checkpoint create` pushes to R2, `splite checkpoint restore --from-r2` pulls back). The lifecycle hook that actually demotes cells from Hibernating to Frozen on long idle hasn't been wired yet — that's a future post-MVP task.

## Why no "cold" state

The original design had a Cold tier (= stopped, only the disk image remains, RAM contents lost). Dropped because:

1. **Disk savings are irrelevant on owned hardware.** The 4GB hibernation-file saving was significant on metered Fly.io but pointless on a Mac Mini with terabytes.
2. **Cold loses the agent's working memory.** For pi cells, that means losing model context, conversation state, in-flight reasoning. Almost never the right call when hibernation is so cheap.
3. **The "I want this cell truly gone" use case is `splite destroy`,** not a tier. Destroy + checkpoint restore covers the explicit-stop intent better than tier-bouncing.
4. **The "force-restart from clean disk" use case is a flag on wake** (`splite wake --fresh` discards the hibernation image), not a separate tier. Used for kernel updates or recovering wedged processes — rare enough to be a flag, not first-class.

## Watchdog policy

With this model, the watchdog has one decision to make: **when an alive cell goes idle, does it pause-in-place (stay alive), or hibernate (free memory)?**

The pause-in-place path is cheap — it frees CPU but not memory. So it's the default for short idleness. Hibernation kicks in when memory is contended.

```
Cell becomes idle:
  ├─ pause CPU (still alive, 100ms wake)
  │
  └─ if (host memory under pressure) OR (idle > N hours):
      └─ hibernate (~9GB on disk, 1-3s wake)

Cell stays hibernating:
  └─ if (idle > M days) AND (R2 configured):  // future
      └─ freeze (offload to R2, ~5GB on disk locally)
```

**Tunables (set per host via `~/.splites/defaults.json`):**

| Knob | Default | Notes |
|---|---|---|
| `auto_pause_seconds` | 30 | how long alive-and-idle before CPU pause |
| `auto_hibernate_seconds` | 3600 (1 hour) | how long alive-and-idle before saving to disk |
| `auto_freeze_days` | (future) | how long hibernating before R2 offload |
| `memory_pressure_threshold` | (TBD) | host-wide RAM-used % above which we aggressively hibernate alive cells regardless of per-cell idle time |

Per-cell overrides on the registry record (`auto_sleep_seconds`, etc.) take precedence over the global defaults — same shape as today.

## Memory-pressure handling

Pete's M5 Pro has 48GB RAM, ~32GB usable for cells (16GB reserved for the host OS). With 4GB-per-cell sizing, that's ~8 alive cells max. Beyond 8 the watchdog must hibernate something.

Eviction policy when memory is pressured (least- to most-recently-active):

1. The longest-idle alive cell goes to hibernating first.
2. If still pressured, the next-longest-idle, and so on.
3. Cells with `auto_sleep_seconds: null` (never-sleep) are exempted from eviction unless ALL non-pinned cells have already been hibernated. After that, even pinned cells start getting hibernated, with a log line warning that the user explicitly opted out of sleep but ran out of room.

There's no "thrashing" risk because hibernation is durable — once a cell is hibernating, it won't bounce back to alive until the user actively wakes it.

## Capacity, in numbers

For a 48GB RAM / 1TB disk Mac Mini with 4GB cells (5GB filesystem, 4GB RAM):

| State | Per cell | Capacity |
|---|---|---|
| Alive | 4GB RAM, 5GB disk | ~8 (RAM-bound) |
| Hibernating | 0 RAM, ~9GB disk | ~110 (disk-bound, before APFS clonefile sharing) |
| Frozen *(future)* | 0 RAM, ~5GB disk | ~200+ on host; cells in R2 don't count |
| Destroyed | 0 (post-checkpoint) | unlimited |

In Pete's "couple hundred cells, mostly idle" target, the steady-state shape is: 1–8 alive (active conversation right now), most-of-the-rest hibernating, the long tail eventually frozen.

## Practical examples

**Example 1: pete cell (Pete's daily-driver)**
- Pinned `auto_sleep_seconds: null` — never auto-hibernates
- Stays alive (CPU paused when idle, briefly running when Pete talks to it)
- Survives even tight memory pressure unless many other never-sleep cells exist

**Example 2: ad-hoc research cell, used yesterday**
- Auto-paused after 30s of inactivity (still alive)
- Auto-hibernated after 1 hour of inactivity (memory freed)
- Sits hibernating; if Pete comes back tomorrow, ~2s wake brings the agent back exactly where they left off

**Example 3: experiment-from-three-months-ago cell**
- Hibernated for 3 months
- (Future) Auto-frozen to R2 after 7 days, freeing ~4GB local disk
- If Pete wants it back: ~30s thaw from R2, then continues exactly where it was

## Open questions

1. **Memory-pressure threshold tuning.** What % of host RAM used should trigger pre-emptive hibernation? Likely 80%, but needs measurement.
2. **Hibernation file location.** Currently planned for `~/.splites/vms/<name>/hibernate.img`. Should it live alongside the disk image or in a separate hibernate-specific subdirectory? Probably separate so we can rsync them differently.
3. **Hibernation-file lifecycle.** When a cell wakes and then hibernates again, do we reuse the file path? Pre-allocate it? Stream incrementally? Most likely: write fresh each time, no incremental.
4. **Compression.** Hibernation files are mostly zero pages for fresh cells. Worth compressing? Probably yes — `lz4` or zstd typical 4× wins on RAM dumps. Trade-off: CPU time on save/restore.
5. **Multi-cell-per-VM.** This doc assumes one cell per VM. If we ever ship multi-cell-per-VM (unlikely given Pete's "one cell, one VM" call), this whole tier model gets more complex.

## Cross-references

- `docs/MVP-PLAN.md` Phase A.1.3 — the tier work in the plan
- `docs/state-tiers.md` — original three-tier investigation, superseded but useful for archaeology
- `docs/naming.md` (cells repo) — full vocabulary stack
- Phase A.2 (`docs/MVP-PLAN.md`) — R2 sync infrastructure that Frozen will build on

---

**In plain English:** Cells live in memory while they're being used and answer in milliseconds. When you stop using one, it takes a nap on the local disk and answers in a couple seconds when you wake it. If it's been napping for a really long time, eventually it gets shipped to the cloud and answers in maybe half a minute when you call it back. It never forgets anything across any of these — what changes is where it's stored and how fast it can answer.
