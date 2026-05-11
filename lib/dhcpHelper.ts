// Welld-side wrapper around /usr/local/sbin/welld-dhcp-helper.
//
// The helper is a privileged binary installed by scripts/install-dhcp-helper.sh
// (see that script for the privilege model rationale). Welld shells out to it
// via `sudo -n` for any operation that needs to edit /var/db/dhcpd_leases.
//
// If the helper isn't installed (`-n` fails), every wrapper returns
// `{ ok: false, reason: "not-installed" }` and welld logs once. Callers
// treat absence as best-effort: destroy still succeeds, lease just stays.

import { spawn } from "bun";
import { log } from "./log.ts";

const HELPER_PATH = "/usr/local/sbin/welld-dhcp-helper";

export interface HelperResult {
  ok: boolean;
  reason?: "not-installed" | "invalid-arg" | "exec-failed" | "exit-nonzero";
  exitCode?: number;
  stderr?: string;
}

async function invoke(args: string[]): Promise<HelperResult> {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(["sudo", "-n", HELPER_PATH, ...args], {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (e) {
    return { ok: false, reason: "exec-failed", stderr: (e as Error).message };
  }
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return { ok: true };
  // sudo's "a password is required" / "no tty present" message both mean
  // the helper isn't installed-with-NOPASSWD (or not installed at all).
  if (
    stderr.includes("a password is required") ||
    stderr.includes("no tty present") ||
    stderr.includes("command not found") ||
    stderr.includes("welld-dhcp-helper")
  ) {
    // Distinguish "not installed" vs "argument rejected by helper". The
    // helper exits 64 on usage error; anything else exit-nonzero with
    // stderr from the helper proper.
    if (code === 64) {
      return { ok: false, reason: "invalid-arg", exitCode: code, stderr };
    }
    // Heuristic: if stderr looks like a sudo password prompt or
    // command-not-found, the helper isn't installed-correctly.
    if (
      stderr.includes("a password is required") ||
      stderr.includes("command not found")
    ) {
      return { ok: false, reason: "not-installed", exitCode: code, stderr };
    }
  }
  return { ok: false, reason: "exit-nonzero", exitCode: code, stderr };
}

// Release a single lease by hostname. Used by destroyWell() to free the
// IP for re-use, and by handleFlushLeases to release orphan leases one
// at a time (W.67). Idempotent: if no matching lease exists, the helper
// rewrites the file unchanged and still kicks bootpd.
//
// Nuclear flush-all is intentionally NOT exposed here. The bash helper
// still supports its `flush-all` verb for operators who want to invoke
// via sudo directly — that's the deliberate escape hatch outside welld's
// API surface, so welld itself can't accidentally nuke running wells'
// leases (which was the bug cells team hit 2026-05-11).
export async function releaseLease(hostname: string): Promise<HelperResult> {
  if (!isValidHostname(hostname)) {
    return { ok: false, reason: "invalid-arg" };
  }
  return invoke(["release-hostname", hostname]);
}

// Mirror of wellPolicy.ts NAME_RE — keeps shell-injection defense in
// depth even though the helper validates again.
function isValidHostname(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name);
}

let absenceWarnedOnce = false;

// Wrapper used by destroyWell. Best-effort: logs once if the helper
// isn't installed, then succeeds silently for all subsequent calls
// to avoid log spam. Logs every other failure shape so operators see
// real errors.
export async function releaseLeaseBestEffort(hostname: string): Promise<void> {
  const r = await releaseLease(hostname);
  if (r.ok) return;
  if (r.reason === "not-installed") {
    if (!absenceWarnedOnce) {
      log.warn(
        "dhcp-helper not installed — destroys won't release leases. " +
          "Run scripts/install-dhcp-helper.sh.",
      );
      absenceWarnedOnce = true;
    }
    return;
  }
  log.error("dhcp-helper releaseLease failed", {
    hostname,
    reason: r.reason,
    code: r.exitCode,
    stderr: r.stderr?.slice(0, 300),
  });
}

// Test hook — reset the once-only warn flag so tests can re-verify
// the absence-warned path.
export function _resetForTests(): void {
  absenceWarnedOnce = false;
}
