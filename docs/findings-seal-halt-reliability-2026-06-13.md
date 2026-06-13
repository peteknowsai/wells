# findings — seal's sysrq halt timed out ~25×/day ("disk still held within 60000ms")

**Date:** 2026-06-13
**Status:** root cause confirmed, fix shipped on `fix/seal-halt-reliability`, empirically validated on a live egg (real `haltGuestForSeal` rescues both injected prod failure modes). wells lib tests: 1050 pass.

## Symptom

Cells' pool bake (`bakePoolMember` → `POST /v1/wells/:name/seal`) failed at the **seal** stage ~25 times on 2026-06-13 alone (every entry in `~/.cells/logs/bake-failures/` was `stage=seal`). The error, verbatim:

```
seal 'egg-XXXXXX' failed: 500 {"error":"seal_failed",
  "message":"disk /Users/pete/.lume/egg-XXXXXX/disk.img still held within 60000ms"}
```

The pool floor protection masked it (the pool never emptied), but every failure burned a full create + cloud-init + provision (~8.2 GB on disk, ~2.5 min wall) and threw it away.

Forensics in each bake-failure JSON split cleanly into two signatures:

- **`own=true` (14/27):** the egg's *own* VZ XPC process was still holding `disk.img`, and welld reported the well `status: running`, a full 60 s after the "halt" — the guest never powered off.
- **`own=false`/no-holder (13/27):** by the time forensics ran (just after the 500), the disk had *already* been released — a slow teardown that crossed the 60 s line under load.

Both at vz=4–10 concurrent VMs (the live fleet + the baking VM), `disk_used ≈ 8.2 GB`, fail ≈ 140–180 s into the bake.

## Root cause

`lib/lifecycle.ts` `sealWell()` halted the guest with a single best-effort SSH:

```ts
const shutdownProc = spawn(["ssh", …, `root@${ip}`,
  "sync && echo s > /proc/sysrq-trigger && echo o > /proc/sysrq-trigger"],
  { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
await shutdownProc.exited;            // exit code IGNORED, no overall timeout
await waitForDiskReleased(bundleDisk, 60_000);   // flat 60s, then hard-fail
```

sysrq is **guest-cooperative and best-effort**. Two ways it leaves the disk held:

1. **The SSH never lands.** Under host I/O contention the connect (`ConnectTimeout=4`) or auth can fail. The exit code was discarded, so this was invisible: the halt simply never happened and we waited 60 s on a fully-running VM (the `own=true` signature).
2. **sysrq-o doesn't tear the VM down.** The write to `/proc/sysrq-trigger` returns *before* the async poweroff, so the shell exits 0 even though the guest then fails to actually power off (or does so slowly under load). Nothing escalated; we waited 60 s.

Note a subtlety that shaped the fix: a *successful* sysrq returns ssh **exit 0** (the write returns before the poweroff). So exit 0 ≠ "VM is down", but a **non-zero** exit reliably means "halt never landed."

## Measurements

`scripts/exp-seal-halt.ts` cycled one live egg (4 vCPU / 1 GB) through each strategy, timing `halt-issued → lsof shows disk free`, at vz=8 under 3 synthetic host I/O writers (`--load=3`), 8 trials each:

| strategy   | p50    | p90    | max    | notes |
|------------|--------|--------|--------|-------|
| `sysrq`    | 0.97 s | 5.4 s  | 5.4 s  | fast, but degrades with load; no escalation |
| `lume.stop`| 14.0 s | 15.0 s | 15.0 s | host-controlled ACPI shutdown — reliable, always ~14 s |
| **hybrid** | **1.3 s** | 5.7 s | 5.7 s | sysrq fast-path, all 8 trials stayed on it |

Pure `lume.stop` is **11× slower** at p50, so abandoning sysrq entirely was the wrong trade. The Mini's current headroom meant `sysrq` didn't organically hit the 60 s wall in the lab, so the two prod failure modes were **injected** into the real `haltGuestForSeal` (`scripts/exp-seal-halt-validate.ts`):

| case | inject | result (new code) | old code |
|------|--------|-------------------|----------|
| healthy | real sysrq | `path=sysrq`, disk free **0.5 s** | 0.5 s |
| ssh never lands (`own=true`) | sysrq → exit 255 | `path=fallback/ssh_failed`, disk free **8.8 s** | **60 s hard fail** |
| delivered, no teardown (`own=true`) | real `ssh true` (exit 0, no halt) | `path=fallback/disk_held`, disk free **14.1 s** | **60 s hard fail** |

## Fix

`lib/sealHalt.ts` — a two-stage halt, host-controlled fallback:

1. **Fast path:** the same sysrq sync+halt, now bounded by a 12 s SSH timeout.
2. **Escalate** if the SSH exits non-zero (never landed → escalate immediately) or the disk isn't free within an 8 s window (delivered but no teardown) → `stopWell()`, i.e. `lume.stop()`: ACPI shutdown with a 30 s → forceful backstop. lume owns the VM handle, so this kills the process regardless of guest state.

Both paths flush before teardown — the fast path's `sync`, the fallback's systemd shutdown — so the sealed disk stays consistent. The escalation logic is pure control flow over injected effects (`SealHaltDeps`), unit-tested without VMs (`lib/sealHalt.test.ts`). `lib/diskReleased.ts` gained `isDiskReleased` + a non-throwing `diskReleasedWithin` (the fast-path probe); `waitForDiskReleased` keeps its throwing contract for `zombie.ts` and the fallback.

`SEAL_HALT` constants (`SSH_TIMEOUT_MS` 12 s, `FAST_WAIT_MS` 8 s, `FALLBACK_RELEASE_MS` 30 s) are tunable in one place. `FAST_WAIT_MS` is sized just above the observed loaded-happy-path tail (~5.4 s) so a merely-slow release doesn't escalate; escalating early is always *safe* (it only costs a ~10 s lume.stop), so the bias is correct.

## Why not at the admission layer

The contention that triggers this is real (the failure clusters at vz=8–10), and `lib/admission.ts` already paces *boots*. But the seal's disk-release wait is *before* its restart, so boot-gating doesn't cover it; and seal must be robust to whatever load exists when it runs. Making the halt itself host-controlled is the right layer. Reducing concurrent boots during bake would lower the trigger rate but wouldn't make a guest-cooperative halt reliable.
