# Wells's answers to Pieces 2 open questions

**From:** wells team
**To:** cells team
**Date:** 2026-05-13 post-V1
**Re:** `docs/proposals/wells-cells-boundary-cleanup.html` Q1–Q5

This is wells's side of the conversation on the five open questions left in the original proposal. Read this alongside the proposal — these are responses, not standalone material.

---

## Q1 — Pool state location

**Question:** Move pool state from `~/.wells/pool/` to `~/.cells/pool/`? Or keep at `~/.wells/` as a path cells happens to use?

**Wells's answer: move to `~/.cells/pool/`.**

The pool is a cells concept end-to-end — refill heuristics, depth targets, bake recipe versioning, variant strategy (harness × model × extensions). State that's exclusively read and mutated by cells code should live under cells's state directory. Symmetric with the existing pattern: `welld` owns `~/.wells/`, `cells` owns `~/.cells/`.

If cells wants to migrate existing eggs from `~/.wells/pool/` rather than draining-and-rebaking, they can read the existing pool registry once (still readable while wells's pool code is in deletion limbo) and write entries into their new state shape. Not blocking — most pool eggs cycle in 24-48 hours anyway, so "let attrition handle it" is a fine migration strategy too.

---

## Q2 — Identity reset

**Question:** Does `lib/identityReset.ts` stay in wells as a substrate primitive cells calls via SSH-over-`well exec`? Or move to cells entirely?

**Wells's answer: move to cells.**

`identityReset.ts` is 109 LoC of "SSH into the well and run a script that rotates hostname, machine-id, generates a new SSH host key, etc." Every line of it is shaped by what cells's agents need to be a "new identity." Wells doesn't have an opinion on what identity rotation means at the VM level — it's a cells concept.

What wells provides instead: `POST /v1/wells/<n>/exec` (sync) and the WS-upgrade variant. Cells SSHes in via that primitive and runs whatever identity rotation it wants. Same access pattern cells already uses for bake-time DNA installation.

Edge case worth flagging: there's a small race window where the well is awake from hibernate but cells hasn't rotated identity yet. During that window, the VM has the previous tenant's hostname / machine-id / SSH host key — visible to anything observing on the network. Cells's birth flow already brackets this (wake → SSH-as-root → rotate → SSH-as-cell-user), so the window is sub-second in practice. Not a wells-side concern.

---

## Q3 — Timing

**Question:** When's cells's next quiet window for ~2-3 days of focused pool migration?

**Wells's answer: cells's call. No urgency from our side.**

We just stamped V1 (06:35Z 2026-05-13). Reasonable to want a stabilization period — watch for V1 regressions before introducing a substantial architectural shift. From wells's side:

- We will pre-stage the wells-side deletion on `feature/piece-2-pool-delete` so the wells half is ready to land in one focused day whenever you give the signal.
- We will keep wells's pool code functional and non-regressing in the meantime. No new pool features, no scope expansion — pure maintenance.
- We will not delete anything until you tell us the cells-side replacement is shipped and you've run your acceptance against it.

If we had a preference: not before next week (give V1 time to bed in), not so late that we drift on the proposal (re-orienting after a month-plus would cost). But that's a soft preference, not a hard ask.

---

## Q4 — Wells's `/healthz` honesty

**Question:** Should wells report observed state warts-and-all (`status: "running", ip: null`), or a passive recovery hint (`status: "running_unreachable", hint: "stop+start to re-DHCP"`)?

**Wells's answer: raw observed state. No hints.**

The whole point of Piece 2 is wells stops holding cells-shaped invariants. "Running but unreachable, here's how you fix it" is exactly the kind of opinion that's cells's domain — wells offering a hint puts the inferential reasoning right back in the substrate layer where it caused the W.68 incident.

What wells reports:
- `status` — wells's state-machine view (e.g., `alive_running`, `hibernating`, `stopped`)
- `ip` — observed DHCP lease for that well's MAC. May be null if not yet leased or if the lease has expired without renewal.
- `mac` — assigned MAC address (deterministic per well)
- `runtime.state` — same as `status`, restated under `runtime` for consistency

What wells does NOT report:
- "Reachable" / "unreachable"
- "Recovery hint"
- Anything that requires reasoning about what cells's agents need to function

If cells wants a `reachable` derived field, cells computes it (probe the IP, or call the agent's WS endpoint, or whatever heuristic fits). Wells stays honest about what it observes, not what it infers.

---

## Q5 — Today's intermittent pool refill bug

**Question:** You noted at 09:19Z that pool refill still hits an intermittent DHCP timeout post-W.70. If we ship Piece 2, that debugging moves into cells. Comfortable with that?

**Wells's answer: yes, with one caveat.**

Pool refill is cells's bake recipe + cells's call to `POST /v1/wells` + cells's call to `POST /v1/wells/<n>/hibernate`. The DHCP-timeout failure mode is observable from both sides, but the root cause — whether it's a vmnet concurrency limit, a cidata race, a cloud-init timing issue, or something else — is reproducible from cells's call site without wells-side instrumentation.

**Caveat:** if cells's investigation surfaces something that IS substrate-shaped (e.g., "lume's `create` API loses requests under concurrent load," or "vmnet drops DHCP renewals when X happens"), kick it back to wells. We'll instrument the substrate layer and root-cause from there. Cells investigating doesn't mean cells is on the hook for substrate bugs — just for orchestration bugs.

Today's symptoms (intermittent DHCP timeout post-W.70) lean toward orchestration but I genuinely don't know. Fine to let cells's bake-flow rewrite be the next investigation surface.

---

## What wells team commits to before Piece 2 ships

1. Maintain wells's pool code without regression — no new features, no scope creep, just keep-the-lights-on patches if they're needed.
2. Pre-stage `feature/piece-2-pool-delete` with the deletion ready to go — gives cells a concrete artifact to point at when their side is done.
3. Polish the REST endpoint docs (the ones cells will need to build the new pool manager against). Existing docs may have gaps around timing/retry/error shapes.
4. Be available for design questions as cells builds the cells-side pool. We'll answer on the chat log; tag responses with the Q-number for cleanliness.

## What wells team will NOT do before Piece 2 ships

1. Delete any pool code on main. Pre-staged branch only.
2. Add a `lease-publisher`-style "I'll just enforce one tiny invariant" feature. We learned that lesson on W.68 + W.70.
3. Change the REST contract on the endpoints cells will be building against. Lock the surface during cells's migration so they can build to a stable target.

---

— wells team · 2026-05-13 · responses to `docs/proposals/wells-cells-boundary-cleanup.html`
