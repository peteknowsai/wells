# 0003 — Multi-engine: one repo, swap the engine

**Date:** 2026-05-06
**Status:** Accepted

## Context

Splites today runs on Apple Virtualization.framework via vendored lume.
That's macOS-only, which means "self-hosting splites" today means
"self-hosting on a Mac in your closet" — fine for a dev rig, awful as a
production target. Pete wants splites to live on a Linux VPS too, so the
hosting story becomes "$20/mo Hetzner box" instead of "Mac in your closet
or $80/mo MacStadium subscription."

Linux has the right primitives — Firecracker, KVM/QEMU, btrfs reflinks —
and they're well-trodden. Sprites itself runs on Firecracker.

The question was whether to fork splites into a sibling project (working
name was "svites") for the Linux flavor, or to extend splites to support
both engines.

## Decision

**One repo. Two engine modules. Picked at runtime.**

The engine boundary already lives in a single file (`engine/lume.ts`), per
ADR 0001's "swapping engines later should be a one-file change." Phase E
adds `engine/firecracker.ts` (or `engine/qemu.ts`) satisfying the same
interface. Splited picks one at startup via `SPLITES_ENGINE` env var or
auto-detect on host OS.

Splite-level concerns — registry, ssh keys, cloud-init composition, REST
API shape, Cloudflare Tunnel bridge, R2 sync, cells integration — all
stay engine-agnostic and shared.

## Rejected: separate repo

Forking the codebase ("svites") was tempting because the Linux engine has
real differences (Firecracker config files, Linux DHCP discovery, btrfs
clones vs. APFS), but it would mean:

- Double maintenance for everything above the engine — that's 80% of the
  code we wrote in Phases 0-7.
- Divergent bug fixes the moment we touch shared concerns.
- Two brands to explain forever, even though they're the same product
  with different host OS.
- Throwing away the "engine boundary in one file" discipline we already
  paid for.

## Consequences

- Phase E (Linux hosting) is added to the roadmap. It's post-MVP — we
  finish the Mac MVP first, then port.
- Any new code added in Phases 8/9/10 must respect the engine boundary:
  if it ends up calling `lume.foo()`, it should be doing so through the
  abstract `Engine` interface, not directly.
- Disk format portability (qcow2 as a lingua franca, or APFS-clonefile-
  produced raw images that Linux can also read) is now a concern. We'll
  validate by round-tripping a checkpoint Mac → R2 → Linux as the Phase E
  exit criterion.
- The Mac engine is no longer the destination. It's a dev convenience and
  a "splites also runs on the laptop you're holding" affordance. The
  prod path is Linux on a VPS, with Cloudflare Tunnel out front.

## Naming

We don't fork the brand. The Linux variant is just "splites running on
Linux." The repo stays `splites`. The product stays splites. The CLI
binary stays `splite`. The only thing that changes per host is which
engine module gets loaded.
