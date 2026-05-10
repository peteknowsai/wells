# splites — Board

Convention: tasks have IDs `W.{n}` for worker-queue items that don't map to a specific MVP-PLAN checkbox; `phase X.Y.Z` for items that map directly to a checkbox in `docs/MVP-PLAN.md` (close them in MVP-PLAN as part of the same commit). Owner: `worker`, `steward`, or `pete`. Tags: `cells-coordination`, `lume-vendor`, `code`, `docs`, `cost-approval-needed`, `decision-needed`, `needs-pete-session`.

> **State as of 2026-05-10 04:30 UTC:** Cells team unblocked (WS proxy 1011 fix promoted to `wells-stable-2026-05-10a`). Pete's three queued priorities below: close out A.2 R2 polish, then image library on R2, then attack the lume `@MainActor` variance.

---

## In Progress

_(empty)_

---

## Todo (priority order)

### Pete's three (2026-05-10)

- [ ] **W.1 — A.2 R2 GC tracks local retention.** When local checkpoint retention rotates a checkpoint out, also remove the corresponding R2 object. New env `WELL_R2_RETAIN_FOREVER=1` to keep R2 forever (matches the existing MVP-PLAN A.2 box). Touches `lib/checkpoints.ts` retention path + `lib/r2.ts` delete; add 2-3 tests covering rotate-with-r2, rotate-without-r2, and the retain-forever opt-out. **Closes:** `docs/MVP-PLAN.md` § A.2 — "R2 GC tracks local retention." Owner: `worker`. Tags: `code`.

- [ ] **W.2 — A.2 R2 round-trip smoke.** New `scripts/smoke-r2-sync.sh` (or `.ts`) that creates a checkpoint with R2 configured, verifies the R2 object lands, deletes the local checkpoint, restores from R2, verifies disk integrity (sha256 match against the pre-delete snapshot). Should be runnable against dev welld :7879 with a real R2 bucket. **Closes:** `docs/MVP-PLAN.md` § A.2 — "Smoke: round-trip." Owner: `worker`. Tags: `code`. **Depends on R2 creds being available** — if they're not, mark Blocked with `needs-pete-session: r2-creds — bucket+key+secret for smoke-only test bucket`.

- [ ] **W.3 — Image library on R2: design.** Pete's idea — push baked images (`~/.wells/images/<image-name>/`) to R2 so a fresh Mac can bootstrap in ~1 min instead of ~30 min re-bake. **Phase E enabler** (multi-Mac Colony) but useful sooner for personal disaster recovery + collaborator onboarding. First fire: write `docs/proposals/image-library-on-r2.md` covering bucket layout (`<bucket>/images/<image-name>/{disk.img, meta.json, manifest.json}`), versioning (manifest-based or content-hashed?), credentials story (where do the bucket creds live? per-image or per-Mac?), CLI surface (`well image push <name>`, `well image pull <name>`, `well image list --remote`), and the security boundary (a base image is essentially a fresh boot disk — anyone with bucket read can boot it). **Don't ship code until Pete reviews the proposal.** Owner: `worker` for the proposal; `pete` for the review. Tags: `docs`, `decision-needed`.

- [ ] **W.4 — Image library on R2: push half.** Implement `well image push <name>` after W.3 is approved. Streams `disk.img` to R2, writes meta.json, updates a remote manifest. Owner: `worker`. Tags: `code`. **Depends on:** W.3.

- [ ] **W.5 — Image library on R2: pull half.** Implement `well image pull <name>` (and an implicit-pull path during `well create --from-image` if missing locally). Owner: `worker`. Tags: `code`. **Depends on:** W.4.

- [ ] **W.6 — Lume `@MainActor` variance — diagnose.** Per `docs/MVP-PLAN.md` § B.0.9.d.5.b residual: ~20% of smoke cycles bump 15-15.5s on create+warm because lume's MainActor still occasionally hangs even after B.0.11.h. Diagnose with `sample` against a stuck lume PID across 30+ cycles; identify the remaining blocking call(s). May require lume-side changes (separate sub-branch). First fire: instrument welld's create+warm to log per-phase timings, run 50 cycles, capture distribution. Owner: `worker`. Tags: `code`, `lume-vendor` (if a fix requires lume changes). **Don't ship a lume patch this fire** — fix scope decided after diagnosis.

- [ ] **W.7 — Lume `@MainActor` variance — fix or escalate.** Based on W.6 findings: either ship a targeted fix (probably async probe machinery instead of bounded blocking) or write `docs/findings-lume-mainactor-variance.md` and mark `needs-pete-session: lume-patch — <approach>`. Owner: `worker`. Tags: `code`, `lume-vendor`. **Depends on:** W.6.

### Housekeeping (queued for if the above unblock)

- [ ] **W.8 — Audit `docs/MVP-PLAN.md` § A.1.3 cleanup.** Several A.1 sub-items shipped via B.0.9 work but the boxes weren't ticked. Walk § A.1.3 and tick anything that's actually done. No code, doc-only. Owner: `worker`. Tags: `docs`.

---

## Blocked

_(empty)_

---

## Done

_Recently shipped (last ~24h). Older items live in git log + `docs/cells-integration.md` Promotions table._

- [x] **2026-05-10 04:22 UTC** — WS proxy 1011 fix shipped + promoted to `wells-stable-2026-05-10a`. `lib/proxy.ts:buildUpstreamWsInit` forwards client headers + subprotocols to upstream WS. Cells team `cells talk` repro unblocked. Commits: `9c7a34c`, `59b2941`, `3477980`, `41d92ab`. See `docs/cells-integration.md` for the full Promotions row.
- [x] **2026-05-09** — A.1 phase fully shipped (pre-warmed pool, sub-3s `well create`, `well pool` CLI + REST). Promoted to `wells-stable-2026-05-09j`.
