# 0001 — Engine choice: lume

**Status:** accepted (2026-05-05)

## Context

Splites needs to boot and manage Linux VMs on macOS hosts (specifically Apple silicon Mac Minis, primary target: Pete's home Mac Mini). Three candidate engines:

1. **lume** — Swift binary in the cua monorepo (MIT). Wraps Apple's Virtualization.framework. ~5k LOC. Provides an HTTP API on `:7777` plus a CLI. Boots Linux + macOS guests at near-native speed via M-series hypervisor extensions and VirtIO devices. Active development in 2025–2026.

2. **Apple's `containerization` framework** ([apple/container](https://github.com/apple/container) + [apple/containerization](https://github.com/apple/containerization)) — Apple's official Linux-on-Mac runtime, released June 2025 alongside macOS 26 Tahoe. Sub-second cold boot via minimal kernel. Currently v0.1.0; lacks mature persistent volume / bind mount support.

3. **QEMU directly** — vendor-neutral, LGPL. Drives Virtualization.framework via `accel=hvf` or runs full emulation. Universal but heavier and more code to integrate.

## Decision

Use lume for v1.

## Rationale

- **All Apple silicon optimizations are in the framework, not in the wrapper.** Lume is a thin layer over `Virtualization.framework`. Choosing lume means we inherit hardware hypervisor extensions, VirtIO, and APFS clonefile snapshots without writing a line of Swift ourselves.
- **Stateful filesystem semantics map cleanly to lume's bundle model.** Each lume VM is a bundle directory with a persistent disk image inside. That's exactly Pete's "Linux machine with a filesystem that's always there" mental model.
- **Apple's `containerization` framework isn't ready.** It's exciting (sub-second cold boot would be a perf win), but its volume management is too immature for splites' "filesystem always attached" core promise. The whole point of splites is statefulness — a v0.1.0 framework that doesn't have stable volumes yet would force us to invent a workaround that we'd then throw away.
- **QEMU direct works but costs more.** ~5k Swift LOC of lume would have to be rewritten in our own wrapper, plus QEMU's QMP integration. The lume layer is finished and well-shaped.
- **Lume is MIT and the upstream is reachable.** We vendor at a pinned commit. If cua disappears, we own the source.
- **The engine boundary is one file** (`engine/lume.ts`). Swapping later is cheap.

## Reconsider when

- **Apple's `containerization` framework hits v1.0+ with mature volume support.** Sub-second cold boot from genuinely-cold state is a real perf win we'd inherit. Engine swap likely worth it then.
- **We need to host splites on a Linux box** (e.g., a colo). lume only runs on macOS — Linux hosts need QEMU/KVM directly or Firecracker. The engine boundary makes that path clean.
- **Lume upstream goes dark** (cua company shutters, repo unmaintained, security issues). We already vendor — we'd just take ownership of the source ourselves.

## Implementation notes

- Vendor lume at `vendor/lume/` at a pinned commit. Record the commit hash and the upstream URL in `vendor/lume.txt`.
- Build via `scripts/build-lume.sh` → `bin/lume`. Don't ship a pre-built binary; build on first daemon start or via a setup step.
- Do not modify lume in place. If patches are needed, drop them in `vendor/lume.patches/` and apply during build. This keeps rebases against upstream tractable.
- The daemon shells out to `bin/lume` and / or talks to lume's HTTP API at `:7777`. The wrapper module `engine/lume.ts` is the only place that knows about either.
