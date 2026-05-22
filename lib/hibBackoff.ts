// Time-bounded backoff for the watchdog's hibernate attempts.
//
// W.20 originally suspended a well's hibernate attempts PERMANENTLY
// after WATCHDOG_HIB_FAIL_THRESHOLD consecutive failures — the only
// thing that cleared the in-memory counter was a welld restart or a
// well destroy. That stranded wells: when the external blocker behind
// the failures cleared (e.g. an unsealed well finally getting sealed),
// welld had no idea, and the well stayed un-hibernatable until a bounce.
// Cells flagged this as "in-memory staleness" 2026-05-22.
//
// This makes the suspension time-bounded: crossing the threshold arms
// a cooldown window; once it elapses the backoff resets to a fresh
// slate and the watchdog retries. A still-broken well just re-suspends;
// a fixed one hibernates and clears. No bounce required.
//
// Pure — the welld watchdog owns the per-well Map<string, HibBackoffState>
// and the clock; this module only decides.

export interface HibBackoffState {
  // Consecutive failed hibernate attempts since the last success.
  failures: number;
  // Epoch ms until which hibernate attempts are suspended. null = the
  // well has not crossed the failure threshold (not suspended).
  suspendedUntil: number | null;
}

// At tick time, decide whether to skip this well's hibernate attempt.
//   skip=true            → still inside the cooldown window; do nothing.
//   cooldownElapsed=true → the cooldown just expired; caller should drop
//                          the well's backoff entry (fresh slate) and
//                          proceed with the attempt.
// A well with no entry, or one not yet suspended, passes straight through.
export function gateHibernate(
  state: HibBackoffState | undefined,
  nowMs: number,
): { skip: boolean; cooldownElapsed: boolean } {
  if (!state || state.suspendedUntil === null) {
    return { skip: false, cooldownElapsed: false };
  }
  if (nowMs < state.suspendedUntil) {
    return { skip: true, cooldownElapsed: false };
  }
  return { skip: false, cooldownElapsed: true };
}

// Record a failed hibernate attempt. Bumps the counter; crossing the
// threshold arms the cooldown. `justSuspended` is true only on the tick
// that crosses the line, so the caller can log the warn once.
export function recordHibFailure(
  state: HibBackoffState | undefined,
  nowMs: number,
  opts: { threshold: number; cooldownMs: number },
): { state: HibBackoffState; justSuspended: boolean } {
  const failures = (state?.failures ?? 0) + 1;
  if (failures >= opts.threshold) {
    return {
      state: { failures, suspendedUntil: nowMs + opts.cooldownMs },
      justSuspended: failures === opts.threshold,
    };
  }
  return { state: { failures, suspendedUntil: null }, justSuspended: false };
}
