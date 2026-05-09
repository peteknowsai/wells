// Rinse a running well's guest filesystem before save.
//
// Forks from a saved image inherit the source's filesystem, including
// host-specific identity bits that DHCP, ssh-id, and well-firstboot
// each rely on being unique-per-instance:
//
//   /etc/machine-id              — kernel's host UUID; systemd-networkd
//                                   derives DHCP DUID from it. If the
//                                   saved image has a populated machine-id,
//                                   every fork DHCPs with the same DUID
//                                   *before* well-firstboot can regen.
//   /etc/.well-ready             — well-firstboot's "identity applied"
//                                   marker. Saved-image baked-in marker
//                                   is meaningless to forks but used to
//                                   gate via systemd ConditionPathExists
//                                   (gate dropped 2026-05-09 in
//                                   commit eeb1401, but rinsing keeps
//                                   the disk hygienic anyway).
//   /var/lib/systemd/network/*   — networkd's persisted DHCP lease
//                                   files, keyed off the source's MAC
//                                   and DUID. Stale renewals on first
//                                   boot of a fork rejected by vmnet's
//                                   bootpd, leaving DHCP in a hung state.
//   /etc/ssh/ssh_host_*          — host key pairs. Re-baking is fine
//                                   (well-firstboot regens them) but
//                                   removing them at rinse time keeps
//                                   any image-level fingerprinting
//                                   honest.
//   /home/<user>/.ssh/authorized_keys — old authorized keys from the
//                                       source's cidata. Forks get fresh
//                                       cidata at create-time; rm here
//                                       so a missing/wrong cidata doesn't
//                                       leave a fork accidentally
//                                       authorized to the source's keys.
//
// Caller: welld's `POST /v1/wells/images` with rinse=true. After
// rinseGuest returns, caller should clean-shutdown the guest (so the
// disk is in a quiescent state) before clonefile.

import { spawn } from "bun";

const RINSE_SCRIPT = `
set -e
sudo rm -rf /var/lib/systemd/network/*
sudo rm -f /etc/machine-id /etc/.well-ready
sudo touch /etc/machine-id
sudo rm -f /etc/ssh/ssh_host_*
sudo rm -f /home/ubuntu/.ssh/authorized_keys
sudo rm -f /home/well/.ssh/authorized_keys 2>/dev/null || true
echo rinsed
`.trim();

export interface RinseGuestOpts {
  ip: string;
  keyPath: string;
  user?: string;
  timeoutMs?: number;
}

export async function rinseGuest(opts: RinseGuestOpts): Promise<void> {
  const user = opts.user ?? "ubuntu";
  const timeout = opts.timeoutMs ?? 15_000;
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.ceil(timeout / 1000)}`,
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", opts.keyPath,
      `${user}@${opts.ip}`,
      RINSE_SCRIPT,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
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
  const timeout = opts.timeoutMs ?? 15_000;
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.ceil(timeout / 1000)}`,
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
      "-i", opts.keyPath,
      `${user}@${opts.ip}`,
      "sudo shutdown -h now",
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  await proc.exited;
  // `shutdown -h now` returns 0 immediately even when the guest is
  // halting — caller polls disk-release to know it's truly stopped.
}
