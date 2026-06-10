// Per-well async keyed mutex. Every lifecycle op (start/stop/pause/
// resume/hibernate/wake/checkpoint/destroy) acquires this lock before
// touching state. Without it, two pause requests can race the
// SharedVM cache, hibernate-during-stop can corrupt the runtime
// record, and proxy-wake collides with explicit start.
//
// Pete's B.0.7 directive treats lifecycle as a state machine; the
// state machine assumes serial transitions per well. This module is
// the serialization primitive.
//
// Implementation: a chain of promises per well. Each `withWellLock`
// call chains onto the current tail; subsequent callers await the
// chain to settle (regardless of success/failure of prior ops — a
// failed pause shouldn't permanently lock the well).

const chains = new Map<string, Promise<void>>();

// Run `fn` while holding the lock for `name`. Concurrent callers for
// the same name queue in arrival order. Different names run in
// parallel — locks are per-well.
//
// If `fn` throws, the lock is released (next caller proceeds) and the
// error is rethrown to the caller. Errors don't poison the queue.
export async function withWellLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve();
  // `myTurn` runs `fn` after prev settles, in either branch — we
  // don't want a failed prior op to block this call. Errors from
  // `fn` propagate to the awaiter via `myTurn`, but the chain tail
  // we store is error-swallowed so subsequent callers always advance.
  const myTurn = prev.then(fn, fn);
  const tail: Promise<void> = myTurn.then(
    () => undefined,
    () => undefined,
  );
  chains.set(name, tail);
  try {
    return await myTurn;
  } finally {
    // GC: if no one chained on us, drop the entry. Comparing object
    // identity works because `tail` is the exact reference we stored.
    if (chains.get(name) === tail) {
      chains.delete(name);
    }
  }
}

// True while any holder is inside (or queued for) this well's lock.
// For advisory peeks by maintenance passes that must not fight an
// in-flight transition (repairStaleDownRecords flipped a record back
// to alive_running mid-zombie-recovery, 2026-06-10 live-fire) — NOT
// for acquisition decisions; use withWellLock for that.
export function isWellLocked(name: string): boolean {
  return chains.has(name);
}

// Test hook: how many wells currently have a non-empty queue. Used
// only by unit tests; real callers don't need to know.
export function _activeLockCount(): number {
  return chains.size;
}

// Test hook: drop all locks. Don't call from production code — this
// will leak any in-flight callers' awaits. Tests use it between
// cases to keep state isolated.
export function _resetLocksForTests(): void {
  chains.clear();
}
