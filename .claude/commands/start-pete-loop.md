---
description: Start Pete Loop — runs /worker continuously after each turn until /stop-pete-loop or 200 iterations
---

Start Pete Loop. This activates the Stop hook at `.claude/hooks/pete-loop-stop.sh` which re-injects the worker prompt after every turn until the loop is stopped or hits MAX_ITER (200).

1. Run: `echo "0" > /Users/pete/Projects/wells/.claude/.pete-loop.active`
2. Confirm to chat (one sentence): `Pete Loop started. Worker fires after every turn. /stop-pete-loop to halt; otherwise auto-stops at 200 iterations.`
3. **Then immediately execute the worker loop body**: read `/Users/pete/Projects/wells/.claude/loops/worker.md` and follow it precisely. Do NOT use AskUserQuestion. Output ≤1 sentence to chat about what you did this fire.

The Stop hook fires when this turn ends and re-injects the worker prompt — that's how iteration N+1 begins.

Settings reminder: the Stop hook needs to be wired up in `~/.claude/settings.local.json` (or project settings). If it isn't, the loop won't auto-continue. See `docs/setting-up-pete-loop.md` § "Step 6 — Wire the Stop hook into settings."
