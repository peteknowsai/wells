# Wells — Architecture

One-pager. Scope is in [`ROADMAP.md`](ROADMAP.md) and [`MVP-PLAN.md`](MVP-PLAN.md).

## Components

```
Mac Mini (arm64)
├── well                CLI binary (Bun TS). Thin client over HTTP to welld.
├── welld               Daemon (Bun TS). HTTP/WS on :7878. Sprites-shaped REST.
│   ├── State writer      Single owner of ~/.wells/
│   ├── Service supervisor (per-VM systemd unit translation)
│   ├── Reverse proxy     Routes <name>.$WELL_PUBLIC_BASE → guest:8080
│   ├── Autosleep watchdog (Phase A)
│   ├── Lume supervisor   Restarts lume serve on crash; retries DHCP staleness
│   └── Engine adapter    engine/vwell.ts — only file that knows about lume
└── bin/lume              Vendored lume binary (Swift). Drives Virtualization.framework.
```

## Data flow

```
Pete @ Mac
   │
   ├─► well CLI ──HTTP──► welld :7878 ──► engine/vwell.ts ──► bin/lume ──► Virtualization.framework
   │                            │                                                       │
   │                            └──► ~/.wells/                                         ▼
   │                                                                          Linux guest VM
   │                                                                          (Ubuntu 25.10 arm64)
   │
cells (CELLS_BACKEND=well)
   │
   └─► HTTP to SPRITES_API_URL=http://localhost:7878 ──► welld (same path as CLI)
          /v1/sprites/... alias rewrites to /v1/wells/... at the top of fetch()

External users (later phases)
   │
   └─► <name>.cells.md (CF Worker DO)
            │
            └──► WSS <name>.wells.cells.md (Cloudflare Tunnel) ──► welld reverse proxy ──► guest:8080
```

## State layout

Wells's state splits across two roots: `~/.wells/` (welld-owned identity + control state) and `~/.lume/` (lume-owned VM bundles, including the actual `disk.img`). Welld is the single writer of both; `~/.lume/` belongs to lume in spirit, but our daemon's lifecycle drives it.

```
~/.wells/
├── token                       Daemon bearer token (mode 0600, auto-generated)
├── registry.json               Well roster: name → uuid, paths, created_at, status
├── pool/                       Pre-warmed pool members (A.1.4) — separate namespace from vms/
│   ├── registry.json           Pool state (members + their lifecycle state)
│   └── pool-XXXXXXXX/          One dir per member, parallel to vms/<name>/
├── images/                     Saved disk images. Source for `well create [--from-image]`.
│   ├── ubuntu-25.10-base/      Prebuilt base (bake-base-image.ts), shipped baseline.
│   │   ├── disk.img            Built once via cloud-init, frozen
│   │   └── meta.json
│   └── <user-saved-image>/     `well image save` outputs land here.
│       ├── disk.img            APFS clonefile of a stopped well's bundle disk
│       └── meta.json           {name, from_well, from_disk_size, created_at, ...}
├── vms/<name>/                 Per-well welld state (identity + saved-state, NOT the live disk).
│   ├── cidata.iso              Per-well seed disk (well.env + authorized_keys), built at create
│   ├── meta.json               Well metadata (name, created_at, base image, sizing)
│   ├── runtime.json            State machine: state + hibernate_ready + restore_recipe
│   ├── policy.json             Network egress rules (optional, written by `well api .../policy/network`)
│   ├── hibernate.bin           VZ saved-state blob (RAM + CPU + device snapshot)
│   ├── hibernate.config.json   VZConfigSnapshot of the device shape at save time
│   ├── ssh_key + ssh_key.pub   Per-well SSH keypair (host's view of the well)
│   └── checkpoints/<id>/
│       ├── disk.img            CoW clone of the well's disk at checkpoint time
│       └── meta.json
├── services/<name>/<id>.json   Per-well declarative service definitions
└── ssh-control/                ControlMaster sockets for SSH multiplexing across exec calls

~/.lume/<name>/                 Lume's VM bundle — the actual disk + VZ config live here.
├── disk.img                    The filesystem the well sees (APFS clonefile from images/)
├── config.json                 VZ config snapshot (cpu, memory, MAC, machineIdentifier, ...)
└── nvram.bin                   EFI firmware vars
```

Adopted-from-pool wells keep their pool-XXXX bundle name in `~/.lume/`, with `lume_name` in the registry pointing welld at the right bundle. The welld-side `~/.wells/vms/<op-name>/` is renamed to the operator's name; the lume bundle is not.

## Boundaries

- **CLI never touches state directly.** Always goes through welld's REST.
- **Welld is the single writer of `~/.wells/`.** No other process should write there.
- **The engine boundary is one file.** `engine/vwell.ts` is the only place that knows about lume. Swapping engines (e.g., to Apple's `containerization` framework when its volume support matures) should be a one-file change.
- **Sprites compatibility lives in the path alias and REST shape.** Both `/v1/sprites/...` and `/v1/wells/...` work — welld rewrites the former to the latter at the top of `fetch()`. Cells's `CELLS_BACKEND=well` mode swaps the env var prefix; no field-level code changes needed.

## Auth

- Local-only by default. Daemon listens on `127.0.0.1:7878`. Token in `~/.wells/token` (mode 0600).
- Bearer auth: `Authorization: Bearer $WELL_TOKEN`.
- For external reach (CF Worker bridge), welld's reverse proxy enforces a different bearer (matches `CELLS_PROXY_SECRET` semantics in cells).

## SSH users inside wells

Every well gets two SSH users:

- **`well`** (uid 1001, NOPASSWD sudo) — the agent user, the canonical target for cells's birth flow. `/home/well/.ssh/authorized_keys` is populated with the operator's host key at first boot via cloud-init. `well exec`, `well console`, and the daemon's `/v1/wells/{n}/exec` HTTP/WS endpoints all default to `well@<ip>`.
- **`ubuntu`** — the cloud-image default user, present for raw-VM debug. Override the default by passing `--user ubuntu` to the CLI or `{"user":"ubuntu"}` in the HTTP exec body.

## Sprites compatibility surface

| Sprites primitive | Wells equivalent |
|---|---|
| `sprite create <n>` | `well create <n>` |
| `sprite destroy -s <n>` | `well destroy -s <n>` |
| `sprite exec -s <n> [--tty] -- <cmd>` | `well exec -s <n> [--tty] -- <cmd>` |
| `sprite stop` / `start` | `well stop` / `start` |
| `sprite checkpoint create / list / restore` | same |
| `sprite url update --auth=public` | same |
| `sprite api -s <n> /v1/sprites/<n>/policy/network ...` | `well api -s <n> /v1/sprites/<n>/policy/network ...` (alias works) |
| `POST /v1/sprites/{n}/services/{id}` (REST) | `POST /v1/sprites/{n}/services/{id}` (alias) or `/v1/wells/{n}/services/{id}` |
| `Authorization: Bearer $SPRITES_TOKEN` | `Authorization: Bearer $WELL_TOKEN` |
| `SPRITES_API_URL` | `WELL_API_URL` (cells flips this when `CELLS_BACKEND=well`) |

The CF Worker bridge in cells doesn't change. The only edit there: the WS target URL (sprite host → well host).
