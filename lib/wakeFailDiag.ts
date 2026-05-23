// Diagnostic capture for wake failures (lume.restoreState returning a
// VZ-side error). Best-effort, bounded — every command can fail; the
// point is to have *some* evidence next time the cells-zero / V1.5 /
// "permission denied" VZErrorRestore code 12 surfaces in production.
//
// The bug refuses to reproduce in dev (Phase 1/2/3 of the 2026-05-23
// investigation — see docs/findings-vz-leak-investigation-2026-05-23.md).
// Production telemetry is the only path to a real root cause.
//
// Captured fields, all on the host (the guest is unreachable by
// definition mid-failed-restore):
//   - lsof of the well's disk.img + hibernate.bin (who is holding it?)
//   - ps of every VirtualMachine.xpc on the host (RSS + PID — confirm
//     the W.74 kill landed; rule out a stale child)
//   - vm_stat + sysctl vm.swapusage (memory pressure hypothesis)
//   - lume info <name> (lume's own state of the well)
//   - `log show --predicate 'subsystem == "com.apple.Virtualization"'`
//     for the last 60s (often returns empty; Apple's private subsystem)
//   - registry record + runtime.json (welld's own state at the moment)
//   - error string verbatim
//
// Capture is synchronous before the wake error returns to the caller —
// the next wake retry might mutate the state we want to inspect, so we
// freeze the picture before letting the caller proceed.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "./log.ts";

export interface WakeFailDiagDeps {
  // ~/.wells/diag/wake-fail-<name>-<iso>/
  outDir: string;
  // The well's name + the disk and hibernate.bin paths (whatever
  // restoreState was reading at the moment of failure).
  name: string;
  diskPath: string | null;
  hibernatePath: string;
  // Whatever VZ surfaced. The string is the load-bearing artifact —
  // VZErrorRestore code 12 has been seen with two different messages
  // ("permission denied" vs "Internal Virtualization error") that look
  // like sibling shapes of the same kernel-level rejection.
  errorString: string;
  // Optional: lume HTTP base URL for an info() probe. Skip if null.
  lumeBaseUrl: string | null;
  lumeVmName: string;
  // Welld's view at the failing moment, for cross-reference.
  registryRecord: unknown;
  runtimeJson: unknown;
}

async function runCmd(cmd: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      out += `\n[killed after ${timeoutMs}ms]\n`;
    }, timeoutMs);
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.stderr?.on("data", (d) => { err += d.toString(); });
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

export async function captureWakeFailDiag(deps: WakeFailDiagDeps): Promise<string> {
  const { outDir, name, diskPath, hibernatePath, errorString, lumeBaseUrl, lumeVmName, registryRecord, runtimeJson } = deps;
  try {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    log.error("wake-fail-diag: mkdir failed", { outDir, err: (e as Error).message });
    return outDir;
  }

  const header = [
    `# wake-fail diagnostic capture`,
    `well_name:      ${name}`,
    `disk_path:      ${diskPath ?? "(unknown)"}`,
    `hibernate_path: ${hibernatePath}`,
    `captured:       ${new Date().toISOString()}`,
    `host:           ${process.platform}/${process.arch}`,
    ``,
    `error:`,
    errorString,
    ``,
  ].join("\n");

  const writes: Promise<void>[] = [
    writeFile(join(outDir, "README.txt"), header, { mode: 0o600 }),
    writeFile(join(outDir, "registry.json"), JSON.stringify(registryRecord, null, 2), { mode: 0o600 }),
    writeFile(join(outDir, "runtime.json"), JSON.stringify(runtimeJson, null, 2), { mode: 0o600 }),
    writeFile(join(outDir, "error.txt"), errorString, { mode: 0o600 }),
  ];

  // Host-side commands. None require sudo.
  const cmds: Array<[string, string, string[], number?]> = [
    // All Virtualization.framework XPC children with RSS, sorted by PID
    ["xpc-children.txt", "bash", ["-c", `ps -A -o pid,ppid,rss,vsz,etime,command | head -1; ps -A -o pid,ppid,rss,vsz,etime,command | grep -E 'VirtualMachine\\.xpc' | grep -v grep | sort -n`]],
    // Memory pressure snapshot
    ["vm_stat.txt", "vm_stat", []],
    ["swap.txt", "sysctl", ["vm.swapusage"]],
    ["memorypressure.txt", "bash", ["-c", `memory_pressure 2>&1 | head -30`], 4_000],
    // Welld + lume process state
    ["welld-lume-procs.txt", "bash", ["-c", `ps -A -o pid,ppid,rss,vsz,etime,command | grep -E 'welld|vwell.*serve|lume.*serve' | grep -v grep`]],
    // Apple's private Virtualization subsystem logs (often empty/restricted)
    ["log-show-vz-60s.txt", "log", ["show", "--predicate", "subsystem == \"com.apple.Virtualization\" OR subsystem == \"com.apple.virtualization\"", "--last", "60s", "--style", "compact"], 8_000],
  ];

  if (diskPath) {
    cmds.push(["lsof-disk.txt", "lsof", ["-nP", diskPath]]);
  }
  cmds.push(["lsof-hibernate.txt", "lsof", ["-nP", hibernatePath]]);

  // Lume info via HTTP (fast, no spawn). Outside the cmds loop because
  // it's a fetch, not a shell command.
  if (lumeBaseUrl) {
    writes.push((async () => {
      try {
        const res = await fetch(`${lumeBaseUrl}/lume/vms/${encodeURIComponent(lumeVmName)}`, {
          signal: AbortSignal.timeout(3_000),
        });
        const body = await res.text();
        await writeFile(
          join(outDir, "lume-info.txt"),
          `# GET ${lumeBaseUrl}/lume/vms/${lumeVmName}\n[status ${res.status}]\n${body}\n`,
          { mode: 0o600 },
        );
      } catch (e) {
        await writeFile(
          join(outDir, "lume-info.txt"),
          `# GET failed: ${(e as Error).message}\n`,
          { mode: 0o600 },
        ).catch(() => {});
      }
    })());
  }

  // Capture hibernate.bin file stat (size, mtime, ownership) for sanity.
  writes.push((async () => {
    try {
      const stat = await Bun.file(hibernatePath).exists();
      const sz = stat ? (await Bun.file(hibernatePath).size) : null;
      const fileStat = await runCmd("stat", ["-f", "%N\nsize=%z\nmtime=%Sm\nmode=%Sp\nowner=%Su:%Sg", hibernatePath]);
      await writeFile(
        join(outDir, "hibernate-bin-stat.txt"),
        `exists=${stat}\nsize=${sz}\n\n${fileStat}\n`,
        { mode: 0o600 },
      );
    } catch (e) {
      await writeFile(
        join(outDir, "hibernate-bin-stat.txt"),
        `stat error: ${(e as Error).message}\n`,
        { mode: 0o600 },
      ).catch(() => {});
    }
  })());

  for (const [filename, cmd, args, timeoutMs] of cmds) {
    writes.push(
      runCmd(cmd, args, timeoutMs ?? 5_000).then((out) =>
        writeFile(join(outDir, filename), out, { mode: 0o600 }),
      ),
    );
  }

  await Promise.allSettled(writes);
  log.info("wake-fail-diag: captured", { name, outDir, files: cmds.length + 4 });
  return outDir;
}
