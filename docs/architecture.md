# Wells — Architecture

One-pager. Scope is in [`ROADMAP.md`](ROADMAP.md) and [`MVP-PLAN.md`](MVP-PLAN.md).

## Components

```
Mac Mini (arm64)
├── well                CLI binary (Bun TS). Thin client over HTTP to welld.
├── welld               Daemon (Bun TS). HTTP/WS on :7878. Sprites-shaped REST.
│   ├── State writer      Single owner of ~/.wells/
│   ├── Service supervisor (per-VM systemd unit translation)
│   ├── Reverse proxy     Routes *.wells.local → guest:8080
│   ├── Autosleep watchdog (Phase A)
│   └── Engine adapter    engine/lume.ts — only file that knows about lume
└── bin/lume              Vendored lume binary (Swift). Drives Virtualization.framework.
```

## Data flow

```
Pete @ Mac
   │
   ├─► well CLI ──HTTP──► welld :7878 ──► engine/lume.ts ──► bin/lume ──► Virtualization.framework
   │                            │                                                       │
   │                            └──► ~/.wells/                                         ▼
   │                                                                          Linux guest VM
   │                                                                          (Ubuntu 25.10 arm64)
   │
cells (CELLS_BACKEND=well)
   │
   └─► HTTP to SPRITES_API_URL=http://localhost:7878 ──► welld (same path as CLI)

External users (later phases)
   │
   └─► <name>.cells.md (CF Worker DO)
            │
            └──► WSS <name>.wells.cells.md (Cloudflare Tunnel) ──► welld reverse proxy ──► guest:8080
```

## State layout

```
~/.wells/
├── token                 Daemon bearer token (mode 0600, auto-generated)
├── registry.json         Well roster: name → uuid, paths, created_at, status
├── images/               Cached base images (one-time downloads, shared across wells)
│   └── ubuntu-25.10-base/
│       ├── disk.img      Built once via cloud-init, frozen
│       ├── kernel
│       └── meta.json
├── vms/<name>/           Per-well bundle. Cloned from images/ via APFS clonefile.
│   ├── disk.img          The actual filesystem the well sees
│   ├── lume.json         Lume VM config
│   ├── ssh_key           Per-well ssh private key
│   ├── ssh_host_key      Persistent host key (so reconnects don't warn)
│   ├── meta.json         Well metadata (name, created_at, base image hash, ip pin)
│   └── checkpoints/
│       └── <id>/
│           ├── disk.img  CoW clone of the well's disk at checkpoint time
│           └── meta.json
└── services/<name>.json  Per-well declarative service definitions
```

## Boundaries

- **CLI never touches state directly.** Always goes through welld's REST.
- **Welld is the single writer of `~/.wells/`.** No other process should write there.
- **The engine boundary is one file.** `engine/lume.ts` is the only place that knows about lume. Swapping engines (e.g., to Apple's `containerization` framework when its volume support matures) should be a one-file change.
- **Sprites compatibility lives in the REST shape, not the noun.** Path is `/v1/wells/...` (not `/v1/sprites/...`). Field shapes within bodies match sprites exactly. Cells's `CELLS_BACKEND=well` mode swaps the noun and the env var prefix; field-level code is unchanged.

## Auth

- Local-only by default. Daemon listens on `127.0.0.1:7878`. Token in `~/.wells/token` (mode 0600).
- Bearer auth: `Authorization: Bearer $WELL_TOKEN`.
- For external reach (CF Worker bridge), welld's reverse proxy enforces a different bearer (matches `CELLS_PROXY_SECRET` semantics in cells).

## Sprites compatibility surface

| Sprites primitive | Wells equivalent |
|---|---|
| `sprite create <n>` | `well create <n>` |
| `sprite destroy -s <n>` | `well destroy -s <n>` |
| `sprite exec -s <n> [--tty] -- <cmd>` | `well exec -s <n> [--tty] -- <cmd>` |
| `sprite stop` / `start` | `well stop` / `start` |
| `sprite checkpoint create / list / restore` | same |
| `sprite url update --auth=public` | same |
| `sprite api -s <n> /v1/sprites/<n>/policy/network ...` | `well api -s <n> /v1/wells/<n>/policy/network ...` |
| `POST /v1/sprites/{n}/services/{id}` (REST) | `POST /v1/wells/{n}/services/{id}` |
| `Authorization: Bearer $SPRITES_TOKEN` | `Authorization: Bearer $WELL_TOKEN` |
| `SPRITES_API_URL` | `WELL_API_URL` (cells flips this when `CELLS_BACKEND=well`) |

The CF Worker bridge in cells doesn't change. The only edit there: the WS target URL (sprite host → well host).
