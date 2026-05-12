# findings — wake stress (W.10)

**Run:** 2026-05-10T12:21:07.462Z
**Verdict:** PASS
**Cycles:** 30 of 30 completed (0 failures)
**Target welld:** http://127.0.0.1:7879
**Source image:** ubuntu-25.10-base

## Distribution (ms)

| phase            | min      | p50      | p95      | p99      | max      |
| ---------------- | -------- | -------- | -------- | -------- | -------- |
| hibernate        |    191ms |    193ms |    201ms |    217ms |    217ms |
| wake             |    818ms |    826ms |    829ms |    831ms |    831ms |
| ssh-after-wake   |   1128ms |   1143ms |   1147ms |   1210ms |   1210ms |

## Gate results

- p95 wake ≤ 2000ms — PASS
- p95 ssh-after-wake ≤ 2500ms — PASS

## Failures (cycle-level)

_(none)_

## Gate failures

_(none)_

## Per-cycle raw data

| cycle | hibernate | wake | ssh-after-wake |
| ----- | --------- | ---- | -------------- |
| 1 | 193ms | 829ms | 1210ms |
| 2 | 191ms | 822ms | 1132ms |
| 3 | 192ms | 820ms | 1147ms |
| 4 | 194ms | 825ms | 1139ms |
| 5 | 193ms | 826ms | 1143ms |
| 6 | 217ms | 824ms | 1146ms |
| 7 | 195ms | 824ms | 1144ms |
| 8 | 193ms | 827ms | 1141ms |
| 9 | 194ms | 819ms | 1146ms |
| 10 | 193ms | 827ms | 1140ms |
| 11 | 191ms | 828ms | 1147ms |
| 12 | 194ms | 824ms | 1144ms |
| 13 | 193ms | 829ms | 1136ms |
| 14 | 194ms | 822ms | 1143ms |
| 15 | 194ms | 823ms | 1142ms |
| 16 | 193ms | 818ms | 1145ms |
| 17 | 193ms | 822ms | 1142ms |
| 18 | 192ms | 826ms | 1143ms |
| 19 | 200ms | 828ms | 1138ms |
| 20 | 192ms | 826ms | 1142ms |
| 21 | 196ms | 831ms | 1145ms |
| 22 | 195ms | 826ms | 1137ms |
| 23 | 194ms | 829ms | 1134ms |
| 24 | 196ms | 829ms | 1142ms |
| 25 | 193ms | 825ms | 1145ms |
| 26 | 192ms | 827ms | 1128ms |
| 27 | 201ms | 827ms | 1141ms |
| 28 | 193ms | 823ms | 1147ms |
| 29 | 193ms | 826ms | 1144ms |
| 30 | 194ms | 826ms | 1142ms |

## How to read this

- **hibernate** is welld's POST /v1/wells/NAME/hibernate round-trip — wraps lume.saveState (RAM → disk).
- **wake** is welld's POST /v1/wells/NAME/wake round-trip — wraps lume.restoreState (disk → RAM, VM resumes).
- **ssh-after-wake** is host-side ssh probe latency from VM resume to the first successful TCP connect + SSH handshake.

Long tails in **wake** typically indicate lume's @MainActor blocking (W.6 / B.0.9.d.5.b residual) — a slow ARP fallback, slow info() poll, or a single-threaded HTTP handler holding the actor while the next request piles up. Long tails in **ssh-after-wake** with normal **wake** typically indicate networkd-wait-online slowness or sshd slow-start in the guest.

If both **wake** and **ssh-after-wake** spike together on the same cycle, the VM is stuck mid-resume (Apple VZ kernel state churn) — those are the worst hangs.
