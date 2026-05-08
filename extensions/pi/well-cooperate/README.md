# well-cooperate

A pi.dev extension. One job: when the agent's turn ends, immediately turn the cell off.

```ts
pi.on("agent_end", () => fetch("http://host.well:7879/v1/cells/me/sleep", { method: "POST" }));
```

That's it. The whole extension. From inside a well-hosted cell, drop this into your `.pi/settings.json`:

```json
{
  "extensions": [
    "node_modules/well-cooperate/index.ts"
  ]
}
```

(Or any path where pi can find it. See [pi's extensions docs](https://pi.dev) for placement options.)

## What this does

Every time the agent finishes a turn — LLM has fully stopped generating, all tool calls have completed — pi fires `agent_end`. The hook here POSTs to welld's metadata server, which pauses the cell's VM in milliseconds. The next inbound traffic auto-resumes the cell; agent state (model context, in-flight reasoning, conversation memory) is preserved bit-perfectly because pause is just `VZVirtualMachine.pause()` — every byte of RAM stays put, just frozen.

From the agent's perspective, it's always on. The host is *actually* alive only for the milliseconds the agent is generating tokens or executing a synchronous tool call. Every gap between turns is a pause. On a 48GB host with 4GB cells, this means hundreds of cells can coexist; whichever 8-or-so are actively generating at any given moment occupy RAM. The rest are paused, free.

## Configuration

Set `WELL_METADATA_URL` if your welld metadata server isn't at the default `http://host.well:7879` (it almost always is — `host.well` is seeded into `/etc/hosts` at first boot via cloud-init).

## What it does NOT do

- No `/working` signal. The agent doesn't need to tell welld it's busy mid-turn — by the time the watchdog might consider pausing, agent_end has already fired and the cell is off. The watchdog's outside-in 60s heuristic stays as a fallback for cells without this extension.
- No judgment / validation. agent_end is a deterministic state-machine transition. If the harness fires it, the agent is done. No second-guessing.
- No agent awareness. The agent has no model of pause/resume. It just feels always on.

## See also

- welld's cooperation API spec: `wells/docs/cooperation.md`
- The bigger thesis: `cells/docs/agency.md`
