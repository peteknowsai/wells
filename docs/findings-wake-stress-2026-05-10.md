# findings — wake stress (W.10)

**Run:** 2026-05-10T09:42:46.536Z
**Verdict:** FAIL
**Cycles:** 0 of 30 completed (30 failures)
**Target welld:** http://127.0.0.1:7879
**Source image:** ubuntu-25.10-base

## Distribution (ms)

| phase            | min      | p50      | p95      | p99      | max      |
| ---------------- | -------- | -------- | -------- | -------- | -------- |
| hibernate        |      0ms |      0ms |      0ms |      0ms |      0ms |
| wake             |      0ms |      0ms |      0ms |      0ms |      0ms |
| ssh-after-wake   |      0ms |      0ms |      0ms |      0ms |      0ms |

## Gate results

- p95 wake ≤ 2000ms — PASS
- p95 ssh-after-wake ≤ 2500ms — PASS

## Failures (cycle-level)

- cycle 1: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 2: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 3: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 4: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 5: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 6: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 7: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 8: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 9: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 10: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 11: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 12: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 13: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 14: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 15: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 16: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 17: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 18: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 19: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 20: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 21: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 22: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 23: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 24: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 25: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 26: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 27: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 28: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 29: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}
- cycle 30: POST /v1/wells/wake-stress/wake → 500: {"error":"wake_failed","message":"lume POST /lume/vms/wake-stress/restore-state → 400: {\"message\":\"An error occurred while restoring the virtual machine. The virtual machine failed to restore with error “permission denied”.\"}"}

## Gate failures

_(none)_

## Per-cycle raw data

| cycle | hibernate | wake | ssh-after-wake |
| ----- | --------- | ---- | -------------- |


## How to read this

- **hibernate** is welld's POST /v1/wells/NAME/hibernate round-trip — wraps lume.saveState (RAM → disk).
- **wake** is welld's POST /v1/wells/NAME/wake round-trip — wraps lume.restoreState (disk → RAM, VM resumes).
- **ssh-after-wake** is host-side ssh probe latency from VM resume to the first successful TCP connect + SSH handshake.

Long tails in **wake** typically indicate lume's @MainActor blocking (W.6 / B.0.9.d.5.b residual) — a slow ARP fallback, slow info() poll, or a single-threaded HTTP handler holding the actor while the next request piles up. Long tails in **ssh-after-wake** with normal **wake** typically indicate networkd-wait-online slowness or sshd slow-start in the guest.

If both **wake** and **ssh-after-wake** spike together on the same cycle, the VM is stuck mid-resume (Apple VZ kernel state churn) — those are the worst hangs.
