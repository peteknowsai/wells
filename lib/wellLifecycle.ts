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
// `transitionWell` (B.0.7.g) is the orchestrator: takes the per-well
// lock, reads runtime.json, calls dispatchTransition, runs the
// actuator on `transition`, writes the resulting runtime. ensureRunning
// uses it for the wake-on-traffic contract (cells team, 2026-05-08):
// inbound proxy/exec/WS hits a hibernating well → transitionWell
// dispatches the wake verb → wakeWell restores the VM.

import { destroyWell } from "./destroy.ts";
import {
  hibernateWell,
  pauseWell,
  resumeWell,
  startWell,
  stopWell,
  wakeWell,
} from "./lifecycle.ts";
import { log } from "./log.ts";
import { withWellLock } from "./wellLock.ts";
import {
  defaultRuntime,
  nextState,
  readRuntime,
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

// Actuator table — one fn per verb. The dispatcher calls these on
// `transition` results. Each actuator is responsible for both the
// lume call AND the runtime.json update reflecting the new state.
// Injected so tests can substitute mocks without touching lume.
export interface Actuators {
  start: (name: string) => Promise<void>;
  stop: (name: string) => Promise<void>;
  pause: (name: string) => Promise<void>;
  resume: (name: string) => Promise<void>;
  hibernate: (name: string) => Promise<void>;
  wake: (name: string) => Promise<void>;
  destroy: (name: string) => Promise<void>;
}

export interface TransitionOutcome {
  kind: "noop" | "transition";
  from: WellState;
  to: WellState;
}

// Orchestrate a single lifecycle transition through the state
// machine. Acquires the per-well lock, reads the current runtime,
// dispatches against validTransitions, and runs the actuator if the
// dispatch result is a real transition. Returns the resulting
// outcome shape so callers can log, but throws on invalid
// transitions (caller surfaces the error to the user).
//
// On invalid: throws with the dispatchTransition `reason`.
// On noop: returns immediately, no actuator call, no runtime write.
// On transition: runs the actuator (which writes the runtime); the
// orchestrator does NOT write runtime itself, since the actuator
// has more-specific knowledge of side fields (hibernate_path,
// restore_recipe, last_error, etc.).
export async function transitionWell(
  name: string,
  verb: LifecycleVerb,
  actuators: Actuators,
): Promise<TransitionOutcome> {
  return withWellLock(name, async () => {
    const runtime = (await readRuntime(name)) ?? defaultRuntime();
    const result = dispatchTransition(runtime.state, verb);
    if (result.kind === "invalid") {
      throw new Error(`transitionWell: ${result.reason}`);
    }
    if (result.kind === "noop") {
      log.info("transitionWell: noop", {
        name,
        verb,
        state: result.state,
      });
      return { kind: "noop", from: result.state, to: result.state };
    }
    // Real transition: actuate. The actuator handles its own
    // runtime.json write.
    log.info("transitionWell: transition", {
      name,
      verb,
      from: result.from,
      to: result.to,
    });
    await actuators[verb](name);
    return { kind: "transition", from: result.from, to: result.to };
  });
}

// Default actuators wrap the existing lifecycle.ts functions. Each
// drops its return value (StopResult, StartResult) — callers that
// need IP/bootMs read them via resolveWellIp / runtime.json after
// the orchestrator returns. Keeping the orchestrator strict on
// `void` actuators makes the table uniform.
export const defaultActuators: Actuators = {
  start: async (name) => {
    await startWell(name);
  },
  stop: async (name) => {
    await stopWell(name);
  },
  pause: pauseWell,
  resume: resumeWell,
  hibernate: hibernateWell,
  wake: wakeWell,
  destroy: async (name) => {
    await destroyWell(name);
  },
};
