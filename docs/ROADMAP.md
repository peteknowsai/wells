# Splites — Roadmap

Splites is the local, owned counterpart to sprites.dev — stateful Linux (and someday other-OS) machines you can spin up, talk to, and walk away from, on hardware you own.

## Principles

- **Sprites and splites are the same noun.** A `splite` is a `sprite` running on a Mac Mini in your closet. The CLI verbs match. The REST shapes match. The mental model is the same: a stateful machine with a filesystem that survives sleep, wake, and reboot.
- **The substrate is yours.** No `api.sprites.dev` dependency. No tokens to rotate. No upstream company has to stay solvent for your fleet to keep working.
- **Every primitive maps to a platform-native one.** Snapshots = APFS clonefile. Hypervisor = Apple's Virtualization.framework. Networking = vmnet. We don't reinvent the layer below; we just expose it cleanly.
- **The engine is replaceable.** lume today. Apple's `containerization` framework when it matures. QEMU/KVM when we deploy to a Linux box. The user-facing surface doesn't shift.

## MVP — Linux parity (current focus)

See [`MVP-PLAN.md`](MVP-PLAN.md) for the phased plan and live progress.

**Goal:** `cells birth pete --backend=splite` works end-to-end against a local Ubuntu 25.10 arm64 splite, using the same surface cells already calls against sprites. State persists across stop/start. Checkpoints are sub-second. The CF Worker bridge keeps working.

## Phase A — Mature management

The pieces sprites has that splites must add for a real-world fleet on owned hardware.

- **Egress allowlist enforced at host firewall.** pf rules per VM tap interface, DNS-based denies. Real teeth on the API stub from Phase 9 of MVP.
- **Autosleep watchdog.** Suspend after N seconds idle, ~1s wake from warm state. Pre-warmed VM pool to make `splite create` effectively instant.
- **Last-N checkpoint retention** with explicit expiration. Mount the last 5 read-only inside the splite at `/.splite/checkpoints/<id>/` (sprites parity).

## Phase B — Multi-OS guests

The real unlock from owning the engine layer: any guest Apple Virtualization.framework can run, plus QEMU-driven extras.

- `splite create --image=macos` — macOS guest on Apple silicon. Apple SLA constraints acknowledged. Useful for cells that drive a real macOS desktop.
- `splite create --image=windows` — Windows guest via QEMU + emulation, or native Hyper-V if we ever expand to Windows hosts.
- `splite create --image=android` — Android guest via the platform emulator binary + ADB.
- New birth recipes for each OS. Cells gains `cells birth pete-mac --os=macos`, `pete-win --os=windows`, etc. — same anatomy/persona model, different substrate.

## Phase C — Splites-native

Things sprites doesn't do, and that we can do because we own the substrate.

- **GPU passthrough** for graphical agents (a splite that sees a Metal device).
- **Multi-VM provisioning under one splite name** — siblings, sidecars (e.g., a database VM that boots alongside the agent VM and only those two can talk to each other).
- **Host instrumentation** — per-splite resource accounting, including watt-hours.
- **Named-volume persistence** beyond the rootfs. Detachable, attachable data volumes you can move between splites.
- **Cross-host migration** via QEMU live-migrate (when we have multiple host boxes).
- **Engine swap to Apple's `containerization` framework** when its volume management matures (sub-second cold-boot would be the headline win).

## Phase D — Drop-in feature parity with sprites

The promise: any sprites workload runs on splites with one env var swap. Done when:

- All sprites CLI verbs implemented at parity.
- All sprites REST shapes match.
- A cells fleet migrates by `cells migrate <name> --to=splite` with no edits to the cell's anatomy.
- Cells's existing skills, scripts, and birth ritual run unchanged.

## Out of scope (for now)

- **Multi-region / HA.** A splite lives where the host lives. Sprites doesn't do this either.
- **Hardware isolation at multi-tenant strength.** Apple's framework is fine for solo or small-team use; if we ever rent splites to others we revisit (Firecracker-on-Linux is the likely path).
- **Live memory snapshots.** Sprites doesn't have these locally either; punted indefinitely.
- **Sprites-cloud feature mirror.** We don't try to replicate sprites' billing, org/team management, or cloud-side checkpoint storage. Local sovereignty is the point.

## Decisions

ADRs live in [`decisions/`](decisions/). Index:

- [0001 — Engine choice: lume](decisions/0001-engine-lume.md)
- [0002 — Bridge: Cloudflare Tunnel + public hostname](decisions/0002-bridge-cloudflare-tunnel.md)
