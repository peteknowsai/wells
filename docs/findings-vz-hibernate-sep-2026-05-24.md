# VZ hibernate-restore "permission denied" = Secure Enclave ACL, not VZ state

**Date:** 2026-05-24
**Status:** Root cause identified. Open question on remediation strategy.

## TL;DR

Apple's `VZVirtualMachine.restoreMachineStateFrom` decrypts hibernate metadata via a
Secure Enclave P-256 ECDH key. That key has an access-control flag (`aku`) that requires
user authentication. **When the Mac's screen is locked, the SEP refuses the ECDH
operation, and VZ surfaces it as `VZErrorRestore` "permission denied".**

This is what's been showing up as "intermittent VZ hibernate-restore failures". It is
not a VZ kernel-state leak, not a memory-pressure issue, not an XPC child lifecycle bug.
Every reproduction effort on dev failed because dev tests ran while Pete was at the Mac.

## In plain English

Pete's Mac Mini runs as a server. When Pete walks away for the night the screen locks.
Apple's hibernate framework was designed for laptops where the user is present, so it
treats restoring a hibernated VM as a sensitive operation that needs user-authentication.
The Secure Enclave refuses, hibernate-restore fails, and any well that needs to wake
during that window can't.

## Evidence

### Reproduction
- 2026-05-24T10:00:02Z (UTC): cells's scheduled top-of-hour wake hit 3 hibernating wells.
  All 3 failed within 2 seconds. The wake-fail diag instrumentation (`lib/wakeFailDiag.ts`)
  captured 12-file bundles per failure to `~/.wells/diag/wake-fail-<name>-<iso>/`.
- I manually retried 3 more hibernating wells immediately after — all 3 failed identically.
- 6/6 hibernating wells fail; 5/5 running wells continue to work normally.

### The underlying error

`/usr/bin/log show --predicate 'eventMessage CONTAINS "sepk:p256"'`:

```
ctkd[681] [com.apple.CryptoTokenKit:sepkey]
  <sepk:p256(u) kid=03917f9142385e07>:
  (com.apple.Virtualization.VirtualMachine<26934>)
  unable to compute shared secret:
  error e00002e2(-536870174)
  ACL=<SecAccessControlRef: aku;ock(true);odel(true);osgn(true);oa(true);okd(true)>
  params=<AKSp:{acmh:###,ag:[]}>

com.apple.Virtualization.VirtualMachine[26934]:
  SecKeyCreateDecryptedDataWithParameters failed:
  Error Code=-25308 "<sepk:p256(u) kid=03917f9142385e07>: unable to compute shared secret"
  AKSError=-536870174
```

- `kAKSReturnNotPrivileged` (-536870174) → AppleKeyStore refuses
- `errSecInteractionNotAllowed` (-25308) → SecKey surfaces it
- `VZErrorRestore` "permission denied" → VZ wraps it for the caller

### Why "intermittent"

| Time (UTC)             | State                       | Wake outcome |
|------------------------|-----------------------------|--------------|
| 2026-05-23T15:02–21:23 | Pete actively on Mac        | 18 wakes OK  |
| 2026-05-24T00:43       | Pete walks away → screen locks |           |
| 2026-05-24T10:00       | Scheduled wake — 9h locked  | **6/6 FAIL** |

`CGSessionScreenIsLocked = 1` since `2026-05-24T00:43:06Z`. Same SEP key kid
`03917f9142385e07` has been failing intermittently in `log show` since at least
`2026-05-23T12:13` — same pattern, correlated with idle/locked periods.

The "self-healing" Pete observed previously: Pete returns to the Mac → screen unlock
re-establishes user authentication → SEP accepts the ECDH operation → wakes start
working again.

### Why dev couldn't reproduce

Three-phase investigation on `~/.wells-dev` (2026-05-23) ran loops while Pete was at
the Mac:

- Baseline (100 cycles 1 VM): 100/100 PASS
- No XPC kill: 0/11 — different failure mode (storage device invalid)
- SIGTERM: 50/50 PASS
- Zero settle: 100/100 PASS
- Multi-VM concurrent: 240/240 PASS

The bug cannot be reproduced while the screen is unlocked, regardless of XPC handling,
concurrency, or signal type. Every dev variant ran with screen unlocked.

## What this means for Wells / cells

- **Pool refill that schedules wakes while Pete is asleep will systematically fail.**
  Cells's hourly refill at the top of every hour is the exact trigger pattern that
  surfaced this bug today.
- **The "warm pool" model is fundamentally fragile on a Mac with screen lock.**
  Wells can't promise wake-from-hibernate while the user isn't present.
- **Cold-start (no hibernate) is unaffected** — it doesn't go through this restore path.
  But cold-start is 30s+ instead of 1–2s, which is the whole reason hibernate exists.

## Remediation paths (need decision)

**A. Disable screen lock on the Mac Mini.** System Settings → Lock Screen → Require
   password = Never. Pete's Mini already has `SleepDisabled=1` and `sleep prevented by
   caffeinate`. If the screen never locks, the SEP key stays accessible.
   - Pro: zero code change, fully restores hibernate
   - Con: physical security regression — anyone with hands on the Mini has free shell
   - Risk: Pete forgets and re-enables it later

**B. Auto-unlock workaround.** Use `security unlock-keychain -p` from a launchd job to
   force-unlock the login keychain on schedule.
   - Pro: keeps screen lock enabled
   - Con: requires password in plaintext on disk; may not even fix the SEP ACL, since the
     ACL is about CGSession lock state not keychain lock state
   - Risk: probably doesn't work — the constraint is `kCGSessionScreenIsLocked`, not
     keychain state

**C. Stop using Apple's hibernate.** Replace `saveMachineStateTo`/`restoreMachineStateFrom`
   with disk-only snapshots (we already have `/seal` for this). Wells's `hibernate` becomes
   "stop with disk preserved" instead of "save memory state".
   - Pro: no SEP dependency, works headless
   - Con: cold-start latency (30s+) instead of warm-restore (1–2s) — kills the warm pool's
     latency target
   - Risk: cells V1 latency targets become unreachable on Mac

**D. Engine switch.** Move stable to Linux + Firecracker/QEMU. Hibernate works without
   SEP on Linux.
   - Pro: production target anyway per `wells_multi_engine`
   - Con: significant work; doesn't solve dev-on-Mac

## Recommended next step

Pete decides between A and C. A is the immediate fix (one System Settings change) and
preserves the warm-pool latency model. C is the principled answer that survives every
"Pete walked away" but throws away the latency.

Probably **A as a tactical fix** to unblock cells's pool refill today, with C/D as the
strategic answer for V1 hardening.

## Files

- `lib/wakeFailDiag.ts` — diag capture hook in `wakeWell`
- `lib/lifecycle.ts:wakeWell` — try/catch wraps `lume.restoreState` and calls
  `captureWakeFailDiag` on failure
- `~/.wells/diag/wake-fail-<name>-<iso>/` — captured bundles (12 files per failure)
- `docs/findings-vz-leak-investigation-2026-05-23.md` — the three-phase dev investigation
  that failed to reproduce and led us here
