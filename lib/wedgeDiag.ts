// Diagnostic capture for confirmed wedges. Best-effort — every command
// can fail; we log the failure and move on. The point is to have *some*
// evidence next time the wedge happens, since cold-cycling wipes it all.
//
// Captures host-side facts (the guest is unreachable by definition).
// Guest-side facts could be captured opportunistically via a non-SSH
// channel (lume serial console?) — out of scope for v1.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "./log.ts";

export interface WedgeDiagDeps {
  // Where to write the diag bundle. Welld passes `~/.wells/diag/wedge-<name>-<iso>/`.
  outDir: string;
  // The well's name (for header context) + IP (target of network probes).
  name: string;
  ip: string | null;
  // Snapshot of the well's registry record to write as JSON.
  registryRecord: unknown;
}

// Run a shell command with a hard timeout, return stdout+stderr as a single
// string suitable for dumping to a file. Failures land in the captured
// output as "ERROR: ..." rather than throwing.
async function runCmd(cmd: string, args: string[], timeoutMs: number = 5_000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      out += `\n[killed after ${timeoutMs}ms]\n`;
    }, timeoutMs);
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("exit", (code) => {
      clearTimeout(timer);
      const header = `$ ${cmd} ${args.join(" ")}\n[exit ${code}]\n`;
      resolve(header + out + (err ? `\n--- stderr ---\n${err}` : ""));
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve(`$ ${cmd} ${args.join(" ")}\n[spawn failed: ${(e as Error).message}]\n`);
    });
  });
}

export async function captureWedgeDiag(deps: WedgeDiagDeps): Promise<string> {
  const { outDir, name, ip, registryRecord } = deps;
  try {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    log.error("wedge-diag: mkdir failed", { outDir, err: (e as Error).message });
    return outDir;
  }

  // Captured-at header so the file is self-explanatory when found later.
  const header = [
    `# wedge diagnostic capture`,
    `well_name: ${name}`,
    `ip:        ${ip ?? "(none)"}`,
    `captured:  ${new Date().toISOString()}`,
    `host:      ${process.platform}/${process.arch}`,
    "",
  ].join("\n");

  // The registry record as we saw it at the moment of detection — golden
  // for cross-referencing welld state vs. observed network behavior.
  const writes: Promise<void>[] = [
    writeFile(join(outDir, "README.txt"), header, { mode: 0o600 }),
    writeFile(join(outDir, "registry.json"), JSON.stringify(registryRecord, null, 2), { mode: 0o600 }),
  ];

  // Host-side network state. None require sudo.
  // - ifconfig bridge100: vmnet bridge interface state
  // - netstat -rn:        kernel routing table
  // - ss -tn:             TCP socket state (filtered to the well's IP if known)
  // - arp -an:            MAC↔IP map on bridge100 — confirms the kernel still has the well
  // - ps aux | grep:      lume + vwell processes for this well
  const cmds: Array<[string, string, string[]]> = [
    ["ifconfig-bridge100.txt", "ifconfig", ["bridge100"]],
    ["netstat-rn.txt", "netstat", ["-rn"]],
    ["arp-an.txt", "arp", ["-an"]],
    ["ps-aux-wells.txt", "bash", ["-c", `ps aux | grep -E "${name}|vwell|lume" | grep -v grep`]],
  ];
  if (ip) {
    cmds.push([
      "ss-tcp.txt",
      "bash",
      ["-c", `lsof -nP -iTCP@${ip} 2>&1 || true`],
    ]);
    cmds.push([
      "ping.txt",
      "ping",
      ["-c", "3", "-W", "2", ip],
    ]);
  }

  for (const [filename, cmd, args] of cmds) {
    writes.push(
      runCmd(cmd, args).then((out) => writeFile(join(outDir, filename), out, { mode: 0o600 })),
    );
  }

  await Promise.allSettled(writes);
  log.info("wedge-diag: captured", { name, outDir, files: cmds.length + 2 });
  return outDir;
}
