# Finding: Pool adoption can't rename lume bundle dir

**Date:** 2026-05-09
**Surfaced by:** `scripts/smoke-pool-adopt.ts` first run
**Status:** Architectural constraint, fix scoped to a new sub-checkbox.

## What the smoke surfaced

After the smoke pre-filled 2 pool members and tried to adopt the first
one as `psm-moz4tm3a-1`, welld's `POST /v1/wells` returned:

```
lume POST /lume/vms/psm-moz4tm3a-1/restore-state → 400:
  Internal error: VZ config drifted between save and restore — 3 field(s) differ.
  First: bootLoader:
    VZEFIBootLoader(variableStore=/Users/pete/.lume/pool-36b3fa3a/nvram.bin)
    → VZEFIBootLoader(variableStore=/Users/pete/.lume/psm-moz4tm3a-1/nvram.bin)
```

Two more fields drifted (not enumerated in the error). Likely the
disk-image attachment path and probably the cidata path (though the
disk-only steady-state config should have dropped that already).

## What's happening

`adoptFromPool` does:
1. `mv ~/.wells-dev/pool/pool-XXXX/  →  ~/.wells-dev/vms/<op-name>/`
2. `mv ~/.lume/pool-XXXX/            →  ~/.lume/<op-name>/`
3. `lume restoreState` from the moved-to-new-path `hibernate.bin`

Step 3 fails because Apple's `VZVirtualMachineConfiguration` records
absolute paths for **boot loader** (nvram.bin) and **storage
attachments** (disk.img). When we try to restore against the renamed
config, VZ compares:

- saved-state config: paths under `/Users/pete/.lume/pool-XXXX/`
- live config built by lume from the renamed bundle:
  paths under `/Users/pete/.lume/<op-name>/`

VZ's strict drift check rejects the restore.

## Why B.0.11.g portability worked

Earlier portability probe (`exp-hibernate-portability.ts`) verified
that `hibernate.bin` IS portable across distinct bundles when the
destination mirrors the source's `machineIdentifier`, `macAddress`,
`memorySize`, `cpuCount`, **`nvram.bin`** copied into the destination
bundle.

The probe copied `nvram.bin` between bundles. We didn't catch this
because the experiment kept both bundle dirs alive simultaneously — it
restored bundle B from bundle A's `hibernate.bin` using bundle A's
`nvram.bin`. The absolute path `nvram.bin` referenced still pointed
to bundle A on disk — wasn't a rename, was a same-host duplicate.

Adoption is different: we're moving the bundle dir to a new path and
trying to restore from the moved `hibernate.bin`, which still
references the OLD path that no longer exists.

## Fix: don't rename the lume bundle

The lume-bundle directory name doesn't need to match the operator's
well name — that equivalence was a convention from the fresh-create
path, not a requirement.

Approach for A.1.4.c.iv:

1. Keep `~/.lume/pool-XXXXXXXX/` as-is across adoption.
2. Welld bundle directory still renames: `~/.wells-dev/pool/pool-XXX
   → ~/.wells-dev/vms/<op-name>/`.
3. Welld registry record stores both `name` (operator) and
   `lume_name` (the stable `pool-XXXX`).
4. All `LumeClient` calls keyed by `lume_name`. The DHCP/SSH/proxy
   layer keys by IP, so the operator-vs-lume name divergence is
   invisible to those layers.
5. `well destroy` cleans up `~/.lume/pool-XXXX/` via lume's name.

In-guest hostname will still be `pool-XXXX` until A.1.4.c.ii ships
identity reset, but that was already a known wart.

## Repro state

After this finding the dev pool has 2 ready members (no leakage
from the failed adoption — `reserveReadyMember` had transitioned the
target to `adopting`, but adoption's catch path leaves it there for
the audit trail). Next fire's first task: clean up the wedged
`adopting` member and ship the bundle-name-decoupling fix.

```bash
cat ~/.wells-dev/pool/registry.json
```

3 members visible: 2 ready + 1 adopting (wedged). The adopting one
needs manual cleanup (delete from registry + `lume delete pool-XXXX`
+ `rm -rf ~/.wells-dev/pool/pool-XXXX/`).

## Tests to pin

- Unit test: `adoptFromPool` keeps `member.name` as the lume-key,
  doesn't rename `~/.lume/<member.name>/`.
- Smoke retest: re-run `smoke-pool-adopt.ts`, both pool-served
  adoptions complete sub-2s.
