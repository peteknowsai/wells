# findings — `well wake` regression: VZ "permission denied" on every restoreState

**Date:** 2026-05-10
**Status:** ✅ RESOLVED 2026-05-10 ~12:18 UTC by host reboot. Pete restarted the Mac; first post-reboot wake on dev (`wake-postreboot` well) succeeded in 839ms. Wake-stress smoke: 30/30 cycles passed (hibernate p95 201ms, wake p95 829ms, ssh-after-wake p95 1147ms). Confirms the original hypothesis: the regression sat in macOS-side state (VZ daemon / TCC / accumulated lume process state across the session's many killAndRestart cycles), not in our code. Graceful-stop stays in place.

Original investigation preserved below for future reference if a similar regression appears.

---

## Original investigation (active 2026-05-10 ~04:30 → ~12:18 UTC)

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

## Hypothesis tested 2026-05-10 ~09:11 UTC: graceful-stop NOT the cause

**Procedure:** Branched off `feature/phase-a`. Reverted `BaseVirtualizationService.stop()` to its pre-graceful-stop body (just the forceful `virtualMachine.stop` call, no `requestStop`). Rebuilt lume via `scripts/build-lume.sh` (signed). Killed dev welld + dev lume serve. Restarted both. Verified the binary `strings` output no longer contained `requestStop|graceful` markers. Created fresh well, wrote marker, hibernated, attempted wake.

**Result:** wake STILL fails with the same VZ "permission denied" error. Reverting graceful-stop did not fix the regression.

So graceful-stop is innocent. The regression sits below us in the stack — likely Apple's VZ framework, the host-level VZ daemon, or some accumulated lume process state across the multiple killAndRestart cycles this session has triggered.

After confirming graceful-stop is innocent, restored the patch in source and rebuilt so stable's bake-write-persistence fix stays in the deployed binary.

## Update 2026-05-10 ~09:40 UTC — error message varies

Tested wake on a fresh well via welld AND directly via lume HTTP (bypassing welld's wake actuator):
- welld → `well wake wake-test-2`: lume returns `400` with `"permission denied"`
- direct curl → `POST /lume/vms/direct-test/restore-state {"path": ".../hibernate.bin"}`: lume returns `400` with `"Invalid virtual machine configuration. The storage device attachment is invalid."`

Same lume process, same lume HTTP endpoint, same body shape (just `{path}`). Different errors at different times. This suggests the underlying VZ failure mode is sensitive to state we don't see — VM-specific cache, VZ daemon state, or per-bundle history.

The "storage device attachment is invalid" error is Phase 1 v1-v3 territory (see `docs/findings-thaw.md`) — VZ doesn't believe the rebuilt disk attachment matches what the saved state expects. The "permission denied" is more opaque and may be a downstream of the same drift.

## Other hypotheses (untested, ranked by plausibility)

1. **Lume serve process accumulates VZ state.** Each kill+respawn might leave a stuck VZ daemon connection. The fact that fire 5's first thaw worked (immediately after a fresh `activate-signing.sh` rebuild + welld restart) and ALL subsequent restores fail is consistent with this.

2. **Apple's VZ daemon has a per-process or per-pid state map.** When a lume process exits unclean (SIGKILL by supervisor), the VZ daemon may keep that process's saved-state references in a "tombstoned" state until host restart.

3. **TCC / codesign cache.** macOS may be denying access to `~/.wells-dev/` or `~/.lume/` based on a stale TCC entry. Re-prompting the user usually requires reboot.

4. **macOS background update / process churn.** Some system service was upgraded during this session and broke VZ for our binary. Unlikely without explicit notification but possible.

## What to do next fire

Graceful-stop hypothesis ruled out. Investigation order:

1. **Test wake on stable :7878 directly.** Stable's lume serve has been alive since 02:22 UTC (PID 48720) — same process the entire session. If stable's wake works on a brand-new well, the issue is dev-side lume process state pollution. If stable's wake also fails, it's host-level. (Operator-only; don't perturb existing cells team wells.)

2. **Reboot the host machine.** If Apple's VZ daemon or TCC state is stuck, only a reboot clears it. This is the cheapest "is it host-level" check available — but requires Pete's call (cells team work disrupted; brief downtime).

3. **Consultant ping.** If after reboot wake still fails, that's strong evidence of a code-path bug we missed. Time to pull in cells team for a second read of `engine/vwell-src/src/VM/VM.swift:639-740` (the restoreState path).

4. **Cells team coordination.** They use wake-on-traffic against hibernated cells. Their bake's birth flow may rely on this for fast warm-cell access. Send a heads-up that wake is currently broken on stable; recommend they keep cells alive until the regression is fixed. Cell-base bake itself (their main blocker) doesn't need wake — it needs save+fork which graceful-stop fixed.

## Current stable status

`wells-stable-2026-05-10d` ships graceful-stop AND broken wake. Trade-off:
- ✅ Save+fork preserves writes (cells team's bake unblock)
- ❌ Wake broken (any hibernated cell can't be revived)

Reverting graceful-stop will NOT restore wake (verified) and would only re-break cells's bake. So no point reverting. Forward fix needs a different intervention (likely a host reboot first, then re-test).

If wake-on-traffic is in cells team's hot path, this is a blocker. If their flow only uses wake during testing, less urgent. Pete needs to weigh in.
