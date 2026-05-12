# findings — concurrent fork crash threshold (W.13 / B.0.11.d)

**Run:** 2026-05-10T09:32:57.858Z
**Target:** http://127.0.0.1:7879
**Image:** ubuntu-25.10-base
**Range:** 4, 5, 6
**Crash threshold:** N=5 (lume_respawned=false, 1/5 forks failed)

## Summary

| N | success | client_err | server_err | timeout | lume_respawned | vz_xpc Δ | hang files |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 4 | 4 | 0 | 0 | 0 | — | +4 | 0 |
| 5 | 4 | 1 | 0 | 0 | — | +5 | 0 |
| 6 | 4 | 2 | 0 | 0 | — | +6 | 0 |

## Per-round detail

### N=4 (2026-05-10T09:28:08.295Z → 2026-05-10T09:28:53.382Z)

- lume PID: 48265 → 48265
- respawns_last_1min: 0 → 0
- vz_xpc_count: 0 → 4
- pre-burst sample: /tmp/exp-ccfork-pre-N4-48265.txt
- no lume-hang dumps during round

| name | status | duration | ip / error |
| --- | --- | ---: | --- |
| ccfork-lbms-4-1 | success | 11796ms | 192.168.64.21 |
| ccfork-lbms-4-2 | success | 13642ms | 192.168.64.24 |
| ccfork-lbms-4-3 | success | 11738ms | 192.168.64.23 |
| ccfork-lbms-4-4 | success | 11730ms | 192.168.64.22 |

### N=5 (2026-05-10T09:28:55.384Z → 2026-05-10T09:30:54.595Z)

- lume PID: 48265 → 48265
- respawns_last_1min: 0 → 0
- vz_xpc_count: 0 → 5
- pre-burst sample: /tmp/exp-ccfork-pre-N5-48265.txt
- no lume-hang dumps during round

| name | status | duration | ip / error |
| --- | --- | ---: | --- |
| ccfork-mbyu-5-1 | success | 12108ms | 192.168.64.28 |
| ccfork-mbyu-5-2 | success | 11537ms | 192.168.64.27 |
| ccfork-mbyu-5-3 | success | 11651ms | 192.168.64.26 |
| ccfork-mbyu-5-4 | success | 12611ms | 192.168.64.25 |
| ccfork-mbyu-5-5 | client_error | 90551ms | POST /v1/wells → 400: {"error":"create_failed","message":"no DHCP lease for hostname 'ccfork-mbyu-5- |

### N=6 (2026-05-10T09:30:56.597Z → 2026-05-10T09:32:55.857Z)

- lume PID: 48265 → 48265
- respawns_last_1min: 0 → 0
- vz_xpc_count: 1 → 7
- pre-burst sample: /tmp/exp-ccfork-pre-N6-48265.txt
- no lume-hang dumps during round

| name | status | duration | ip / error |
| --- | --- | ---: | --- |
| ccfork-oxha-6-1 | client_error | 90574ms | POST /v1/wells → 400: {"error":"create_failed","message":"no DHCP lease for hostname 'ccfork-oxha-6- |
| ccfork-oxha-6-2 | success | 11603ms | 192.168.64.9 |
| ccfork-oxha-6-3 | client_error | 90557ms | POST /v1/wells → 400: {"error":"create_failed","message":"no DHCP lease for hostname 'ccfork-oxha-6- |
| ccfork-oxha-6-4 | success | 12161ms | 192.168.64.29 |
| ccfork-oxha-6-5 | success | 12395ms | 192.168.64.31 |
| ccfork-oxha-6-6 | success | 12367ms | 192.168.64.30 |


## How to read this

- **Crash threshold** is the smallest N where either (a) lume serve respawned during the round (supervisor SIGKILL'd it), or (b) at least one fork failed with a 5xx / timeout. Below the threshold the path is solid; at and above, pool fan-out + cells team scale-out can hit it.
- **vz_xpc Δ** > 0 after a round suggests orphan VZ children — VMs that lume didn't reap. Should be 0 on a clean round (every well destroyed before the next round).
- **hang files** are /tmp/lume-hang-*.txt stack samples the supervisor captured pre-respawn (B.0.11.h). When present, read them alongside the pre-burst sample to see what changed in the call stack.
- **server_error** typically maps to "lume returned 500 / 4xx" — bundle creation race or VZ.framework constraint. **timeout** maps to "welld saw the request stall past its inner deadlines" — usually the @MainActor block.

## Reproducing

```
bun run scripts/exp-concurrent-fork.ts --range=2,3,4,5,6 --keep
```

`--keep` leaves wells in place between rounds so you can SSH in and inspect; default behavior cleans up so each N starts on the same baseline. Stable :7878 is off-limits — only run against dev :7879.
