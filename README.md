# Splites

Local, stateful Linux machines that look and feel exactly like sprites.dev sprites — on hardware you own.

A `splite` is a sprite that lives on your Mac Mini. The CLI verbs match. The REST shapes match. The mental model is the same: a Linux machine with a filesystem that survives sleep, wake, and reboot. The substrate is yours.

## Status

Pre-alpha. MVP in flight — see [`docs/MVP-PLAN.md`](docs/MVP-PLAN.md). Long-term roadmap in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Why

Sprites are great. But the upstream company has to stay solvent for the fleet to keep working, and the substrate is locked to one Linux flavor. Splites:

- **Owned end-to-end.** Engine is open (vendored lume → Apple's Virtualization.framework). State is on your disk. No tokens to rotate, no `api.sprites.dev` to depend on.
- **Sprites-shaped surface.** Anywhere you call `sprite ...` today, `splite ...` does the same thing locally. The REST shapes match too — point `SPRITES_API_URL` at the local daemon and existing tooling keeps working.
- **Future: multi-OS guests.** Once the Linux substrate is solid: macOS, Windows, Android via the same lume / Virtualization.framework path. Sprites is Linux-only — splites doesn't have to be.

## Design

See [`docs/architecture.md`](docs/architecture.md) for the one-pager. Short version:

- `splite` — Bun/TS CLI, thin client.
- `splited` — Bun/TS daemon on `:7878`, sprites-shaped REST. Single owner of state.
- Engine — vendored lume binary driving Apple's Virtualization.framework. Linux guests today; macOS/Windows/Android later.
- State — `~/.splites/` (registry, images, vms, checkpoints).

## Build / run

Coming with Phase 0 — see [`docs/MVP-PLAN.md`](docs/MVP-PLAN.md). The build is happening incrementally via the `/mvp-splites` autonomous loop.
