/**
 * splite-cooperate — pi extension. The off-switch.
 *
 * On agent_end, hits splited's /sleep endpoint. That's it. The cell
 * pauses immediately, freeing CPU; agent state stays in RAM and resumes
 * on next inbound traffic in <1s.
 *
 * The agent never sees this hook fire. From its perspective it's always
 * on — what's actually happening is the host pausing the VM during every
 * gap between turns and resuming it transparently when traffic arrives.
 *
 * Agent-side awareness is zero, by design. Validation ("did the agent
 * really mean to stop?") isn't needed because agent_end is a deterministic
 * harness state-machine transition — by the time it fires, the LLM has
 * stopped generating, all tool calls have completed, the turn is closed.
 *
 * Drop into a pi-running cell: install via npm/bun, drop the path into
 * .pi/settings.json's `extensions` array.
 */

const SPLITE_HOST = process.env.SPLITE_METADATA_URL ?? "http://host.splite:7879";
const TIMEOUT_MS = 1000;

async function fireSleep(): Promise<void> {
  try {
    await fetch(`${SPLITE_HOST}/v1/cells/me/sleep`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Metadata server unreachable — splited not running, no bridge, etc.
    // Silent: the watchdog's outside-in heuristic still picks the cell
    // up after the auto_sleep_seconds threshold.
    console.error(`[splite-cooperate] sleep unreachable: ${String(e).slice(0, 80)}`);
  }
}

export default function (pi: any) {
  pi.on("agent_end", async () => {
    await fireSleep();
  });
}
