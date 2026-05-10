# findings — `well wake` regression: VZ "permission denied" on every restoreState

**Date:** 2026-05-10
**Status:** ACTIVE REGRESSION on `wells-stable-2026-05-10c+d` (graceful-stop-deployed binary). Cells team's wake-on-traffic against any hibernated cell will fail. Severity 🔴.

## Symptom

Every `well wake`, every `from_thaw`, every `lume.restoreState` call returns:

```
{"message": "An error occurred while restoring the virtual machine. The virtual machine failed to restore with error \"permission denied\"."}
HTTP 400
```

Reproducible flow on dev :7879:
1. Create well: `POST /v1/wells {name: foo}` — succeeds, well alive
2. Hibernate: `POST /v1/wells/foo/hibernate` — succeeds, hibernate.bin written
3. Wake: `POST /v1/wells/foo/wake` — **fails with permission denied**

Same fails for `from_thaw` (which calls `lume.restoreState` directly).

## Diagnostic context (lume serve log)

The error originates inside Apple's `restoreMachineStateFrom`, AFTER lume's diagnostic checks pass:

```
INFO: Validating VM disk state diskExists=true diskPermissions=644 dirPermissions=755
INFO: Wrote VZ config snapshot label=restore
INFO: VZ config snapshot match — drift not visible at config level
ERROR: Failed to restore VM state error="permission denied"
```

So:
- Disk file exists, readable, in canonical location
- Bundle dir permissions correct
- Save+restore config snapshots match exactly (no device-graph drift)
- Apple's framework call itself returns the error

## Timeline

- **Before 2026-05-10 ~04:02 UTC:** wake worked normally on stable + dev. Last successful wake transition in welld log: `smoke-6 hibernating → alive_running` at 04:02:10 UTC.
- **2026-05-10 ~07:50 UTC:** `wells-stable-2026-05-10c` promoted with graceful-stop patch (`engine/vwell-src/src/Virtualization/VMVirtualizationService.swift` — `stop()` rewritten with `requestStop()` + state-poll + forceful-fallback). lume rebuilt from `scripts/build-lume.sh`. New `bin/lume.app` deployed.
- **2026-05-10 ~08:36 UTC:** First `from_thaw` test — **WORKED** (HTTP 201, status=running). This was the only thaw success in this entire session.
- **2026-05-10 ~09:03 UTC:** Plain `well wake` on a freshly-hibernated well — **FAILS** "permission denied". All subsequent wake/thaw attempts fail the same way.

## What's NOT the cause

Eliminated by experiments today:

- **Bundle paths.** Tested `~/.lume/<name>/hibernate.bin` (lume canonical) AND `~/.wells-dev/vms/<name>/hibernate.bin` (welld state) — both fail with the same error.
- **File permissions.** hibernate.bin is 0600 owned by `pete` (same UID as lume serve). Bundle dir 0755. All readable.
- **VZ config drift.** lume's diagnostic snapshot diff confirms save vs restore configs are byte-identical (only `label` and `timestamp` differ).
- **Snapshot path encoding.** For `from_thaw`, snapshot paths get rewritten correctly (escaped `\/` form too). Drift count goes to zero. Restore still fails after that.
- **Codesigning entitlements.** `codesign -d --entitlements -` confirms `com.apple.security.virtualization` + `com.apple.developer.networking.vmnet` are both present on the running binary.
- **MAC mutation.** Tested separately; fails with "invalid argument" not "permission denied" (different code path).

## Strongest theory

Graceful-stop patch (commit `7d30cb6`) is the only lume-binary change between "wake worked" and "wake breaks." But the patched code is exclusively in `BaseVirtualizationService.stop()`, not on the wake path. The patch:

1. Polls `virtualMachine.state` until `.stopped` after `requestStop()`
2. Falls through to forceful `virtualMachine.stop()` if requestStop unavailable / times out

Theory: somewhere in the Apple VZ framework, calling `requestStop()` on a VM that's already in `.paused` (post-saveState state) leaves the underlying VZ daemon in an inconsistent state that breaks **subsequent** restores by other VMs in the same lume process. Even though my code's `requestStop()` throws cleanly when called on a `.paused` VM, Apple's framework may have a side-effect.

Or: this isn't about my patch at all, and it's a host-level macOS issue (TCC, codesign cache, VZ daemon state) that flipped sometime around 04:30-08:00 UTC today.

## What to do next fire

1. **Revert hypothesis test.** Branch off, revert `BaseVirtualizationService.stop()` to its pre-graceful-stop body (just the forceful path). Rebuild via `scripts/build-lume.sh`. Restart welld+lume. Test `well create → hibernate → wake`. If it works → graceful-stop is the cause; debug further. If still fails → look at host-level state.

2. **If graceful-stop is the cause:** the v1 fix is to skip `requestStop()` entirely when VM state isn't `.running` AT ENTRY. My current code calls `try virtualMachine.requestStop()` which throws when not running, but the throw might still cause a side effect. Pre-check state and only call requestStop when state == `.running`.

3. **Cells team coordination.** They use wake-on-traffic against hibernated cells. Their bake's birth flow may rely on this for fast warm-cell access. Send a heads-up that wake is currently broken on stable; recommend they keep cells alive until the regression is fixed. Cell-base bake itself (their main blocker) doesn't need wake — it needs save+fork which graceful-stop fixed.

## Current stable status

`wells-stable-2026-05-10d` ships graceful-stop AND broken wake. Trade-off:
- ✅ Save+fork preserves writes (cells team's bake unblock)
- ❌ Wake broken (any hibernated cell can't be revived)

If wake-on-traffic is in cells team's hot path, this is a blocker. If their flow only uses wake during testing, less urgent. Pete needs to weigh in before next stable promotion.
