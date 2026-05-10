# Findings: forks from saved images (cells team blocker #2 follow-up)

**Date:** 2026-05-09
**Author:** wells team
**Status:** Workaround verified, permanent fix queued.

## Problem

Cells team's bake produces `cell-base` by saving the disk of a wells-created
well after applying their patches. Forks from `cell-base` were unreliable:
sometimes hung on first-boot DHCP, sometimes hung after first-boot SSH
during the warming-restart phase. The earlier fix (drop
`ConditionPathExists=!/etc/.well-ready` from `well-firstboot.service`,
shipped in `eeb1401`) was necessary but not sufficient.

## Root cause

The wells warming sequence regenerates `/etc/machine-id` so the second
boot of a freshly-created well gets a new DHCP DUID (different IP from the
first-boot lease). When cells team's bake saves that warmed disk, the
**baked-in machine-id** is now part of the image. Every fork from this
image starts boot with the same machine-id, then well-firstboot
regenerates it during identity injection — but only **after**
`network-online.target`, which means systemd-networkd has already done
DHCP using the stale DUID.

Symptoms observed in dev welld reproduction:

- 1/3 forks: hung at warming-restart's `waitForSshReady` (60s+)
- 2/3 forks: lume serve crashed mid-warming-restart with concurrent forks
- Welld's lume client has no fetch timeout, so a stuck request hung welld
  indefinitely until lume's supervisor detected and respawned

## Verification

Reproduced on dev welld with synthetic test-cellbase (= ubuntu-25.10-base
+ warming + dummy patches). 3/3 forks failed.

After cleaning the source disk via SSH before save:

```bash
sudo bash -c '
  rm -rf /var/lib/systemd/network/*
  rm -f /etc/machine-id
  touch /etc/machine-id
  rm -f /etc/.well-ready
'
sudo shutdown -h now
```

Forks worked: 1/1 (limited test). Each fork got fresh hostname,
machine-id, and SSH keys.

## Workaround for cells team (immediate)

Append the cleanup block above to your bake just before `wells save-image`.
The well must be cleanly shut down after the cleanup (the cleanup itself
won't matter if the bake snapshots a still-running disk).

This supersedes the previous `rm /etc/.well-ready` workaround — drop that
one and use the new block instead.

## Permanent fix (wells side, queued)

Add a "rinse" routine to wells's saveImage flow:

1. Boot the source well (if stopped).
2. SSH in and run the cleanup commands above.
3. Clean shutdown via SSH.
4. saveImage clonefiles the now-rinsed disk.
5. Set `rinsed: true` in `meta.json` (re-purpose the existing field —
   the old "rinsed = cloud-init purged = broken" semantic is moot
   now that cloud-init is gone).

API: `POST /v1/wells/images` with optional `rinse: true` (default true)
to make this opt-out for any future legitimate non-rinsed save case.

This will let cells team drop the manual cleanup block.

## Secondary findings

While reproducing, surfaced two other small issues to track:

1. **lume client has no fetch timeout** — when lume serve hangs, welld's
   create flow blocks indefinitely with no log line. Add a per-request
   timeout (default 30s) in `engine/vwell.ts` request method.

2. **lume serve crashes under concurrent forks** — second + third
   simultaneous forks killed lume serve. Welld's supervisor respawned
   it, but the in-flight forks hung. Investigate whether VZ.framework
   has concurrent-create bottlenecks or if the issue is lume's bundle
   creation race (the same race the dirname mkdir in `createWell.ts`
   was added to mitigate).

## Inside + outside debugging

Pete's framing — observe inside the guest AND outside on the host
simultaneously — was decisive. Inside-only (post-mortem journal) would
have missed the host-level lume and DHCP state. Outside-only (welld log)
would have missed the per-fork machine-id evidence.

Recipe for next investigations of similar shape:

- Outside: tail welld log + lume serve log + `/var/db/dhcpd_leases`
  watcher in parallel
- Inside: SSH in and grab `journalctl -u systemd-networkd -u ssh -u
  well-firstboot.service`, `ip addr`, `cat /etc/machine-id`,
  `systemctl is-system-running` immediately after the failure (or while
  it's mid-failure if SSH still works)
- Post-failure: if the well is destroyed during rollback, save its
  bundle's `disk.img` first (`cp -c` is sub-second) so we can mount
  later if needed
