# Wells — Roadmap

Wells is the local, owned counterpart to sprites.dev — stateful Linux (and someday other-OS) machines you can spin up, talk to, and walk away from, on hardware you own.

## Principles

- **Sprites and wells are the same noun.** A `well` is a `sprite` running on a Mac Mini in your closet. The CLI verbs match. The REST shapes match. The mental model is the same: a stateful machine with a filesystem that survives sleep, wake, and reboot.
- **The substrate is yours.** No `api.sprites.dev` dependency. No tokens to rotate. No upstream company has to stay solvent for your fleet to keep working.
- **Every primitive maps to a platform-native one.** Snapshots = APFS clonefile. Hypervisor = Apple's Virtualization.framework. Networking = vmnet. We don't reinvent the layer below; we just expose it cleanly.
- **The engine is replaceable.** lume today on Mac. Firecracker/QEMU on Linux when we host on a VPS. Apple's `containerization` framework when it matures. The user-facing surface doesn't shift, and we don't fork the repo per engine — see [`decisions/0003-multi-engine.md`](decisions/0003-multi-engine.md).

## MVP — Linux parity (current focus)

See [`MVP-PLAN.md`](MVP-PLAN.md) for the phased plan and live progress.

**Goal:** `cells birth pete --backend=well` works end-to-end against a local Ubuntu 25.10 arm64 well, using the same surface cells already calls against sprites. State persists across stop/start. Checkpoints are sub-second. The CF Worker bridge keeps working.

## Versioning

- **v0.1.0** — MVP shipped 2026-05-06 (sprites-shape API + first cell birth).
- **v0.2.0** — Phase A partial squashed 2026-05-12 (operational maturity, image substrate, static IPs).
- **v1.0.0** — wells GA: Phase A complete + Phase B substrate (B.0.x) complete + boundary cleanup + `lume.app → vwell.app` rename + one-command installer. **Wells-side scope is done as of 2026-05-14** — the substrate is 1.0-ready. Phase B's B.1–B.4 (cells flips backend, end-to-end LLM smoke, load test, tuning) are cells-repo + cells-acceptance work, not wells code, and were moved out of wells's MVP. A soft cells sign-off on the substrate may follow but isn't blocking. Remaining step: Pete cuts the tag. See [`road-to-wells-1.0.html`](proposals/road-to-wells-1.0.html).
- **v1.x** — Frozen tier (R2 hibernation offload — deferred from 1.0), Phase C (memory chunks), Phase D (multi-Lab Colony).

## Phase A — Mature management (mostly done)

The pieces sprites has that wells must add for a real-world fleet on owned hardware. Phased plan with checkboxes lives in [`MVP-PLAN.md`](MVP-PLAN.md). Order of work (most user-visible first):

- **Autosleep + warm pool.** Suspend after N seconds idle; wake on demand; pre-warmed VM pool makes `well create` near-instant. ✅ Shipped.
- **Checkpoint sync to R2.** Push/pull each checkpoint's `disk.img` to a per-well R2 bucket (creds in `meta.json`). ✅ Shipped + round-trip verified 2026-05-10.
- **Egress enforcement.** Real pf-rule teeth on the policy/network stub from MVP Phase 9. ❌ Deferred 2026-05-11 — no concrete consumer.
- **Retention with explicit expiration.** Per-checkpoint TTL on top of the existing last-N rule. ✅ Shipped.

Phase A is complete for 1.0. A.1.3.c (tier-transition benchmarks) and A.1.3.g (scenario coverage smoke) shipped 2026-05-12. A.2's Frozen tier (R2 hibernation offload) was deferred to 1.x on 2026-05-14 — wells runs on owned local hardware, so R2 durability offload isn't a 1.0 concern; it returns in 1.x as the substrate for Phase D cell migration.

## Phase B — Cells deploys to wells (wells-side complete)

Phase 10 made wells a *drop-in* for the sprites API contract. Phase B is the *real* layer: cells's `birth/talk/checkpoint/sleep/wake/destroy` running against wells in production. **Wells's side of Phase B is complete** — B.0.6 (lume SharedVM), B.0.7 (lifecycle truth), B.0.8 (image contract), B.0.9 (hibernate/wake), B.0.10 (mount regression), B.0.11 (fork hardening), plus the wells-cells boundary cleanup sprint (static IPs, image alias, pool migration to cells) all shipped. B.1–B.4 (cells flips backend, end-to-end LLM smoke, load test, tuning defaults) are cells-repo + cells-run acceptance work and were moved out of wells's MVP on 2026-05-14. See [`MVP-PLAN.md`](MVP-PLAN.md) § Phase B.

## Phase C — Memory chunks (1.x)

Dynamic memory grants modeled in `docs/memory-budget.md`. Lets the host pack 2-3× more cells than static allocation by reclaiming idle cells' RAM into a shared chunk pool. Most useful after Phase B real workloads exist to exercise the controller. Not in 1.0 scope.

## Phase D — Multi-Lab Colony (1.x)

The Colony layer from `docs/naming.md` made real. A single Mac (one **Lab**) hits a hard ceiling around 100-200 cells alive; past that, you add another Mac. This phase makes wells span multiple local-network Macs as one Colony. Depends on A.2 Frozen tier shipping (the hibernation-to-R2 substrate is what enables cell migration between Labs). Not in 1.0 scope.

## Phase E — Cloud hosting (deprioritized)

Originally framed as "port wells to KVM-on-Hetzner-VPS." Deprioritized 2026-05-07: cloud hosting breaks the cooperation-first economics (metered RAM = paused cells aren't free) and adds latency that defeats sub-millisecond pause/resume. Not in 1.0 scope. If we ever do this, likely as cold-storage offload for Frozen-tier cells (R2 already covers that).

## Future (not phased yet)

Things we can do because we own the substrate, that don't have a phase home yet — drop into MVP-PLAN when there's a real consumer:

- **Multi-OS guests.** `well create --image=macos|windows|android` via Apple's framework + QEMU. Useful for cells driving a real desktop.
- **GPU passthrough** for graphical agents.
- **Multi-VM under one well name** — siblings, sidecars (e.g. database VM that boots alongside the agent VM).
- **Host instrumentation** — per-well resource accounting, watt-hours.
- **Named-volume persistence** beyond the rootfs.
- **Engine swap to Apple's `containerization` framework** if its lifecycle model matures (currently has no save/restore API).

## Out of scope (for now)

- **Multi-region / HA.** A well lives where the host lives. Sprites doesn't do this either.
- **Hardware isolation at multi-tenant strength.** Apple's framework is fine for solo or small-team use; if we ever rent wells to others we revisit (Firecracker-on-Linux is the likely path).
- **Live memory snapshots.** Sprites doesn't have these locally either; punted indefinitely.
- **Sprites-cloud feature mirror.** We don't try to replicate sprites' billing, org/team management, or cloud-side checkpoint storage. Local sovereignty is the point.

## Decisions

ADRs live in [`decisions/`](decisions/). Index:

- [0001 — Engine choice: lume](decisions/0001-engine-lume.md)
- [0002 — Bridge: Cloudflare Tunnel + public hostname](decisions/0002-bridge-cloudflare-tunnel.md)
- [0003 — Multi-engine: one repo, swap the engine](decisions/0003-multi-engine.md)
