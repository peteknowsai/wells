# Blockers

Open questions / decisions needed from Pete. Loop runs read this file first and skip new work while there's an open blocker.

When resolving: edit/remove the relevant entry, commit, and the next loop run picks back up.

---

## 2026-05-06 — Staged VM stalls during cloud-init; no DHCP

**Symptom.** With QCOW2→RAW conversion working (last iteration), the VM transitions to `running`, disk allocates 881 MB → 2.2 GB in the first ~30 seconds (looks like initial boot writes), then plateaus. After 10+ minutes:

- Lume's API: `ipAddress: null`, `sshAvailable: null`.
- macOS DHCP leases (`/var/db/dhcpd_leases`): only stale entries from prior cua tests (March). **No fresh lease** matching our VM's MAC `7e:1f:12:48:fa:3b`.
- ARP on `bridge100` (lume's vmnet, host side `192.168.64.1`): only `192.168.64.1` itself; pings to `.2`–`.10` return `incomplete`.
- The lume `run` subprocess is still alive; lume's status reports "running"; bridge100 + vmenet0 are properly wired.
- Disk growth 881 MB → 2.2 GB suggests cloud-init started, did some writes, then either stalled or completed silently without internet.

## What I tried

- **First attempt** (last iteration): no `network-config` in the cidata. Cloud-init's default DHCP rule matches `eth0`, but Apple Virt's VirtIO NIC has a different name. Hypothesis: networking never came up because no DHCP rule matched.

- **Second attempt** (this iteration): added an explicit `network-config` to the cidata that DHCPs every NIC by wildcard:
  ```yaml
  version: 2
  ethernets:
    all:
      match:
        name: "*"
      dhcp4: true
  ```
  Same result. No DHCP lease, no IP, same plateau.

- The cidata ISO was verified to contain all three files (meta-data, user-data, network-config) with the right contents.

## What's likely going on

Three plausible causes, ranked:

1. **Cloud-init is reading the cidata fine and DHCP is running, but Apple's vmnet DHCP server isn't responding to our VM's specific MAC.** Possibly tied to lume's `networkMode: nat` config or how the cidata user-data is timing out. (Apple's `vmnet_shared_mode` runs an internal DHCP; sometimes flaky when the guest fires DHCP packets before the host adapter is fully up.)

2. **The Linux kernel never actually boots, but lume reports "running" because the VM process is alive (just stuck in EFI, kernel panic, or initrd loop).** The 1.5 GB of disk growth is hard to explain with this — that's a lot of writes for a VM that never reaches userspace. Maybe just kernel scratch / journald early.

3. **cidata isn't being seen by cloud-init at all, despite being attached.** Apple Virt's USB mass storage on macOS 26 might not present to Linux as a typical /dev/sr0 / /dev/sda. cloud-init's NoCloud datasource scan would miss it. Disk growth would be from the cloud-image's first-boot defaults (no user-data applied).

To distinguish: look at the actual VM console. We need either:
- VNC into `vnc://:swan-whiskey-whale-mike@127.0.0.1:51066` (Pete: easiest from the Mac via Screen Sharing or Tiger VNC) and screenshot the boot screen.
- Configure lume to log serial console to a file (need to check if the API supports this).
- Mount `~/.lume/splites-base-stage/disk.img` read-only and inspect `/var/log/cloud-init.log` and `/var/log/syslog` post-mortem (requires Linux, or macFUSE + ext4 reader on Mac).

## Three ways forward

**(a) VNC in once and screenshot the console.** Pete connects to `vnc://:swan-whiskey-whale-mike@127.0.0.1:51066` (via macOS Screen Sharing app — `cmd+K` from Finder, paste the vnc:// URL), takes a screenshot, drops it back here. Tells us in 30 seconds if it's an EFI prompt, kernel panic, login prompt, or stuck systemd unit.

**(b) Switch cidata datasource from "USB mass storage" to a different attach mode.** Lume's CLI also has `--mount=<file>` for "read-only disk image to attach (Linux VMs only)". If cidata is presented as a regular block device rather than USB, cloud-init might find it more reliably. I'd swap `--usb-storage=` → `--mount=` and re-test.

**(c) Use `--network=bridged` instead of NAT.** If host-side vmnet DHCP is the issue, bridging directly to en0 and using the home router's DHCP would route around it. Cost: VM gets a real LAN IP, less isolation. Not the long-term plan but a useful diagnostic.

**Recommendation: (a) first — 30 s of VNC tells us which of the three causes is real, and the right fix follows directly from what's on screen.** If you'd rather I try (b) or (c) without the VNC step, say which.

## Cleanup

- The current `splites-base-stage` VM is still running (will keep stalled). Easy to kill if (a)/(b)/(c) require fresh state — `curl -X DELETE http://127.0.0.1:7777/lume/vms/splites-base-stage` plus a SIGTERM to the lume-run process.

**To resolve:** Pete picks (a)/(b)/(c) (or something else I haven't thought of).
