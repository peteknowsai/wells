// Cells signals to host.well:7879 (vmnet-bridge metadata server):
//   POST /lifecycle  body {"state":"busy"|"idle"}  watchdog hint
//
// Fire-and-forget from the cell's site server when pi emits
// agent_start / agent_end. Wells uses the signal as the primary
// "is the agent doing real work" gate for hibernation eligibility:
// busy = don't hibernate, idle = eligible.
//
// Source IP is the trust boundary (vmnet-leased IP → well name
// lookup). No auth, no body beyond `{state}`. Idempotent — repeats
// are harmless.
//
// Grace window (~30–60s after idle before hibernating) is NOT
// enforced here — auto_sleep_seconds (default 5min) already exceeds
// that. Add explicit grace only if we drop auto_sleep below ~60s.

import { markIdle, markWorking } from "./cellState.ts";

export type LifecycleState = "busy" | "idle";

export interface LifecycleParseResult {
  ok: boolean;
  state?: LifecycleState;
  error?: string;
}

// Pure parser — accept JSON text, return the validated state or an
// error string. Tested in isolation; the serve handler wraps it.
export function parseLifecycleBody(text: string): LifecycleParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "body must be an object" };
  }
  const state = (parsed as { state?: unknown }).state;
  if (state !== "busy" && state !== "idle") {
    return { ok: false, error: `state must be 'busy' or 'idle', got ${JSON.stringify(state)}` };
  }
  return { ok: true, state };
}

// Apply a parsed state to the busy tracker. Returns the well's
// resulting busy bit so the response can echo it back to cells.
// Idempotent: repeated `busy` or `idle` is a no-op on the underlying
// Set, matching the cells contract.
export function applyLifecycleState(
  name: string,
  state: LifecycleState,
): { busy: boolean } {
  if (state === "busy") {
    markWorking(name);
    return { busy: true };
  }
  markIdle(name);
  return { busy: false };
}
