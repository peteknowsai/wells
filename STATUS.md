# wells — Current Status

**Updated:** 2026-05-14 by `worker`. This session: renamed the engine artifact `lume.app → vwell.app`, built a one-command installer (`scripts/install.sh`) + a release-asset pipeline (`scripts/package-release.sh`), made the test suite genuinely green by isolating `ipPool` tests from host state, and closed W.73 (the resurrect race) with a retry.
**Phase:** Phase A complete. Boundary cleanup (Pi 1/2/3) closed 2026-05-13. Phase B's wells-side (B.0.x) complete. **Wells-side 1.0 scope is done — the BOARD Worker-queue is empty.** Frozen tier (A.2) deferred to 1.x — wells runs on owned local hardware, R2 hibernation offload isn't a 1.0 concern. B.1–B.4 moved out of wells's plan (cells-repo + cells-acceptance work). Remaining path to `v1.0.0`: Pete cuts the tag, then `scripts/package-release.sh v1.0.0` attaches the signed engine + menu-bar assets. A cells V1 acceptance run is welcome but not blocking.
**Health:** 🟢 Stable. Welld running clean (`degraded:false`, zero respawns), on the renamed `bin/vwell.app` engine. Test suite 993/0. `main` at `a59afc4`.

## What changed since last STATUS (the 2026-05-14 1.0-readiness pass)

**`lume.app → vwell.app` engine rename (`c7e0855`).** Finished the W.14 rename — the signed `.app` bundle now carries the wells-owned name. The inner Mach-O stays `lume`: it must match the bundle's `CFBundleExecutable` or codesign mis-derives the signing identifier. The first build over-renamed it, AMFI rejected the engine the moment `serve` touched the virtualization entitlement, welld was rolled back onto the known-good bundle within ~6 min (no cells impact), then rebuilt correctly. `well create/exec/destroy` round-trip verified on the renamed engine.

**One-command install (`f7918ac`).** `scripts/install.sh` is the single bootstrap: preflight → engine (local `bin/vwell.app`, or pull the signed bundle from the release) → CLI (`~/.local/bin/well`, paths derived at install time — kills the hand-written hardcoded shim) → dhcp helper → `welld` launchd agent → menu bar → verify. `scripts/package-release.sh` builds + Developer-ID-signs `vwell.app` + `WellsMenuBar.app`, zips them, uploads them as release assets (the signed engine can't be rebuilt on an arbitrary machine, so it ships prebuilt). `package.json` gained a `bin` entry; README's Install section collapsed to one command; `docs/install.md` reframed as the *optional* public-URL bridge.

**Test suite genuinely green (`78b089f`).** `lib/ipPool.test.ts` was 36/3 on any machine with real wells — `currentlyTakenIps` reads the host-global `/var/db/dhcpd_leases`, which the tests couldn't isolate. Added a `dumpLeases` DI seam (prod callers unchanged); the suite went from a false-green claim to actually green.

**W.73 resurrect race closed (`a59afc4`).** Fix (a) — `startWell`'s `waitForSshReady` gate — had shipped 2026-05-12 (`74d58ee`), but it only made a raced resurrect *honest* (a thrown error instead of a silent false-resurrect); the well still just stayed down, because resurrect runs once at startup with no retry. Added `startWithResurrectRetry`: one retry after a 3s settle (matches the observed "revives cleanly via explicit start afterward"). Unit-tested helper. Suite 990 → 993.

## What's stuck

| Item | Why | Who unsticks |
|------|-----|--------------|
| **`v1.0.0` tag cut** | Wells-side scope is complete; cutting the tag + creating the GitHub release is Pete's call. `scripts/package-release.sh v1.0.0` attaches the signed assets once the release exists. | Pete |
| **cells V1 acceptance run** | Cells team's scoring (their suite, their targets). A welcome signal, but **not blocking** wells-side 1.0 — per Pete 2026-05-14, wells isn't waiting on it. | Cells team (optional) |

## What's NOT stuck (cells team can use these now)

- ✅ Steady-state cell ops (create, exec, image save/list, image pull/push to R2).
- ✅ Watchdog autosleep + wake-on-traffic.
- ✅ `/seal` — the post-provision hibernate-legal primitive cells's pool builder bakes on.
- ✅ Hibernate / wake with sibling-survive (W.74).
- ✅ One-command install (`scripts/install.sh`) — engine + CLI + daemon + menu bar, reboot-survivable.
- ✅ Boundary holds — cells `reconcilePool()` shows zero drift across welld bounces.
