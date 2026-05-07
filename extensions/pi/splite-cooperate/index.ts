/**
 * splite-cooperate — pi extension that signals a cell's working/idle
 * state to splited.
 *
 * Drop into ~/.pi/agent/extensions/splite-cooperate/ on any cell that
 * runs pi. Listens to pi's lifecycle events and POSTs to splited's
 * metadata server (host.splite:7879) so the watchdog never pauses the
 * cell mid-thought, and pauses it as soon as the agent says it's done.
 *
 * Two states, two endpoints:
 *   agent_start  → POST /v1/cells/me/working
 *   agent_end    → POST /v1/cells/me/sleep
 *
 * Best-effort. If the metadata server is unreachable (development host
 * isn't running splited, network partition, etc.), log and continue.
 * The watchdog falls back to its 60s touch-based heuristic.
 *
 * Note on /sleep semantics: this fires on every agent_end. If the agent
 * is doing rapid back-and-forth turns, that's fine — pause/resume is
 * sub-second and the next inbound request auto-resumes via splited's
 * ensureRunning path. If you want to debounce (don't sleep if another
 * turn is imminent), do it here: track a "last agent_end" timestamp and
 * only fire /sleep after N ms of no further agent_start.
 */

const SPLITE_HOST = process.env.SPLITE_METADATA_URL ?? "http://host.splite:7879";
const TIMEOUT_MS = 1000;

async function signal(verb: "working" | "sleep"): Promise<void> {
  const url = `${SPLITE_HOST}/v1/cells/me/${verb}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[splite-cooperate] ${verb} → ${res.status}: ${(await res.text()).slice(0, 100)}`,
      );
    }
  } catch (e) {
    // Metadata server unreachable — splited not running, no bridge, etc.
    // Best-effort; fall back to splited's outside-in heuristics.
    console.error(`[splite-cooperate] ${verb} unreachable: ${String(e).slice(0, 80)}`);
  }
}

export default function (pi: any) {
  pi.on("agent_start", async () => {
    await signal("working");
  });

  pi.on("agent_end", async () => {
    await signal("sleep");
  });
}
