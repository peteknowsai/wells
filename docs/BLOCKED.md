# Blockers

Open questions / decisions needed from Pete. Loop runs read this file first and skip new work while there's an open blocker.

When resolving: edit/remove the relevant entry, commit, and the next loop run picks back up.

---

## 2026-05-06 — Cloud image is QCOW2; Apple Virt needs RAW

**Context.** First boot attempt of the staged VM in stage 2 part 2 of the bake script: VM transitions to `running` per lume's API, but stays at allocated 881 MB / no IP / no signs of life for 17 minutes. Investigation:

- `file ~/.splites/images/ubuntu-25.10-base/cloud-image.img` → **`QEMU QCOW2 Image (v3), 3758096384 bytes`**.
- Apple's Virtualization framework (`VZEFIBootLoader` in lume) expects **RAW** disk images. The QCOW2 magic bytes (`QFI\xfb`) at offset 0 mean the EFI firmware can't find a partition table or bootloader — VM boots into nothing.

Canonical's "cloud images" all ship as QCOW2 wrapped in a `.img` extension. None of the listed formats (`.img`, `.tar.gz`, `.squashfs`, `.vmdk`, `.ova`, `.vhd`) are raw out of the box.

The QCOW2 has nominal capacity 3.5 GB, sparsely encoded as 841 MB on disk. Conversion to raw produces a 3.5 GB sparse file (still small actual usage on APFS).

## Three ways forward

**(a) Install `qemu-img` via Homebrew.** Standard tooling, widely supported, only need the `convert` subcommand (no actual emulation). Adds qemu as a host prereq. `brew install qemu` is one command, ~few hundred MB. Most likely already installed for anyone doing VM work; Pete doesn't have it on this Mac yet.

**(b) Pre-built base via cua's GHCR.** `lume pull` accepts macOS images from `ghcr.io/trycua` today; cua may publish Linux base images too. Reintroduces the cua dependency we explicitly traded away in ADR 0001. Not a fit for the "owning" thesis.

**(c) Inline QCOW2 → RAW reader in Bun.** Reinventing qemu-img. QCOW2 is well-specified but has L1/L2 tables, refcounts, snapshots, compression — non-trivial. Would take hours of careful work and tests. Worth it eventually if we don't want a qemu dep, but premature today.

**Recommendation: (a).** Lowest-friction path. Adds one host prereq (`qemu-img` from `qemu` brew formula), gates on `command -v qemu-img` at bake-script entry, errors with a clear `brew install qemu` hint if missing. Documented in `docs/install.md` (when that exists).

## What's already cleaned up

- Killed the leftover `lume run splites-base-stage` subprocess (PID 95363, 17 min old).
- Deleted the staging bundle from lume's registry.
- `~/.lume/splites-base-stage/` is gone.

The next bake-script run will start fresh.

**To resolve:** Pick (a), (b), or (c). If (a), say the word and I'll add the conversion step + the `command -v qemu-img` precheck. (Optional: I can also add a `scripts/install-prereqs.sh` that runs `brew install qemu` for you.)

### Loop check-ins

- 2026-05-06 — Loop fired again. Blocker still real (`qemu-img` not on PATH). Stopping without new work.
