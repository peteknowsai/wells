# Wells — Architecture

One-pager. Scope is in [`ROADMAP.md`](ROADMAP.md) and [`MVP-PLAN.md`](MVP-PLAN.md).

## Components

```
Mac Mini (arm64)
├── well                CLI binary (Bun TS). Thin client over HTTP to welld.
├── welld               Daemon (Bun TS). HTTP/WS on :7878. Sprites-shaped REST.
│   ├── Router            HTTP/WS dispatch + bearer auth + watchdog touches
│   ├── lib/handlers/     Pure orchestration per endpoint (deps-injected, unit-tested)
│   ├── State writer      Single owner of ~/.wells/
│   ├── Service supervisor (per-VM systemd unit translation)
│   ├── Reverse proxy     Routes <name>.$WELL_PUBLIC_BASE → guest:8080
│   ├── Autosleep watchdog (Phase A)
│   ├── Lume supervisor   Restarts lume serve on crash; retries DHCP staleness
│   └── Engine adapter    engine/vwell.ts — only file that knows about lume
└── bin/vwell             Wrapper that execs bin/vwell.app/Contents/MacOS/lume (Swift,
                          vendored from upstream lume @ engine/vwell-src/). Drives
                          Apple's Virtualization.framework.
```

## Data flow

```
Pete @ Mac
   │
   ├─► well CLI ──HTTP──► welld :7878 ──► engine/vwell.ts ──► bin/vwell ──► Virtualization.framework
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

The `lume_name` field on registry records is legacy from the pre-Pi2 pool: it differed from `name` only for pool-adopted wells whose lume bundle kept its `pool-XXXX` name. Post-Pi2 (pool moved to cells, 2026-05-13), no new wells write it; existing pre-Pi2 records with it are still honored by `resolveLumeName(name)`. New wells always have `lume_name == name`.

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

Every well gets two host-reachable users:

- **`root`** (home: `/root`) — the SSH entry user. `templates/well-firstboot.sh` lays the operator's host key into `/root/.ssh/authorized_keys` at first boot; the sshd drop-in pins `PermitRootLogin prohibit-password` (key-based root login, no passwords). `well exec`, `well console`, and the `/v1/wells/{n}/exec` HTTP/WS endpoints all SSH in as `root`.
- **`ubuntu`** — the cloud-image default user, present for raw-VM debug. Override via `--user ubuntu` or `{"user":"ubuntu"}`.

Wells running cells's stack also carry a **`cell`** user (`/cell`), baked into cells's `cell-base` image; reachable via `--user cell`. It is a cells-side artifact — wells's substrate does not depend on it.

`well exec`, `well console`, and the exec endpoints **default to running as `root`** (HOME=/root). The VM is the sandbox boundary, so there's no privilege reason to land lower. A non-root `--user` sudo-switches with `-H` so HOME matches the target user.

> The `well` user (a per-well SSH transport account that exec sudo'd away from) was removed 2026-05-22 — see `docs/proposals/ssh-as-root-drop-well-user.html`. SSH lands as root directly; there is no transport hop.

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
