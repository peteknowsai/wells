# NEEDS_PETE — rinse-empty-home claim contradicts the code

**Status as of 2026-05-10 06:00 UTC** — worker found a discrepancy between the cells-team ping draft and the actual rinse code. **Don't send the ping as drafted.** The recommendation in the ping ("narrow rinseGuest to identity-only") is wrong — `RINSE_SCRIPT` is already identity-only.

## What the ping claims

> `POST /v1/wells/images {validate:true}` wipes /home/well/ on the source before clonefile — not just identity (machine-id, .well-ready, network, ssh keys).

## What the code actually does

`lib/rinseWell.ts:47-58` — the entire rinse script:

```bash
set -e
sudo rm -rf /var/lib/systemd/network/*
sudo rm -f /etc/machine-id /etc/.well-ready
sudo touch /etc/machine-id
sudo rm -f /etc/ssh/ssh_host_*
sudo rm -f /home/ubuntu/.ssh/authorized_keys
sudo rm -f /home/well/.ssh/authorized_keys 2>/dev/null || true
echo rinsed
sudo sync
sudo shutdown -h now
```

Identity-only. Doesn't touch `/home/ubuntu/` or `/home/well/` content beyond `.ssh/authorized_keys`. `grep -rn "/home" lib/ daemon/ templates/` returns only this file + `well-firstboot.sh:76-77` (which only touches `/home/ubuntu/.ssh` on first boot of a fresh fork).

So if the cells repro produces an empty `/home/well/agent/` on fork, the cause isn't rinse. Possibilities to investigate before pinging cells:

1. **Cells writes to `/home/ubuntu/`, not `/home/well/`.** Default well user is `ubuntu` per `well-firstboot.sh`. If `cells birth` puts the DNA at `~/agent/` and that resolves to `/home/ubuntu/agent/`, both the source well and the fork should have it. If only the source has it but fork doesn't, something on the create-from-image path is wiping `/home/ubuntu/agent/`.
2. **Cloud-init resets `/home/` on first boot.** We've been disabling cloud-init for hibernate (per the parked B.0.9.d.2 plan). If cloud-init *isn't* properly disabled on `ubuntu-25.10-base`, the `users:` directive could rebuild `/home/<user>` from skel on first fork boot.
3. **`well exec` user mismatch between create and fork.** Repro creates marker as one user, fork's `well exec` runs as another, can't see the file but it's still on disk.
4. **clonefile is consistent but cidata erases on fork.** `cidata.iso` regen on first boot of the fork could mount-overlay something onto `/home`. Less likely.

## Suggested action

**Do not send the pre-drafted ping** until the root cause is verified. Run the repro on dev (`:7879`) with extra introspection:

```bash
# After save+rinse, but BEFORE deleting source:
well exec -s wuser-test -- bash -c 'whoami; pwd; ls -la /home/'
# After fork:
well exec -s rinse-fork -- bash -c 'whoami; pwd; ls -la /home/; find /home -name marker.txt'
```

If `whoami` differs between source and fork, that's a `well exec` user-resolution bug, not rinse.
If `/home` listing shows the user's homedir was never created on the fork (skel-only), that's cloud-init / first-boot.
If the fork's homedir is there but missing files, that's a save-time issue I haven't found yet.

Once we know which of (1)-(4) it is, the cells team ping can be specific about the actual problem instead of pointing them at rinseGuest.

## What worker did

- Read `lib/rinseWell.ts` end-to-end and grepped repo for any `/home/` references — confirmed rinse is already identity-only.
- Logged this NEEDS_PETE entry instead of sending the ping.
- Added BOARD entry "fork-empty-home root cause investigation" to **Blocked** with `decision-needed: pete-or-steward picks up the dev-side repro` so the queue moves on to W.2.
- Continuing worker fire on W.2 (R2 round-trip smoke).

## Open question for Pete

Want worker to run the introspection repro on dev next fire (will burn one fire on it; harmless), or hold for steward / your eyes?
