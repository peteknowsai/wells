# Splites — Architecture

One-pager. Scope is in [`ROADMAP.md`](ROADMAP.md) and [`MVP-PLAN.md`](MVP-PLAN.md).

## Components

```
Mac Mini (arm64)
├── splite                CLI binary (Bun TS). Thin client over HTTP to splited.
├── splited               Daemon (Bun TS). HTTP/WS on :7878. Sprites-shaped REST.
│   ├── State writer      Single owner of ~/.splites/
│   ├── Service supervisor (per-VM systemd unit translation)
│   ├── Reverse proxy     Routes *.splites.local → guest:8080
│   ├── Autosleep watchdog (Phase A)
│   └── Engine adapter    engine/lume.ts — only file that knows about lume
└── bin/lume              Vendored lume binary (Swift). Drives Virtualization.framework.
```

## Data flow

```
Pete @ Mac
   │
   ├─► splite CLI ──HTTP──► splited :7878 ──► engine/lume.ts ──► bin/lume ──► Virtualization.framework
   │                            │                                                       │
   │                            └──► ~/.splites/                                         ▼
   │                                                                          Linux guest VM
   │                                                                          (Ubuntu 25.10 arm64)
   │
cells (CELLS_BACKEND=splite)
   │
   └─► HTTP to SPRITES_API_URL=http://localhost:7878 ──► splited (same path as CLI)

External users (later phases)
   │
   └─► <name>.cells.md (CF Worker DO)
            │
            └──► WSS <name>.splites.cells.md (Cloudflare Tunnel) ──► splited reverse proxy ──► guest:8080
```

## State layout

```
~/.splites/
├── token                 Daemon bearer token (mode 0600, auto-generated)
├── registry.json         Splite roster: name → uuid, paths, created_at, status
├── images/               Cached base images (one-time downloads, shared across splites)
│   └── ubuntu-25.10-base/
│       ├── disk.img      Built once via cloud-init, frozen
│       ├── kernel
│       └── meta.json
├── vms/<name>/           Per-splite bundle. Cloned from images/ via APFS clonefile.
│   ├── disk.img          The actual filesystem the splite sees
│   ├── lume.json         Lume VM config
│   ├── ssh_key           Per-splite ssh private key
│   ├── ssh_host_key      Persistent host key (so reconnects don't warn)
│   ├── meta.json         Splite metadata (name, created_at, base image hash, ip pin)
│   └── checkpoints/
│       └── <id>/
│           ├── disk.img  CoW clone of the splite's disk at checkpoint time
│           └── meta.json
└── services/<name>.json  Per-splite declarative service definitions
```

## Boundaries

- **CLI never touches state directly.** Always goes through splited's REST.
- **Splited is the single writer of `~/.splites/`.** No other process should write there.
- **The engine boundary is one file.** `engine/lume.ts` is the only place that knows about lume. Swapping engines (e.g., to Apple's `containerization` framework when its volume support matures) should be a one-file change.
- **Sprites compatibility lives in the REST shape, not the noun.** Path is `/v1/splites/...` (not `/v1/sprites/...`). Field shapes within bodies match sprites exactly. Cells's `CELLS_BACKEND=splite` mode swaps the noun and the env var prefix; field-level code is unchanged.

## Auth

- Local-only by default. Daemon listens on `127.0.0.1:7878`. Token in `~/.splites/token` (mode 0600).
- Bearer auth: `Authorization: Bearer $SPLITES_TOKEN`.
- For external reach (CF Worker bridge), splited's reverse proxy enforces a different bearer (matches `CELLS_PROXY_SECRET` semantics in cells).

## Sprites compatibility surface

| Sprites primitive | Splites equivalent |
|---|---|
| `sprite create <n>` | `splite create <n>` |
| `sprite destroy -s <n>` | `splite destroy -s <n>` |
| `sprite exec -s <n> [--tty] -- <cmd>` | `splite exec -s <n> [--tty] -- <cmd>` |
| `sprite stop` / `start` | `splite stop` / `start` |
| `sprite checkpoint create / list / restore` | same |
| `sprite url update --auth=public` | same |
| `sprite api -s <n> /v1/sprites/<n>/policy/network ...` | `splite api -s <n> /v1/splites/<n>/policy/network ...` |
| `POST /v1/sprites/{n}/services/{id}` (REST) | `POST /v1/splites/{n}/services/{id}` |
| `Authorization: Bearer $SPRITES_TOKEN` | `Authorization: Bearer $SPLITES_TOKEN` |
| `SPRITES_API_URL` | `SPLITES_API_URL` (cells flips this when `CELLS_BACKEND=splite`) |

The CF Worker bridge in cells doesn't change. The only edit there: the WS target URL (sprite host → splite host).
