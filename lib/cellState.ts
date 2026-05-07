// Per-cell "is the agent busy" tracking. Set from inside the cell via
// the metadata endpoint (/v1/cells/me/working, /idle). Watchdog respects
// it as a hard "don't pause" override — busy beats every other signal.
//
// Why no TTL or heartbeat in v1: keep the contract simple. The agent
// calls /working before doing work, /idle when done. If the agent
// crashes mid-work, the busy flag stays — the user notices a wedged
// cell and intervenes. Add TTL only if that turns out to actually be
// a problem.

const working = new Set<string>();

export function markWorking(name: string): void {
  working.add(name);
}

export function markIdle(name: string): void {
  working.delete(name);
}

export function isBusy(name: string): boolean {
  return working.has(name);
}

export function listBusy(): string[] {
  return [...working];
}

export function _resetForTests(): void {
  working.clear();
}
