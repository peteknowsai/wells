// Rinse a running well's guest filesystem before save.
//
// Forks from a saved image inherit the source's filesystem, including
// host-specific identity bits that DHCP, ssh-id, and well-firstboot
// each rely on being unique-per-instance:
//
//   /etc/.well-ready             — well-firstboot's "identity applied"
//                                   marker. Forks need this absent so
//                                   well-firstboot.service actually
//                                   runs and reseeds identity per-fork
//                                   (hostname, machine-id, ssh keys,
//                                   authorized_keys, swap, DNS).
//   /var/lib/systemd/network/*   — networkd's persisted DHCP lease
//                                   files, keyed off the source's MAC
//                                   and DUID. Stale renewals on first
//                                   boot of a fork rejected by vmnet's
//                                   bootpd, leaving DHCP in a hung state.
//   /home/<user>/.ssh/authorized_keys — old authorized keys from the
//                                       source's cidata. Forks get fresh
//                                       cidata at create-time; rm here
//                                       so a missing/wrong cidata doesn't
//                                       leave a fork accidentally
//                                       authorized to the source's keys.
//
// NOT rinsed (deliberately, after live debug with cells team 2026-05-10):
//
//   /etc/ssh/ssh_host_*  Deleting host keys forces a fork's early-boot
//                        sshd-keygen.service to regenerate them with
//                        cold-boot entropy. On Apple VZ guests' thin
//                        early-boot pool this stalls indefinitely.
//
//   /etc/machine-id      The smoking gun: sshd-keygen.service has
//                        ConditionFirstBoot=yes, which fires when
//                        /etc/machine-id is empty. The old rinse
//                        explicitly emptied machine-id (`rm -f` then
//                        `touch`) to mark forks as "first boot" — but
//                        that's precisely what triggered sshd-keygen
//                        and the cold-entropy stall. Ubuntu-base forks
//                        worked only because their machine-id was
//                        non-empty (cloud-init populated it at base
//                        bake), so ConditionFirstBoot=no and the
//                        service skipped. Now we let forks inherit
//                        the source's machine-id briefly; well-firstboot
//                        regenerates a unique one per-fork after
//                        network-online. Netplan's `dhcp-identifier:
//                        mac` ensures DHCP doesn't care about the
//                        shared-machine-id window.
//
// In our threat model (closed vmnet bridge, welld trusts via cidata
// authorized_keys + StrictHostKeyChecking=no), the brief shared-state
// window between sshd auto-start and well-firstboot completion is safe.
//
// Caller: welld's `POST /v1/wells/images` with rinse=true. After
// rinseGuest returns, caller should clean-shutdown the guest (so the
// disk is in a quiescent state) before clonefile.

import { spawn } from "bun";

// Rinse + shutdown in one SSH session. The script removes
// authorized_keys at the end (which would lock us out of any
// follow-up SSH), so the shutdown has to be in the same connection.
// The shutdown is `sync && shutdown -h now` — sync flushes any
// pending writes to disk before halt, so the saved image isn't torn.
const RINSE_SCRIPT = `
set -e
sudo rm -rf /var/lib/systemd/network/*
sudo rm -f /etc/.well-ready
sudo rm -f /home/ubuntu/.ssh/authorized_keys
sudo rm -f /home/well/.ssh/authorized_keys 2>/dev/null || true
echo rinsed
sudo sync
sudo shutdown -h now
`.trim();

export interface RinseGuestOpts {
  ip: string;
  keyPath: string;
  user?: string;
  timeoutMs?: number;
}

// Race a spawned subprocess against a wall-clock timeout. SIGKILL on
// timeout (more reliable than SIGTERM when sshd is the parent). Returns
// the exit code, or throws on timeout. Lifted into a helper because
// every ssh-spawn site needed the same pattern (B.0.11 cells team hit
// a 5-minute hang because rinseGuest's ssh had no overall timeout).
async function runWithTimeout(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
  description: string,
): Promise<number> {
  const TIMEOUT = Symbol("timeout");
  const timer = new Promise<typeof TIMEOUT>((resolve) =>
    setTimeout(() => resolve(TIMEOUT), timeoutMs),
  );
  const result = await Promise.race([proc.exited, timer]);
  if (result === TIMEOUT) {
    try {
      proc.kill("SIGKILL");
    } catch {}
    // Best-effort drain so the spawned proc's stdio fds can close.
    await proc.exited.catch(() => 0);
    throw new Error(`${description} timed out after ${timeoutMs}ms`);
  }
  return result as number;
}

export async function rinseGuest(opts: RinseGuestOpts): Promise<void> {
  const user = opts.user ?? "ubuntu";
  const timeout = opts.timeoutMs ?? 60_000;
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.min(15, Math.ceil(timeout / 1000))}`,
      "-o", "ServerAliveInterval=10",
      "-o", "ServerAliveCountMax=2",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", opts.keyPath,
      `${user}@${opts.ip}`,
      RINSE_SCRIPT,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const code = await runWithTimeout(proc, timeout, `rinse ssh ${opts.ip}`);
  const out = (await new Response(proc.stdout).text()).trim();
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`rinse failed (exit ${code}): ${err || "no stderr"}`);
  }
  if (!out.endsWith("rinsed")) {
    throw new Error(`rinse output mismatch — expected trailing 'rinsed', got: ${out}`);
  }
}

// Send a clean shutdown to the guest. Mirrors createWell.ts's
// warming-shutdown shape. Caller waits for the disk to be released
// (lsof) before clonefile.
export async function shutdownGuest(opts: RinseGuestOpts): Promise<void> {
  const user = opts.user ?? "ubuntu";
  const timeout = opts.timeoutMs ?? 30_000;
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.min(15, Math.ceil(timeout / 1000))}`,
      "-o", "ServerAliveInterval=10",
      "-o", "ServerAliveCountMax=2",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", opts.keyPath,
      `${user}@${opts.ip}`,
      "sudo shutdown -h now",
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  await runWithTimeout(proc, timeout, `shutdown ssh ${opts.ip}`);
  // `shutdown -h now` returns 0 immediately even when the guest is
  // halting — caller polls disk-release to know it's truly stopped.
}
