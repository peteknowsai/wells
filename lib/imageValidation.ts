// Pre-save validation for `well image save`. Forks of a saved image
// inherit the source guest's filesystem state — if a critical piece
// of substrate machinery is missing, forks fail in non-obvious ways.
//
// Updated 2026-05-09 for the post-cloud-init substrate (B.0.9.d.4):
// the relevant pieces are well-firstboot's script + systemd unit, and
// systemd-networkd. cloud-init bits were removed.
//
// SSH into the running source well and assert presence of the pieces
// forks depend on. Returns failures as a list of human-readable
// strings. Empty list = all checks passed.

import { spawn } from "bun";

export interface ValidationCheck {
  name: string;
  description: string;
  remoteCmd: string;
}

// The check list. Adding to this list = stricter saves, breaking
// change for cells team if a well that previously passed now fails.
// Be conservative: every entry should reflect a guarantee that the
// fork-time path actually depends on.
export const SAVE_CHECKS: ValidationCheck[] = [
  {
    name: "well-firstboot-script",
    description: "/usr/local/sbin/well-firstboot exists and is executable",
    remoteCmd: "test -x /usr/local/sbin/well-firstboot",
  },
  {
    name: "well-firstboot-service",
    description: "well-firstboot.service is enabled",
    remoteCmd: "systemctl is-enabled well-firstboot.service >/dev/null 2>&1",
  },
  {
    name: "networkd-enabled",
    description: "systemd-networkd is enabled",
    remoteCmd: "systemctl is-enabled systemd-networkd >/dev/null 2>&1",
  },
  {
    name: "netplan-config",
    description: "at least one /etc/netplan/*.yaml exists",
    remoteCmd: "ls /etc/netplan/*.yaml >/dev/null 2>&1",
  },
];

// Pure: build the remote shell that runs every check and emits
// `ok: <name>` or `fail: <name>` per line. Caller parses output.
export function buildProbeScript(checks: ValidationCheck[]): string {
  const lines = checks.map(
    (c) => `( ${c.remoteCmd} ) && echo "ok: ${c.name}" || echo "fail: ${c.name}"`,
  );
  return lines.join("\n");
}

// Pure: parse the probe script's stdout into pass/fail lists.
export function parseProbeOutput(
  output: string,
  checks: ValidationCheck[],
): { passed: string[]; failed: string[]; missing: string[] } {
  const seen = new Set<string>();
  const passed: string[] = [];
  const failed: string[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^(ok|fail):\s*(\S+)$/);
    if (!m) continue;
    seen.add(m[2]!);
    if (m[1] === "ok") passed.push(m[2]!);
    else failed.push(m[2]!);
  }
  // Checks the probe didn't produce a line for — could mean SSH
  // timed out mid-script or the remote shell errored before reaching
  // the check. Treat as missing (not pass, not fail).
  const missing = checks
    .map((c) => c.name)
    .filter((n) => !seen.has(n));
  return { passed, failed, missing };
}

// Run the probe via SSH against a running well. Returns the list of
// human-readable failures (empty = all passed). Caller decides
// whether to refuse the save or proceed.
export async function probeImageSource(
  ip: string,
  keyPath: string,
  timeoutMs: number = 10_000,
): Promise<string[]> {
  const script = buildProbeScript(SAVE_CHECKS);
  const proc = spawn(
    [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      "-o", "LogLevel=ERROR",
      "-i", keyPath,
      `root@${ip}`,
      script,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    return [`ssh probe failed (exit ${code}): ${err || "no stderr"}`];
  }
  const { failed, missing } = parseProbeOutput(out, SAVE_CHECKS);
  const reasons: string[] = [];
  for (const name of failed) {
    const c = SAVE_CHECKS.find((x) => x.name === name);
    reasons.push(`${name}: ${c?.description ?? "(check failed)"}`);
  }
  for (const name of missing) {
    reasons.push(`${name}: probe did not produce a result (truncated output?)`);
  }
  return reasons;
}
