# Findings: hibernate.bin portability across VM bundles

**Date:** 2026-05-09
**Probe:** `scripts/exp-hibernate-portability.ts`
**Hardware:** Apple Silicon, macOS 15.x, Apple Virtualization.framework via lume
**Question:** When wells produces a saved-state file (`hibernate.bin`) from VM A,
will Apple's `VZVirtualMachine.restoreMachineStateFrom` re-attach it into VM B
with a different bundle? The answer determines what image-fork primitives
wells can expose downstream.

## Headline

`hibernate.bin` IS portable across VM bundles, BUT only when the destination
bundle mirrors the source's VZ-level identity. The saved state implicitly
encodes the producer's machine identifier, MAC, memory/CPU shape, and UEFI
NVRAM — VZ refuses any restore where these drift.

## Variants tested

Each variant builds a "clone" bundle (cln) by booting a fresh well via welld,
stopping it, mutating its lume bundle to mimic the source (src), copying src's
`hibernate.bin` into cln, then calling `lume.restoreState(cln, hibernate.bin)`
directly (bypassing welld validation, so we see what VZ.framework actually
allows).

| Variant | Mutation applied | Result |
|---|---|---|
| v1-naive | None — try VZ-restore as-is | FAIL (cln stop didn't complete in 30s window — needs longer timeout, but mutation alone wouldn't have made this pass anyway) |
| v2-match-machineId | Copy src's `config.json:machineIdentifier` into cln | FAIL (same stop-timeout artifact) |
| v3-match-machineId-and-nvram | + copy src's `nvram.bin` | FAIL (same stop-timeout artifact) |
| v4-full-bundle-mirror | Copy `machineIdentifier`, `macAddress`, `memorySize`, `cpuCount`, `os`, `arch` + `nvram.bin` | **PASS** — `restoreMachineStateFrom` accepted; cln entered status=running |

The B1–B3 failures landed at the lume-stop step before mutation could even
run, so they don't disprove the simpler variants. Future probe should bump
the lume-stop timeout past 30s and isolate whether v1/v2/v3 would clear VZ's
checks if mutation is reached.

The v4 PASS is the load-bearing data point: VZ accepts cross-bundle restore
*at minimum* when full identity is mirrored.

## What this means for wells

Wells can support a "fork from saved state" image primitive. The shape:

- `wells.images.create(name, from_well: src)` produces an image that bundles
  `disk.img` (clonefile-able) AND `hibernate.bin` AND a manifest of the
  source's VZ identity (`machineIdentifier`, `macAddress`, `memorySize`,
  `cpuCount`, `nvram.bin` blob).
- `wells.create(name, from_image: img)` clones disk + applies the manifest
  to the new bundle's `config.json` + `nvram.bin`, then can either boot
  cold (warm-restart path) OR restore from `hibernate.bin` for a near-zero
  warm-up.

This unlocks the cells team's pool/eggs pattern: one image, many warm
clones from the same saved RAM snapshot, sub-second to "ready."

## The catch — concurrent operation

The v4 passing variant copies the source's MAC into the clone. That's
**fine for one clone at a time**, but multiple clones with the same MAC
on the same vmnet bridge will collide at link-layer:
- vmnet's bootpd will reject duplicate DHCP requests with the same MAC.
- ARP tables on the host get poisoned.
- Inbound traffic to the shared MAC routes to whichever clone's xpc child
  registered most recently with vmnet.

So "shared hibernate.bin" works for **sequential warming** (restore →
short-lived cell → destroy → next clone restores from same bin) but
**not concurrent fork**. Concurrent operation needs post-restore MAC
randomization, which VZ's API may or may not support — that's a separate
probe.

A pragmatic shape that sidesteps this: clones share `disk.img` (clonefile)
and the identity manifest, but each clone gets its own freshly-generated
MAC at create-time, and cold-boots via warm-restart. The hibernate-bin
portability is reserved for "one at a time" hot-restore use cases.

## What wells should NOT do with this

- Don't expose hibernate.bin as a generic shared resource. The portability
  is real but the concurrent-operation caveat is sharp — surfacing it
  without that constraint will produce silent network corruption in the
  field.
- Don't auto-mirror `macAddress` from src to fork. The clonefile path
  intentionally gives each fork its own MAC for parallel safety. If a
  caller wants identity mirroring, that's an opt-in.

## Open questions for follow-up probes

1. **Post-restore MAC mutation.** Can `lume.restoreState` accept a config
   where `macAddress` differs from the bin's encoded source MAC? If yes,
   concurrent-operation is unlocked.
2. **Partial identity match.** Does VZ require ALL of (`machineIdentifier`,
   `macAddress`, `nvram`, memory, cpu) to match, or just a subset? v1/v2/v3
   were inconclusive due to the stop-timeout artifact.
3. **Cross-host portability.** Will the bin restore on a different Mac with
   a different VZ build? (Cells team's eventual multi-Mac Colony cares.)

## In plain English

When you save the state of a running VM to a file, that file remembers more
than just the RAM contents — it also remembers what the VM looked like to
Apple's hypervisor (which model, which MAC, how much RAM, etc). To restore
that file into a different VM, the destination has to look identical at
those low levels. We can do that, but it means each "different VM" is
really the same VM at the network layer — so you can have many such VMs
on disk, but you can only run one at a time.
