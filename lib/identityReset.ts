// A.1.4.c.ii — in-guest identity reset for pool-adopted wells.
//
// Pool members are hatched with the generic identity `pool-XXXXXXXX`:
// hostname, machine-id, SSH host keys all share the pool member's
// pre-warmed values. After adoption, the well is operationally that
// pool member with a renamed welld bundle + a registry-level rename
// to the operator's chosen name. Inside the guest, `hostname` still
// reports `pool-XXXXXXXX`. SSH host keys are still the pool member's
// (which means two adopted wells from the same pool look identical
// to host-key fingerprinting). machine-id is still the pool member's
// (DBus, journald keys collide).
//
// Cells team's preferred fix is a warm-restart with fresh cidata —
// safer (well-firstboot reapplies identity from scratch) but adds
// 10-15s to adoption, killing the <2s create target.
//
// SSH hot-swap is the faster alternative documented in the spec.
// Risks called out: DBus DUID changes mid-flight, journald log
// continuity, sshd restart killing the active session. Mitigations:
//   - DBus DUID: switching machine-id while DBus is running is
//     supported by systemd; new clients pick up the new ID. Existing
//     connections may continue to use the old one until reconnect.
//   - journald: existing logs stay in their old machine-id boot
//     directory. Operator querying logs from inside the guest sees
//     mostly-current logs only. Acceptable for cells team's MVP.
//   - sshd restart: scheduled with `nohup ... sleep 1; systemctl
//     restart ssh &` so it fires AFTER the hot-swap session exits.
//
// Returns the elapsed time in ms — adoptFromPool aggregates this
// into adoption_ms so callers see the true end-to-end cost.

import { spawn } from "bun";

export interface ResetIdentityOptions {
  // Operator-chosen well name (becomes the in-guest hostname).
  name: string;
  // The well's resolved IP. Caller (adoptFromPool) gets this from
  // resolveWellIp post-wake.
  ip: string;
  // Per-well SSH key the host uses. For adopted wells, this is the
  // symlinked path under the new welld bundle dir; same key the pool
  // member was hatched with — pool's authorized_keys was set up at
  // fill time to include this key.
  sshKeyPath: string;
}

// In-guest reset script. Runs as root via `sudo bash -s`. Reads the
// new hostname as the first positional arg so we don't have to
// shell-escape the value into the script body.
//
// What we reset:
//   1. hostnamectl + /etc/hostname — reflects on next prompt + sticks
//      across reboot.
//   2. machine-id rotation — DBus, journald, anything keyed off
//      /etc/machine-id picks up the new value on next reference.
//
// What we DON'T reset (deliberate scope cut for the <2s create gate):
//   - SSH host keys. ssh-keygen -A regen takes ~700ms (rsa 2048 +
//     ecdsa 256 + ed25519 256), which would push adoption past the
//     <2s target. Each pool member already has unique host keys
//     from its own well-firstboot.sh run, so adopted-well host keys
//     ARE unique-per-well (just under the pool-XXXX identity rather
//     than the operator name). Wells's host-side SSH all uses
//     StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null, so
//     fingerprint mismatches across wells don't surface in normal
//     use. Reopen if cells team needs it.
//   - authorized_keys. Pool members were hatched with the host
//     pubkey via fillPoolMember; nothing to add at adoption time.
const RESET_SCRIPT = `
set -e
NEW_HOSTNAME=$1
hostnamectl set-hostname "$NEW_HOSTNAME"
echo "$NEW_HOSTNAME" > /etc/hostname
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup
`;

export async function resetWellIdentity(
  opts: ResetIdentityOptions,
): Promise<{ ms: number }> {
  const t0 = Date.now();
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=2",
      "-o", "BatchMode=yes",
      "-o", "LogLevel=ERROR",
      "-i", opts.sshKeyPath,
      `ubuntu@${opts.ip}`,
      `sudo bash -s ${opts.name}`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(RESET_SCRIPT);
  proc.stdin.end();
  const [_, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `identity reset failed for '${opts.name}' (ssh exit=${code}): ${stderr.slice(0, 300)}`,
    );
  }
  return { ms: Date.now() - t0 };
}
