// Lifecycle dispatcher — single point that classifies a (state, verb)
// request as one of three outcomes:
//   1. noop       — verb's intent already satisfied; safe to short-
//                   circuit without touching lume.
//   2. transition — real state change; caller actuates via lume,
//                   reconciles, then writes the new runtime.
//   3. invalid    — verb is not a legal transition from current
//                   state; caller surfaces the error to the user.
//
// Per Pete's B.0.7.e directive: every verb on every state must
// return one of these three shapes. No silent failures. No
// ambiguous "stopped" results from a failed restore (those are
// `error_orphaned` per `wakeWell` in lib/lifecycle.ts).
//
// The classification is pure — no IO. B.0.7.g will wrap this in a
// dispatcher that takes the per-well lock, reads runtime.json,
// calls dispatchTransition, actuates lume on `transition`, and
// writes the resulting runtime. This file just owns the table
// interpretation.

import {
  nextState,
  type LifecycleVerb,
  type WellState,
} from "./wellRuntime.ts";

export type DispatchResult =
  | { kind: "noop"; state: WellState }
  | { kind: "transition"; from: WellState; to: WellState }
  | { kind: "invalid"; reason: string };

// Pure: classify a (current, verb) pair against validTransitions.
// Idempotent-by-design: when next === current, return `noop`. The
// dispatcher uses this to skip lume calls for verbs whose intent is
// already satisfied (e.g. wake-on-running, hibernate-on-hibernating).
export function dispatchTransition(
  current: WellState,
  verb: LifecycleVerb,
): DispatchResult {
  const next = nextState(current, verb);
  if (next === undefined) {
    return {
      kind: "invalid",
      reason: `cannot ${verb} from ${current}`,
    };
  }
  if (next === current) {
    return { kind: "noop", state: current };
  }
  return { kind: "transition", from: current, to: next };
}
