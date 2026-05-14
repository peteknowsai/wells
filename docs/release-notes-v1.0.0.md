# wells v1.0.0 — GA

Wells is the local, owned counterpart to sprites.dev: stateful Linux machines you can spin up, talk to, and walk away from — on hardware you own. A `well` is a sprite running on your Mac. The CLI verbs match, the REST shapes match, the mental model is the same. No `api.sprites.dev` dependency, no tokens to rotate, no upstream company that has to stay solvent for your fleet to keep working.

v1.0.0 marks wells as generally available: the substrate is complete, the test suite is green (993/993), and install is one command.

## Install

```sh
git clone https://github.com/peteknowsai/wells.git
cd wells
scripts/install.sh
```

One command brings up the whole local substrate — the engine, the `well` CLI, the dhcp helper, the `welld` daemon, and the menu-bar app — all as launchd agents, so they survive reboot. It's idempotent. Prereq: [bun](https://bun.sh) on `PATH`. The public-URL bridge (`cloudflared`) is optional — local use, including cells on the same machine, talks to `127.0.0.1:7878` directly.

## What's in 1.0

- **Sprites-shaped surface.** `well create / exec / start / stop / destroy / list` with REST + CLI parity. Flip `CELLS_BACKEND=well` and existing sprites tooling works against a local well.
- **Hibernate + wake-on-traffic.** Release a well's RAM to disk in ~200ms; wake on inbound traffic in ~1s. A paused well costs disk, not dollars.
- **`/seal`.** Turns a provisioned well into a hibernate-legal snapshot in one call — the substrate primitive cells's pool builder bakes pool members on.
- **Image save / push / pull.** APFS clonefile of a stopped well; R2 push/pull for cross-host transfer.
- **Static IP allocation.** Welld owns the IP before the VM boots — no bootpd races.
- **Public-URL bridge (optional).** Every well reachable on your own domain via `cloudflared`.
- **Owned engine.** The Virtualization.framework engine is a wells-owned soft fork (`bin/vwell.app`), Developer-ID signed, shipped as a release asset that `scripts/install.sh` pulls.

## Since v0.2.0

- **Phase A complete** — autosleep + wake, checkpoint sync to R2, retention with explicit expiration.
- **Phase B substrate (B.0.x) complete** — welld owns lifecycle truth, hibernate/wake config drift fixed, cloud-init stripped from the base image, fork-from-saved-image hardened, the image contract + `/seal` primitive shipped.
- **Wells/cells boundary cleanup** — wells owns the substrate primitives; pool ownership moved to cells. Static IPs replaced the DHCP-lease layer.
- **`lume.app → vwell.app`** — the engine artifact carries the wells-owned name.
- **One-command install + release pipeline** — `scripts/install.sh` and `scripts/package-release.sh`.
- **W.73 resurrect race closed** — wells resurrect a raced well via a retry rather than leaving it down after a welld bounce.
- **Test suite genuinely green** — 993/993, isolated from host state.

## Scope boundaries

- **The pool is cells's.** Wells owns the substrate primitives (`create`, `seal`, `hibernate`, `wake`, `exec`, image management); cells owns pool ownership, refill, and eviction.
- **Frozen tier deferred to 1.x.** R2 hibernation offload — wells runs on owned local hardware, so the durability offload isn't a 1.0 concern. It returns in 1.x as the substrate for cross-Lab cell migration.
- **Single host.** A well lives where the host lives. Multi-Lab Colony is Phase D (1.x).

## Engine provenance

`engine/vwell-src/` is a wells-owned soft fork of [trycua/lume](https://github.com/trycua/lume) (MIT), originally pinned at `d422294b`. Built + Developer-ID signed via `scripts/build-vwell.sh`; the SPM target stays named `lume` internally (it must match the bundle's `CFBundleExecutable` for codesign).
