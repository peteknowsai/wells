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

## Phase A — Mature management

The pieces sprites has that wells must add for a real-world fleet on owned hardware. Phased plan with checkboxes lives in [`MVP-PLAN.md`](MVP-PLAN.md). Order of work (most user-visible first):

- **Autosleep + warm pool.** Suspend after N seconds idle; wake on demand; pre-warmed VM pool makes `well create` near-instant. The "feels like sprites" bump.
- **Checkpoint sync to R2.** Push/pull each checkpoint's `disk.img` to a per-well R2 bucket (creds in `meta.json`). Required before Phase E lands meaningfully — fresh-host restore depends on it.
- **Egress enforcement.** Real pf-rule teeth on the policy/network stub from MVP Phase 9. DNS-based denies via a host resolver.
- **Retention with explicit expiration.** Per-checkpoint TTL on top of the existing last-N rule.

## Phase B — Multi-OS guests

The real unlock from owning the engine layer: any guest Apple Virtualization.framework can run, plus QEMU-driven extras.

- `well create --image=macos` — macOS guest on Apple silicon. Apple SLA constraints acknowledged. Useful for cells that drive a real macOS desktop.
- `well create --image=windows` — Windows guest via QEMU + emulation, or native Hyper-V if we ever expand to Windows hosts.
- `well create --image=android` — Android guest via the platform emulator binary + ADB.
- New birth recipes for each OS. Cells gains `cells birth pete-mac --os=macos`, `pete-win --os=windows`, etc. — same anatomy/persona model, different substrate.

## Phase C — Wells-native

Things sprites doesn't do, and that we can do because we own the substrate.

- **GPU passthrough** for graphical agents (a well that sees a Metal device).
- **Multi-VM provisioning under one well name** — siblings, sidecars (e.g., a database VM that boots alongside the agent VM and only those two can talk to each other).
- **Host instrumentation** — per-well resource accounting, including watt-hours.
- **Named-volume persistence** beyond the rootfs. Detachable, attachable data volumes you can move between wells.
- **Cross-host migration** via QEMU live-migrate (when we have multiple host boxes).
- **Engine swap to Apple's `containerization` framework** when its volume management matures (sub-second cold-boot would be the headline win).

## Phase E — Linux hosting (engine pluralism)

The Mac MVP proves the architecture works on owned hardware. Phase E ports
it to a Linux host so wells can live on a $20/mo VPS instead of a Mac in
your closet. The user-facing surface (CLI verbs, REST shapes, cells
integration) stays identical — only the engine boundary swaps.

- New engine module `engine/firecracker.ts` (or `engine/qemu.ts`) satisfies
  the same interface as `engine/vwell.ts`. Welld picks at startup based on
  host OS or `WELL_ENGINE` env var. One repo, two backends.
- Disk-clone primitive abstracted: APFS `cp -c` on Mac, `cp --reflink=auto`
  on btrfs/xfs, qcow2 backing files as the portable fallback.
- DHCP discovery abstracted: macOS `/var/db/dhcpd_leases` ↔ Linux's
  `dnsmasq` / `systemd-networkd` lease files.
- Cidata, ssh, cloud-init flow stays identical — the guest shouldn't be
  able to tell which engine booted it.
- Hosting target: Hetzner CCX21+ ($20/mo) or any KVM-enabled Linux VPS.
  Mac Mini becomes a dev convenience; Linux/VPS becomes the prod target.

Ships when a single repo runs on either OS with the same CLI, cells
integration works against a Linux-hosted welld unchanged, and a well
checkpoint round-trips Mac → R2 → Linux (proving disk-format portability,
or documenting where it isn't).

## Phase D — Drop-in feature parity with sprites

The promise: any sprites workload runs on wells with one env var swap. Done when:

- All sprites CLI verbs implemented at parity.
- All sprites REST shapes match.
- A cells fleet migrates by `cells migrate <name> --to=well` with no edits to the cell's anatomy.
- Cells's existing skills, scripts, and birth ritual run unchanged.

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
