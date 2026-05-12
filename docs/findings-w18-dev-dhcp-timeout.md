# findings — W.18 dev welld DHCP timeout investigation

**Status:** root cause not nailed; strongest theory is lume-hang aftermath. **Stable :7878 unaffected** — cells team continues to use it without issue. This blocks W.2 (R2 round-trip smoke) live-verify and W.6 (Lume @MainActor variance stress) on dev.

## Symptom

`well create --from-image ubuntu-25.10-base` against dev welld :7879 hangs at `waitForDhcpLease` for the full 90s timeout, then welld 400s the create with:

```
no DHCP lease for hostname '<name>' within 90000ms — lume.info: status=running ip=(none); recent leases: name=rinse-fork ip=192.168.64.235 ...
```

Welld then rolls back the registry entry, but **lume keeps the VM alive** — leaves a zombie that has to be stopped manually (`POST /lume/vms/<name>/stop`).

## Timeline (2026-05-10 UTC)

| Time | Event |
|------|-------|
| 03:38:14 | Last successful create on dev: pool-adopt of `warm-moz830fb`, 2225ms, IP .226 |
| 03:39:50 | Pool fill `pool-e8d2fff3` fails — DHCP timeout |
| 03:41:00 | poolFiller hatch fails — same DHCP timeout |
| 03:41:46 | **Lume serve unresponsive — supervisor SIGKILLs + respawns.** Stack sample at `/tmp/lume-hang-1778384506009-pid21930.txt` |
| 03:59:31 | Lume serve unresponsive #2. Sample at `/tmp/lume-hang-1778385571288-pid26530.txt` |
| 04:29-04:31 | Multiple `cell sleep failed` for `smoke-8` — well stopped, watchdog still trying to hibernate |
| 05:30 | Dev welld manually restarted by Pete |
| 05:56:06 | My `r2smokezd0mte` create — fails DHCP timeout |
| 06:01:05 | My `r2smokezd70vt` create — fails (zombie, manually stopped this fire) |

Every create attempt **after 03:39 has failed the same way**. Pre-03:39 worked.

## What's NOT the root cause

- **Not vmnet IP exhaustion.** `/var/db/dhcpd_leases` has 240 entries on a /24 — high but stable still successfully creates wells, so the pool must be allocatable.
- **Not the cidata seed.** Inspected `r2smokezd0mte`'s `cidata.iso` after the failure: contains the right `well.env` + `authorized_keys` for the well-firstboot path. Cidata structure matches what worked before 03:39.
- **Not a welld-side bug.** Dev welld restarted between failure windows — same failure mode persists. Issue lives below welld.

## Strongest theory

**Lume-hang aftermath corrupted some persistent state.** The two SIGKILL+respawn events at 03:41 and 03:59 left zombie VMs (we cleaned `r2smokezd70vt` this fire; `rawtest` still running and not ours — possibly cells team or older cruft). The first lume hang was probably triggered by concurrent pool-fill operations (matches the W.13 / B.0.11.d "concurrent fork crash" investigation BOARD entry).

The VMs themselves boot — `lume.info` reports `status=running`, network adapter is up — but the in-guest hostname doesn't propagate into vmnet's DHCP lease via DHCP option 12. That's the specific link that's broken: VM is alive, vmnet has its MAC/IP, but the name=<hostname> entry never appears.

## Open candidates

1. **vmnet bootp daemon needs a kick.** SIGKILL'd lume serves may have left vmnet's bootp/dhcp daemon in a state where it accepts requests but doesn't write hostnames. `sudo launchctl kickstart -k system/com.apple.bootpd` (requires sudo) might reset it.
2. **`rawtest` zombie is interfering.** Not ours, but it's been running since who-knows-when. Stopping it might clear the issue.
3. **Per-MAC lease cache in vmnet.** The new VM's MAC may be colliding with a stale lease entry whose hostname already differs. Apple's vmnet bias toward "first hostname seen for this MAC" could be sticky.
4. **Lume's mount-of-cidata is silently failing post-respawn.** Patched lume reads the `mount` field on `/run`; if the mount path changed in some way after respawn, the VM boots without cidata, well-firstboot does nothing, hostname stays default.

## Manual unblock recipes (least → most invasive)

**1. Stop the unrelated zombie + see if creates resume.**
```bash
curl -X POST http://127.0.0.1:7780/lume/vms/rawtest/stop  # NOT ours, confirm w/ owner first
# Then: well create test --from-image ubuntu-25.10-base
```

**2. Full dev cycle (lume + welld) with no zombies.**
```bash
# Stop everything dev-side.
DEV_WELLD=$(lsof -nP -iTCP:7879 -sTCP:LISTEN -t)
DEV_LUME=$(lsof -nP -iTCP:7780 -sTCP:LISTEN -t)
[ -n "$DEV_WELLD" ] && kill -TERM $DEV_WELLD
[ -n "$DEV_LUME" ] && kill -TERM $DEV_LUME
sleep 3
# Verify: lsof -nP -iTCP:7879 -iTCP:7780  → empty
# Then restart welld which will respawn lume:
nohup ~/Projects/splites/scripts/run-welld-dev.sh > /tmp/welld-dev.log 2>&1 & disown
sleep 4
curl -s http://127.0.0.1:7879/healthz | jq .
# Try a fresh create — if it works, lume-restart was the unblock.
```

**3. Bounce vmnet's bootp daemon (requires sudo).**
```bash
sudo launchctl kickstart -k system/com.apple.bootpd
# Wait 5s, then try create.
```

**4. Reboot the Mac.** Last resort. Clears vmnet kernel state.

## What worker did

- Read welld log + dhcpd_leases + cidata content + lume hang sample paths.
- Stopped my zombie `r2smokezd70vt` (left from earlier interrupted smoke).
- Did NOT touch `rawtest` (unknown owner, stable side may depend on it).
- Did NOT bounce vmnet (sudo, infrastructure, Pete's call).
- Did NOT restart dev welld + lume cleanly (would conflict with this loop session's running daemons; safer for Pete to do once).

## Closes

W.18 stays Blocked with `needs-pete-session: try unblock recipe 2 (lume+welld restart) and report back`. If that doesn't fix it, the next worker fire can dig into recipe 3 or queue up a vmnet-state inspection helper. **W.2 live-verify stays paused on this.**
