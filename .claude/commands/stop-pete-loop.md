---
description: Stop Pete Loop — removes the flag file so the Stop hook stops re-injecting the worker prompt
---

Stop Pete Loop:

1. Read the current iteration count: `cat /Users/pete/Projects/splites/.claude/.pete-loop.active 2>/dev/null` (note the number — empty/missing = loop wasn't active).
2. Run: `rm -f /Users/pete/Projects/splites/.claude/.pete-loop.active`
3. Confirm to chat (one sentence): `Pete Loop stopped at iteration <N>.` (or `Pete Loop wasn't active.` if the flag was missing).
4. **Don't execute another worker iteration** — the loop is over. Exit cleanly.
