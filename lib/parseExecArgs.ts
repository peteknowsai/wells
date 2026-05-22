// Parse `well exec` arguments. Shape:
//
//   well exec [-s|--well name] [-t|--tty] [--user <user>] -- <cmd> [args...]
//
// The `--` separator is required — anything before it is well flags,
// anything after it is the command to run inside the guest.
//
// `--user` overrides the default `root` user. The VM is the sandbox
// boundary, so exec lands as root (HOME=/root) to match how cells —
// the only real exec consumer — actually runs. Use `--user ubuntu`
// for raw-VM debug or `--user well` for the SSH entry user.

export interface ParsedExec {
  well?: string;
  tty: boolean;
  cmd: string[];
  // Undefined = caller picks default. CLI defaults to "root".
  user?: string;
}

export function parseExecArgs(args: string[]): ParsedExec {
  const dashIdx = args.indexOf("--");
  if (dashIdx === -1) {
    throw new Error("missing '--' separator before command");
  }
  const flags = args.slice(0, dashIdx);
  const cmd = args.slice(dashIdx + 1);
  if (cmd.length === 0) {
    throw new Error("no command after '--'");
  }

  let well: string | undefined;
  let tty = false;
  let user: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    const raw = flags[i]!;
    // Support both `--flag value` and `--flag=value` shapes. Cells team
    // hit the latter in their automation (`well exec --user=cell`) and
    // got an "unknown flag" because the parser was space-separated only.
    const eq = raw.indexOf("=");
    const f = eq > 0 && raw.startsWith("-") ? raw.slice(0, eq) : raw;
    const inlineVal = eq > 0 && raw.startsWith("-") ? raw.slice(eq + 1) : undefined;
    if (f === "-s" || f === "--well") {
      well = inlineVal ?? flags[++i];
      if (well === undefined || well === "") throw new Error(`${f} requires a value`);
    } else if (f === "-t" || f === "--tty") {
      if (inlineVal !== undefined) throw new Error(`${f} takes no value`);
      tty = true;
    } else if (f === "-u" || f === "--user") {
      user = inlineVal ?? flags[++i];
      if (user === undefined || user === "") throw new Error(`${f} requires a value`);
    } else {
      throw new Error(`unknown flag '${f}'`);
    }
  }
  return { well, tty, cmd, user };
}
