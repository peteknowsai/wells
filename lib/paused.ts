// Track which splites are currently CPU-paused (alive-but-frozen). Lume's
// status field reports "running" for both running and paused VMs, so
// splited maintains its own view of which we paused.
//
// Why a Set, not a registry field: pause state is runtime-only. After a
// splited restart, the set is empty; the daemon's startup path resumes
// any running VMs defensively to ensure no cell is stuck paused.

const paused = new Set<string>();

export function markPaused(name: string): void {
  paused.add(name);
}

export function clearPaused(name: string): void {
  paused.delete(name);
}

export function isPaused(name: string): boolean {
  return paused.has(name);
}

export function listPaused(): string[] {
  return [...paused];
}

// Test hook.
export function _resetForTests(): void {
  paused.clear();
}
