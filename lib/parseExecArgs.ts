// Parse `well exec` arguments. Shape:
//
//   well exec [-s|--well name] [-t|--tty] -- <cmd> [args...]
//
// The `--` separator is required — anything before it is well flags,
// anything after it is the command to run inside the guest.

export interface ParsedExec {
  well?: string;
  tty: boolean;
  cmd: string[];
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
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (f === "-s" || f === "--well") {
      well = flags[++i];
      if (!well) throw new Error(`${f} requires a value`);
    } else if (f === "-t" || f === "--tty") {
      tty = true;
    } else {
      throw new Error(`unknown flag '${f}'`);
    }
  }
  return { well, tty, cmd };
}
