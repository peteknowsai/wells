# Wells — State schema

What lives where, and who owns it. The daemon (`welld`) is the single
writer of `~/.wells/`. Lume owns its bundle directory (`~/.lume/<name>/`) —
welld clonefiles into it and drives it via lume's HTTP API; raw filesystem
edits to `~/.lume/` are an anti-pattern.

## `~/.wells/` (wells-owned)

```
~/.wells/
├── token                       Bearer token for welld's REST API. mode 0600. auto-generated.
├── defaults.json               Resource defaults (cpu/memory/disk/auto_sleep_seconds). Optional.
├── registry.json               Well roster — source of truth for "which wells exist". mode 0600.
├── images/
│   ├── ubuntu-25.10-base/
│   │   ├── cloud-image.img     Pristine Canonical download. Input to the bake.
│   │   ├── cloud-image.raw     qemu-img convert → raw (Apple Virt won't boot qcow2).
│   │   ├── disk.img            Baked output: clone source for every well. Frozen.
│   │   ├── build-key + .pub    Build-time ssh key (host → staging VM during bake).
│   │   ├── user-data.composed.yaml
│   │   ├── network-config.yaml
│   │   ├── cidata.iso          Cloud-init seed used DURING THE BAKE ONLY (the bake's source
│   │   │                       is Canonical's cloud-init image; per-well wells does not
│   │   │                       use cloud-init).
│   │   └── meta.json
│   └── <user-saved-image>/     `well image save` outputs land here (APFS clonefile + meta).
├── vms/<name>/                 Per-well welld state. NOT the live disk — that's in ~/.lume/.
│   ├── ssh_key + ssh_key.pub   Per-well ssh keypair (host → well, never sent to remote).
│   ├── cidata.iso              Per-well seed disk. Built by `lib/wellSeed.ts` (well.env +
│   │                           authorized_keys + optional etc-environment.append). Read by
│   │                           `well-firstboot.service` on first boot — NOT cloud-init.
│   ├── meta.json               Well-level metadata (see shape below).
│   ├── runtime.json            State machine: state + hibernate_ready + restore_recipe + ...
│   ├── policy.json             Network egress rules (optional — present after first POST
│   │                           to /v1/wells/<n>/policy/network).
│   ├── hibernate.bin           VZ saved-state blob (RAM + CPU + device snapshot).
│   ├── hibernate.config.json   VZConfigSnapshot of device shape at save time (used by
│   │                           wake to fail-fast on config drift before VZ rejects).
│   ├── hibernate.config.restore.json   Snapshot taken at restore time for offline diff.
│   ├── lume-run.log            Stdout/stderr of detached lume subprocesses for this well.
│   └── checkpoints/<id>/       APFS clonefile of the well's disk.img at checkpoint time.
│       ├── disk.img
│       └── meta.json
├── services/<name>/<id>.json   Per-well declarative service definitions (cells's site-server etc).
└── ssh-control/                ControlMaster sockets for SSH multiplexing across exec calls
                                (cuts per-call overhead from ~150ms handshake to ~10ms).
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
      "disk_size": "50GB",
      "auth": "well",
      "auto_sleep_seconds": null,
      "pinned_ip": "192.168.64.107",
      "mac_address": "fe:e8:4c:5d:bf:b9",
      "lume_name": "pool-abcd1234",
      "service_user": "cell",
      "r2": { "endpoint": "...", "bucket": "...", "access_key_id": "...", "secret_access_key": "..." }
    }
  ]
}
```

Atomic writes via tmp+rename. mode 0600 — `r2.secret_access_key` is real secret material; everything else is at-rest-private as a defense in depth. Fields beyond `disk_size` are optional (older records pre-date them; createWell sets `auth` on every new record).

`lume_name` is a legacy field from the pre-Pi2 pool implementation — it differs from `name` only on pool-adopted wells where welld renamed `~/.wells/vms/<op-name>/` while the lume bundle kept its `pool-XXXX` name. Post-Pi2 (pool moved to cells, 2026-05-13), no new wells write this field; existing records with it are preserved by `resolveLumeName(name)`. Future bundles always use `lume_name == name`.

### `defaults.json` shape

```jsonc
{
  "cpu": 4,
  "memory": "4GB",
  "disk": "50GB",
  "auto_sleep_seconds": 60
}
```

Missing keys fall back to hardcoded values in `lib/defaults.ts`.

### `vms/<name>/meta.json` shape

```jsonc
{
  "name": "pete",
  "cpu": 4,
  "memory": "4GB",
  "disk_size": "50GB",
  "baseImage": "ubuntu-25.10-base"
}
```

Sidecar to the registry record. Holds the create-time inputs for `well info`. Tolerant readers (`lib/createWell.ts:readMeta`) treat missing-or-malformed as "no meta" — they don't throw, because the file may not exist mid-create.

### `vms/<name>/runtime.json` shape

```jsonc
{
  "state": "alive_running",
  "last_transition_at": "2026-05-13T19:45:00.000Z",
  "last_error": null,
  "hibernate_path": null,
  "restore_recipe": null,
  "hibernate_ready": true,
  "birth_media_detached_at": "2026-05-13T19:45:00.000Z",
  "steady_state_mount": null,
  "ip": "192.168.64.234",
  "xpc_child_pid": 12345
}
```

`hibernate_ready` is initially `false` from `defaultRuntime()` on every `POST /v1/wells`. `POST /v1/wells/<n>/seal` flips it to `true` after halting + restarting the VM without cidata (see `docs/cells-pool-builder-primitives.md`). The `/hibernate` gate refuses unless this flag is true. `ip` is stamped at create + wake + seal time; `xpc_child_pid` tracks the well's `VirtualMachine.xpc` child for W.74 sibling-survive hibernate.

The wells lifecycle source of truth (B.0.7). Persists state independently of lume so welld can converge after a lume crash + restart. State machine in `lib/wellRuntime.ts:validTransitions`; transitions dispatched through `lib/wellLifecycle.ts:transitionWell`.

## `~/.lume/<name>/` (lume-owned bundle)

```
~/.lume/<name>/
├── disk.img       Well's live filesystem. Created by `lume create`, then APFS-clonefile
│                  -overwritten with the baked base disk and truncated to the requested size.
├── config.json    VZ config snapshot (cpu, memory, MAC, machineIdentifier, storage,
│                  network). VZ requires byte-identical config across save/restore.
└── nvram.bin      EFI firmware vars.
```

Don't edit by hand. The path is configurable via `WELL_LUME_STORAGE` (default: `~/.lume`) — see `engine/bundle.ts`. The disk lives here, not in `~/.wells/vms/<name>/`, because lume owns the bundle layout and Apple's VZ frameworks pin paths.

Checkpoints clone `~/.lume/<name>/disk.img` → `~/.wells/vms/<name>/checkpoints/<id>/disk.img`. Checkpoints live under wells's tree so they survive lume's bundle teardown.

## Lifecycle invariants

- **Registry is canonical.** `well list` reads `registry.json`; lume's view (`lume.list`) may include staging bundles or stale entries that aren't tracked wells.
- **Welld is the only writer of `~/.wells/`.** The CLI never touches state directly — every operation goes through `apiClient.ts` → welld's REST.
- **Runtime.json is the lifecycle source of truth.** Lume/VZ status is observed input that can lie, lag, or crash; runtime.json + the reconcile loop are how welld stays consistent.
- **Cidata is birth media only.** Mounted at first boot for `well-firstboot.service` (NOT cloud-init — cloud-init was purged from `ubuntu-25.10-base` in B.0.9.d.4 — see `docs/MVP-PLAN.md` § B.0.9.d.4). `POST /v1/wells/<n>/seal` halts the VM and restarts it without the mount, flipping `hibernate_ready: true` in runtime.json. Without this seal, Apple's `restoreMachineStateFrom` fails on `cidata.iso` shape mismatch. Pre-Pi3 (before 2026-05-13), this sequence ran inside `createWell` when callers passed `hibernate_ready: true`; Pi3 exposed it as a separate REST verb so cells's pool builder can run it AFTER its provisioning step and capture the disk-only snapshot of the provisioned cell.
- **Build-time ssh key (in `images/`) ≠ per-well ssh key (in `vms/<name>/`).** The build key only has access to the staging VM during bake; per-well keys are how the host reaches a running well via `well exec`.

## Tests + overrides

- `WELL_STATE_DIR=/some/tmpdir` overrides the root for tests; `lib/state.ts:stateRoot()` reads it on every call (no caching) so per-test temp dirs work cleanly.
- `WELL_LUME_STORAGE=...` overrides the lume bundle root for tests.
- `WELL_TOKEN` / `WELL_API_URL` override the bearer + URL for `apiClient.ts`.
- `WELL_LUME_HOST` / `WELL_LUME_PORT` override the lume serve address (used by `engine/vwell.ts:LumeClient`).
