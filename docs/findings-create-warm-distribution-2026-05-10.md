# findings — create+warm distribution (W.6 / B.0.9.d.5.b)

**Run:** 2026-05-10T06:53:47.901Z
**Inputs:** /Users/pete/.wells/welld.log, /Users/pete/.wells-dev/welld.log
**Period:** 2026-05-09T21:05:05.014Z → 2026-05-10T06:21:33.082Z
**Sample size:** 90 profiles (63 stable, 27 dev)

## Total create time

| metric           | count |     min |    mean |     p50 |     p95 |     p99 |     max |
| ---------------- | ----: | ------: | ------: | ------: | ------: | ------: | ------: |
| total            |    90 |   10051ms |   16599ms |   14538ms |   27130ms |   83703ms |   83703ms |

## Per-phase delta (ms each phase took)

| phase            | count |     min |    mean |     p50 |     p95 |     p99 |     max |
| ---------------- | ----: | ------: | ------: | ------: | ------: | ------: | ------: |
| vmDir            |    90 |       0ms |       0ms |       0ms |       1ms |       1ms |       1ms |
| seed             |    90 |      14ms |      22ms |      21ms |      31ms |      48ms |      48ms |
| lumeCreate       |    90 |       2ms |     415ms |       2ms |       4ms |   13545ms |   13545ms |
| waitStopped      |    90 |       5ms |       8ms |       7ms |      11ms |      21ms |      21ms |
| clonefile        |    90 |       1ms |       2ms |       2ms |       3ms |       4ms |       4ms |
| truncate         |    90 |       1ms |       1ms |       1ms |       2ms |       4ms |       4ms |
| lumeStart1       |    90 |       1ms |       2ms |       2ms |       3ms |       3ms |       3ms |
| waitRunning1     |    90 |       9ms |      13ms |      13ms |      16ms |      18ms |      18ms |
| dhcp1            |    90 |    4002ms |    4004ms |    4004ms |    4006ms |    4007ms |    4007ms |
| ssh1             |    90 |     506ms |    1498ms |    1541ms |    2093ms |    2281ms |    2281ms |
| shutdownSent     |    90 |     104ms |     117ms |     117ms |     127ms |     137ms |     137ms |
| diskReleased     |    90 |     322ms |    3386ms |    3867ms |    6421ms |   14443ms |   14443ms |
| lumeStart2       |    90 |       2ms |     229ms |       2ms |       6ms |    8579ms |    8579ms |
| waitRunning2     |    90 |       6ms |     897ms |       7ms |      11ms |   34052ms |   34052ms |
| dhcp2            |    90 |    4001ms |    4894ms |    4004ms |    4006ms |   44042ms |   44042ms |
| ssh2             |    90 |     472ms |    1112ms |    1124ms |    1570ms |    1724ms |    1724ms |

## Long tail finding

The phase carrying the largest p95 contribution is **`diskReleased`** at 6421ms p95.

Knowing the createWell.ts mark() sequence, this maps to:
**VZ disk release** (`waitForDiskReleased`, polls lsof on the bundle disk). Long tail suggests the guest didn't sysrq-halt cleanly — kernel write flush stalled, or sysrq is disabled in the kernel and we're falling through to a longer disk-release timeout.

## Reading the columns

- `vmDir`, `seed`, `lumeCreate`, `waitStopped`, `clonefile`, `truncate` — host-side setup. Tens of ms typical, no VM running yet.
- `lumeStart1`, `waitRunning1` — first lume.start (with cidata mount). lume HTTP roundtrip; ~50–100ms.
- `dhcp1` — first-boot DHCP wait. Should be 4–6s on a clean substrate; >10s suggests vmnet pressure or the DHCP-DUID-collision pattern.
- `ssh1` — first SSH-ready wait after first boot. ~1s typical.
- `shutdownSent` — sysrq fast-halt SSH. ~100ms.
- `diskReleased` — wait for VZ to fully release the bundle disk after halt. 1–4s typical.
- `lumeStart2`, `waitRunning2` — second lume.start (without cidata, "warming-restart"). ~50ms.
- `dhcp2` — second-boot DHCP wait. **Headline regression detector**: should be near-zero with dhcp-identifier:mac in the base image, but if cloud-init isn't disabled this stretches into multi-second territory.
- `ssh2` — second SSH-ready wait. ~1s typical.

## Where the next round of optimization work should go

(a) If the long-tail phase is **`dhcp1`** or **`dhcp2`**, the next move is finishing the cidata-seal / cloud-init-disable plan (B.0.9.d.2 in MVP-PLAN). Detached.

(b) If it's **`waitRunning1`** or **`waitRunning2`**, that's lume.info() polling — points at lume @MainActor variance. Cross-reference `/tmp/lume-hang-*` samples to nail the call site. Aligns with W.7 (lume @MainActor fix).

(c) If it's **`diskReleased`**, we're spending budget watching VZ flush the disk. Already optimized to sysrq+poweroff, so further wins probably require a lume-side change (e.g., expose bundle.lock state).

(d) If it's **`clonefile`**, the base image is too big or APFS clonefile isn't actually being used — investigate.

## How to interpret outliers

p99 / max values that diverge sharply from p95 mean a small number of forks took dramatically longer. That's exactly the W.6 long-tail variance pattern. To find which fires hit the tail:

```
grep "create: profile" ~/.wells/welld.log ~/.wells-dev/welld.log \
  | jq -r 'select(.totalMs > NNNN) | .ts + " " + (.totalMs | tostring) + "ms"' | sort
```

(replace NNNN with whatever threshold you care about; e.g., > p95).

## What this analysis can't tell us

- **First-create-on-fresh-host cost** — most profiles are warm-start, after lume + base image are cached. The first cold create on a freshly-restarted Mac may have different timing.
- **Concurrent-fork variance** (W.13) — profiles are per-fork totals; concurrent fan-out adds contention not captured here.
- **Pool-adopt path latency** — adoption is a different code path (~2-3s end-to-end) that doesn't emit `create: profile`. The pool smoke (smoke-warm-pool, smoke-pool-churn) covers that.

## Reproducing

```
bun run scripts/analyze-create-profile.ts \
  [--logs=PATH1,PATH2] [--since=2026-05-09] \
  [--report=docs/findings-create-warm-distribution.md]
```
