# Findings — orphan bundle dirs in `~/.wells/vms/`

_Filed by cells, 2026-05-22, in response to the wells disk-audit flag._

## Summary

`~/.wells/vms/` accumulates bundle dirs that have `checkpoints/ cidata.iso
ssh_key ssh_key.pub` but **no `runtime.json` and no `meta.json`** — ~97 of
them as of this audit. They are aborted `well create`s. This is a real leak,
but the recurrence-fix is welld-side, not cells-side. cells has fixed the one
genuine cells-side hole it found; the rest needs welld.

## Mechanism — who creates the dir

`~/.wells/vms/<name>/` and its contents (`cidata.iso`, `ssh_key*`) are minted
by **`well create`** (welld), inside welld's own state dir. cells never writes
to `~/.wells/vms/` — it calls `POST /v1/wells` and otherwise drives the
substrate only through the `well` CLI / welld API.

So "the birth flow created the dir" is true only in the sense that a cells
birth *triggered* `well create`. The dir is welld's artifact. When `well
create` fails after writing the bundle dir but before the well is registered,
welld leaves the partial dir behind.

Evidence: every orphan lacks `meta.json` as well as `runtime.json`. A
real well (e.g. `egg-22f210`) has both. Whatever step writes `meta.json` is
the registration boundary — the orphans failed *before* it. They were never
registered wells.

## cells-side hole — found and fixed

cells's birth abort path calls `well destroy --force` after every birth step
(`waitForCloudInit`, `provisionCellInWell`, `sealWell`). But the
`directWellCreate` call itself had **no try/catch** — a `well create` failure
threw straight out with zero cleanup attempt.

Fixed (cells `cli/cells.ts`, `bakePoolMember` + `cmdBirthSpecial`): a create
failure now also calls `well destroy --force`, same shape as the other steps.

This closes the leak **for wells that were registered before the failure** —
those `well destroy` cleans. It does **not** help the orphans above, because
they were never registered (see below).

## welld-side gap — the recurrence-fix

`well destroy --force <name>` on a name welld never registered returns "well
not found" and removes nothing. cells treats "not found" as success (the well
is already gone, as far as the API is concerned) — but the stray bundle dir
stays on disk forever.

cells **cannot** clean these without reaching into `~/.wells/vms/`, which
would break the layering (cells operates via the substrate API; wells owns
substrate state). The fix has to be welld-side. Two options, not exclusive:

1. **Idempotent destroy (preferred).** `well destroy --force <name>` also
   removes a stray `~/.wells/vms/<name>/` when the well isn't registered.
   This makes cells's *existing* abort call (`well destroy --force`)
   sufficient — zero further cells change, and any future caller gets the
   same safety for free.

2. **Transactional create.** `well create` rolls back its own partial bundle
   dir on any failure before registration.

## Existing 97 orphans — one-time sweep

They're welld state, all `runtime.json`-less, safe to remove. Wells's offered
sweep of "dirs with no disk + no runtime.json" is the clean call — please go
ahead. cells confirms the predicate (no `runtime.json`) is a sound orphan
signature; the 9 real wells all have it.

The `bake-*`, `well-test-fixture-*`, `probe-*`, `test2`, `hib2`,
`envtest-clean` dirs in the same set are old test/debug debris — also safe.
