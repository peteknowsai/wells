# Wells — State schema

What lives where, and who owns it. The daemon (`welld`) is the single
writer of `~/.wells/` once Phase 8 lands; until then, the CLI writes
directly. Lume owns its own bundle directory (`~/.lume/<name>/`) — wells
clonefiles into it rather than writing config there.

## `~/.wells/` (wells-owned)

```
~/.wells/
├── token                       Bearer token for welld's REST API. mode 0600. auto-generated.
├── defaults.json               Resource defaults (cpu/memory/disk). Optional; missing → hardcoded fallback.
├── registry.json               Well roster — source of truth for "which wells exist". mode 0600.
├── images/
│   └── ubuntu-25.10-base/
│       ├── cloud-image.img     Pristine Canonical download (qcow2-with-.img-ext). Input.
│       ├── cloud-image.raw     qemu-img convert → raw. Apple Virt won't boot qcow2 directly.
│       ├── disk.img            Baked output: clone source for every well. Frozen.
│       ├── build-key + .pub    Build-time ssh key (host → staging VM during bake).
│       ├── user-data.composed.yaml
│       ├── network-config.yaml
│       └── cidata.iso          Cloud-init seed used during the bake.
├── vms/<name>/                 Per-well identity + transient artifacts.
│   ├── ssh_key + ssh_key.pub   Per-well ssh key (host → well).
│   ├── user-data.composed.yaml Composed cloud-init (template + host pubkey + well pubkey).
│   ├── network-config.yaml     v2 cloud-init network config (DHCP wildcard NIC).
│   ├── cidata.iso              NoCloud datasource ISO. Mounted at boot via `lume run --mount`.
│   ├── meta.json               Well-level metadata: name, cidata path, ssh_key path, lume_run_log.
│   ├── lume-run.log            Stdout/stderr of the detached `lume run` subprocess.
│   └── checkpoints/<id>/       APFS clonefile of the well's disk.img at checkpoint time. (Phase 6)
└── services/<name>.json        Declarative service definitions per well. (Phase 9)
```

### `registry.json` shape

```jsonc
{
  "wells": [
    {
      "name": "pete",
      "uuid": "f3e8a1b2-...",
      "created_at": "2026-05-06T18:42:11.000Z",
      "cpu": 4,
      "memory": "4GB",
      "disk_size": "50GB"
    }
  ]
}
```

Atomic writes via tmp+rename. mode 0600 — the file is private even though
well *names* are non-secret, because future fields (tokens, secrets,
service env) are not.

### `defaults.json` shape

```jsonc
{ "cpu": 4, "memory": "4GB", "disk": "50GB" }
```

Missing keys fall back to the hardcoded defaults in `lib/defaults.ts`.
Hardcoded values are tuned for shared-host use (multiple wells cohabiting
one Mac Mini), not bare-metal sprites.

### `vms/<name>/meta.json` shape

```jsonc
{
  "name": "pete",
  "cidata": "/Users/pete/.wells/vms/pete/cidata.iso",
  "ssh_key": "/Users/pete/.wells/vms/pete/ssh_key",
  "lume_run_log": "/Users/pete/.wells/vms/pete/lume-run.log"
}
```

Sidecar to the registry record. Holds paths that aren't worth bloating the
registry with but are useful for debugging and for `well info`.

## `~/.lume/<name>/` (lume-owned)

```
~/.lume/<name>/
├── disk.img       Well's live filesystem. Created by `lume create`, then
│                  clonefile-overwritten with the baked base disk and truncated
│                  to the requested size.
├── config.json    VM config (cpu, memory, mac, network, display).
└── nvram.bin      Apple Virtualization.framework NVRAM.
```

Don't edit these by hand. The path is configurable via `WELL_LUME_STORAGE`
(default: `~/.lume`) — see `engine/bundle.ts`. The disk lives here, not under
`~/.wells/vms/<name>/`, because lume owns the bundle layout.

Checkpoints (Phase 6) clone `~/.lume/<name>/disk.img` →
`~/.wells/vms/<name>/checkpoints/<id>/disk.img`.

## Lifecycle invariants

- **Registry is canonical.** `well list` reads `registry.json`; lume's view
  may include staging bundles or stale VMs that aren't tracked wells.
- **Lume's bundle is the live disk.** Stop/start preserves the bundle. Destroy
  removes both the registry record and the bundle.
- **Cidata is one-shot.** It's mounted on first boot for cloud-init's NoCloud
  datasource; subsequent boots ignore it. Keep the file around for forensics
  but don't depend on it being mounted post-first-boot.
- **Build-time ssh key (in `images/`) ≠ per-well ssh key (in `vms/<name>/`).**
  The build key only has access to the staging VM during bake; per-well keys
  are how the host reaches a running well via `well exec`.

## Tests + overrides

- `WELL_STATE_DIR=/some/tmpdir` overrides the root for tests; `lib/state.ts`
  reads it on every call (no caching) so per-test temp dirs work cleanly.
- `WELL_LUME_STORAGE=...` overrides the lume bundle root.
