# BLOCKED — questions for Pete

## 2026-05-06 — Phase 6 last box: mount last-5 checkpoints inside the guest

**Box:** "Mount the last 5 read-only inside the guest at `/.splite/checkpoints/<id>/` (sprites parity)"

This is the only Phase 6 box left. It's not a small chunk and there's a real
design choice. Want your call before I implement.

### What lume gives us

`lume run` flags (lume v0.3.9, `lume run --help`):

- `--mount <iso>` — single read-only disk image. We're already using it for
  cidata at create time. There's only one slot.
- `--usb-storage <img>` — single USB mass storage attachment.
- `--shared-dir <path>[:ro]` — virtio-fs share of a host directory.

No way to attach 5 separate disk images as virtio-blk in lume v0.3.9.

### Three viable shapes

**A. Shared-dir + in-guest loop-mount (no lume changes).**
At `splite start`, also pass `--shared-dir ~/.splites/vms/<n>/checkpoints:ro`.
A systemd one-shot inside the splite iterates the visible `disk.img` files,
`losetup` + `mount -o ro,nouuid` each one to `/.splite/checkpoints/<id>/`.

- Pros: no lume changes, works with current vendored binary.
- Cons: requires re-baking the base image (or per-splite cloud-init growth) to
  ship the systemd unit + mount script. Adds ~5 loop devices and 5 ro mounts on
  every boot — small but non-zero overhead. Virtio-fs reliability on Apple
  Virt has been spotty in some versions of lume; needs validation.

**B. Patch lume to accept multiple `--mount`.**
Add a `vendor/lume.patches/multi-mount.patch` that lets `lume run` take
`--mount` repeatedly, and surface each as `/dev/vdN`. Then a systemd unit just
mounts the predictable device names.

- Pros: the cleanest model — checkpoint disks are real virtio-blk devices,
  same as the live disk. No virtio-fs bugs to worry about.
- Cons: we'd own a meaningful patch on top of lume, with the long-term
  upstreaming question. The CLAUDE.md rule "Don't modify lume in place. If
  patches are needed, drop them in `vendor/lume.patches/` and apply during
  build" allows this, but it's the first real patch we'd add.

**C. Defer to Phase A.**
The MVP done definition (top of MVP-PLAN.md) doesn't actually mention this
mount. Sprites parity is nice but `cells birth pete --backend=splite` and
`cells talk pete` work fine without it. Move this checkbox to a Phase A
"sprites parity polish" section after Phase 10.

- Pros: lets us hit MVP done sooner. Phases 7/8/9/10 are still a lot of work.
- Cons: leaves a sprites-parity gap. Anyone doing time-travel debugging from
  inside the splite has to copy out checkpoint disks manually.

### My recommendation

**C, then B.** The mount-inside-guest is a developer-experience nicety, not a
"can splites stand in for sprites" gate. Phase 10 (cells integration) doesn't
need it. Once MVP is done and the foundation is proven, the multi-mount lume
patch (B) is the right way to do this — virtio-blk gives us identical
semantics to sprites' Firecracker setup without the virtio-fs flakiness
gamble that A would entail.

If you'd rather knock it out now, A is the path that doesn't fork lume.

Awaiting your call. I'll skip new work until you decide.
