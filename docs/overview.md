# Wells — overview

A one-page tour for someone meeting wells for the first time at the 1.0 release. For deeper material, this page links into [`architecture.md`](architecture.md), [`lifecycle.md`](lifecycle.md), [`cells-integration.md`](cells-integration.md), [`install.md`](install.md), and [`state-schema.md`](state-schema.md).

## What wells is

Wells is the local, owned counterpart to [sprites.dev](https://sprites.dev). It turns a Mac Mini in your closet into a stateful-Linux-machine factory: spin one up, talk to it, walk away. Each VM (a "well") has a filesystem that survives sleep, wake, and reboot; a stable URL on your own domain; and a wake-on-demand contract so it costs nothing when nobody's using it.

The substrate is **yours**:

- No `api.sprites.dev` dependency. Nothing to authenticate against. Nothing rotates.
- No metered RAM — a hibernating cell costs you disk, not dollars.
- No upstream company has to stay solvent for your fleet to keep working.

Wells is purpose-built to host [cells](https://github.com/anthropics/cells) — the agent-runtime project — but it's also a general-purpose stateful-Linux daemon. Anything that wants disposable Linux boxes with a survivable filesystem can use it.

**In plain English:** Imagine you have one Mac Mini sitting in your closet and you want it to act like a small Linux server farm — dozens of stateful little Linux machines, each holding its own filesystem, each reachable on a clean URL. Wells is the daemon that runs on the Mac to do exactly that. Cells is the project this was built to host; wells is the substrate underneath.

## The mental model

A `well` is to a Mac Mini what a `sprite` is to a cloud VM:

- A stateful Linux VM.
- A name you can reach it by (`pete`, `ck-pi-gpt55`, whatever).
- A filesystem that survives sleeping, waking, host reboots.
- A REST API for the lifecycle: create, exec, sleep, wake, destroy, checkpoint, restore.
- A reverse-proxy URL: traffic to `<name>.cells.md` reaches the well's guest.

The CLI verbs match sprites. The REST shapes match sprites. The mental model matches sprites. Cells's existing code targets the sprites API contract — flipping `CELLS_BACKEND=well` points it at a wells daemon instead. No field-level code changes needed.

**In plain English:** If you've used sprites, you already know how wells works — same nouns, same verbs. The difference is "where it runs" (your closet, not Anthropic's cloud) and "what it costs" (electricity, not metered RAM).

## The wells/cells line

Wells and cells are two projects that ship together but own different concerns. The split matters for anyone reading the code:

| Concern | Owner |
|---|---|
| **Substrate** (VMs, networking, lifecycle, REST contract) | **wells** |
| **Agent product** (cells, harnesses, models, conversation, V1 acceptance metrics) | **cells** |
| Pool of pre-warmed cells (as of Phase 2 of road-to-1.0) | **cells** |
| The CF Worker bridge to public URLs | cells |
| The "what does a healthy cell mean" definition | cells |
| The "what does a healthy well mean" definition | wells |

**Wells's job** is to provide a stable, observable, fast substrate: predictable latency, honest error rates, a clean concurrency model. **Cells's job** is to decide whether wells's wire is good enough for whatever agent product they want to ship — that's the team's call, not ours.

A useful rule: any decision that would still be open if wells were a third-party substrate (e.g. AWS) belongs to whoever's running the workload on it. Wells doesn't pick target latency budgets, doesn't decide acceptance metrics, doesn't queue product decisions onto wells operators.

**In plain English:** Wells is the floor. Cells is what's built on the floor. The split exists so each team can move at its own pace without stepping on the other. If a cells acceptance test fails on latency, that's a cells question first ("is our target right?") — wells just reports what the substrate measures.

## Components

```
Mac Mini (arm64)
├── well                CLI binary (Bun TS). Thin client over HTTP to welld.
├── welld               Daemon (Bun TS). HTTP/WS on :7878. Sprites-shaped REST.
│   ├── State writer      Single owner of ~/.wells/
│   ├── Service supervisor (per-VM systemd unit translation)
│   ├── Reverse proxy     Routes <name>.$WELL_PUBLIC_BASE → guest:8080
│   ├── Autosleep watchdog (hibernate on idle, wake on traffic)
│   ├── Lume supervisor   Restarts lume serve on crash; retries DHCP staleness
│   ├── Lease publisher   Owns /var/db/dhcpd_leases entries (single guardian)
│   └── Engine adapter    engine/vwell.ts — only file that knows about lume
└── bin/vwell             Wrapper that execs bin/lume.app/Contents/MacOS/lume (Swift,
                          vendored from upstream lume @ engine/vwell-src/). Drives
                          Apple's Virtualization.framework.
```

**In plain English:** Two layers — a daemon (`welld`) that runs all the time and remembers the fleet, and an engine (`vwell`, a fork of `lume`) that actually drives Apple's virtualization framework. The CLI (`well`) is a thin shell over the daemon. Everything below the daemon is replaceable: today we use Apple's Virtualization.framework on Mac via lume; on Linux we'd use Firecracker; if Apple's `containerization` framework matures, we swap to that. The engine boundary is one file.

## State layout

Wells's state splits across two roots on the host: `~/.wells/` (welld-owned) and `~/.lume/` (lume-owned bundles). Welld is the single writer of both.

```
~/.wells/
├── token                       Daemon bearer token (mode 0600, auto-generated at install)
├── registry.json               Well roster: name → uuid, paths, sizing, auto_sleep_seconds
├── defaults.json               Tunables: cpu/memory/disk defaults, auto_sleep_seconds
├── pool/                       Pre-warmed pool members (Phase 2 cells-owned in 1.0)
│   ├── registry.json
│   └── pool-XXXXXXXX/
├── images/                     Saved disk images for `well create --from-image`
│   ├── ubuntu-25.10-base/      Prebuilt base shipped baseline
│   └── <user-saved-image>/     `well image save` outputs land here
├── vms/<name>/                 Per-well welld state (identity + saved-state)
│   ├── cidata.iso              Per-well seed disk (built once, detached after first boot)
│   ├── meta.json               Well metadata (name, created_at, base image, sizing)
│   ├── runtime.json            State machine: state + hibernate_ready + restore_recipe
│   ├── hibernate.bin           VZ saved-state blob (RAM + CPU + device snapshot)
│   ├── hibernate.config.json   VZ device-shape snapshot at save time
│   ├── ssh_key, ssh_key.pub    Per-well SSH keypair
│   └── checkpoints/<id>/       CoW disk clones for `well checkpoint create`
├── services/<name>/<id>.json   Declarative service definitions
└── ssh-control/                ControlMaster sockets for exec multiplexing

~/.lume/<name>/                 The actual VM bundle — disk + VZ config
├── disk.img                    The filesystem the well sees (APFS clonefile)
├── config.json                 VZ config (cpu, memory, MAC, machineIdentifier)
└── nvram.bin                   EFI firmware vars
```

The split between `~/.wells/vms/<name>/` and `~/.lume/<name>/` matters operationally: the welld-side dir holds identity (you'd back this up to migrate a well), and the lume-side dir holds the live disk (regenerable from the image if you have the welld-side state).

**In plain English:** Two places. `~/.wells/` is wells's brain (what wells exist, their settings, their saved RAM images, their SSH keys). `~/.lume/` is lume's body (the actual virtual disk and VM config). If you wanted to move a well to a different machine, you'd carry `~/.wells/vms/<name>/` and rebuild the lume side from the image. Full doc: [`state-schema.md`](state-schema.md).

## REST contract

Welld listens on `127.0.0.1:7878` and serves three things from one port:

1. **API** — `/healthz` (no auth), `/v1/wells/...` (bearer auth). Sprites alias: `/v1/sprites/...` rewrites to `/v1/wells/...` at the top of `fetch()`.
2. **Reverse proxy** — when the request's `Host` header is `<name>.${WELL_PUBLIC_BASE}` (single label, exact suffix), welld looks up the well's IP and forwards to `<ip>:8080`. Per-well `auth` field can require a bearer.
3. **Per-host metadata + cooperation** — at `192.168.64.1:7879` (the bridge gateway from a guest's perspective). `host.well` inside a guest resolves to this. Used for `POST /sleep` from a cooperative agent that wants to hibernate itself.

### Headline endpoints

| Verb | Path | What it does |
|---|---|---|
| `GET` | `/healthz` | Daemon liveness + lume state + lease publisher health + vmnet lease counts |
| `GET` | `/v1/wells` | List wells |
| `POST` | `/v1/wells` | Create a well (`{name, from_image, auto_sleep_seconds?, ...}`) |
| `GET` | `/v1/wells/<name>` | Sprite-shaped resource (status, url, ip, created_at, sizing) |
| `POST` | `/v1/wells/<name>/start` | Wake a hibernated well (idempotent on alive_running) |
| `POST` | `/v1/wells/<name>/stop` | Operator stop (graceful via ACPI requestStop) |
| `POST` | `/v1/wells/<name>/sleep` | Hibernate (releases RAM, persists `hibernate.bin`) |
| `POST` | `/v1/wells/<name>/wake` | Restore from `hibernate.bin` |
| `POST` | `/v1/wells/<name>/exec` | Run a command (HTTP synchronous or WS streaming) |
| `POST` | `/v1/wells/<name>/checkpoints` | Snapshot disk to `checkpoints/<id>/disk.img` (CoW clone) |
| `DELETE` | `/v1/wells/<name>` | Destroy (releases DHCP lease, removes bundles) |
| `POST` | `/v1/lume/leases/flush` | Orphan-only DHCP lease cleanup (operator escape hatch) |
| `DELETE` | `/v1/lume/leases/<name>` | Release a specific orphan lease |
| `GET` | `/v1/wells/images` | List saved images (for `well create --from-image=<n>`) |

Auth is `Authorization: Bearer $WELL_TOKEN` for everything under `/v1/`. The token lives at `~/.wells/token` (mode 0600). `/healthz` is always public.

Important behavioral note: **`GET /v1/wells/<name>` touches the watchdog's activity timer**. Polling status counts as activity. If a future use case needs silent observation (a dashboard that doesn't keep wells alive), it would need a separate read-only endpoint. See [`findings-scenario-coverage.md`](findings-scenario-coverage.md) § "Observability touch."

**In plain English:** One daemon, one port, three uses. The first is the management API the CLI talks to. The second is the front door for HTTPS traffic to your wells (so `pete.cells.md` reaches the well named `pete`). The third is a tiny "self-hibernate" hook the guest can call from inside. Bearer auth on the API; the public-facing proxy uses per-well auth. Full sprites compatibility table in [`architecture.md`](architecture.md#sprites-compatibility-surface).

## Lifecycle

A well lives in one of three states. The watchdog drives the transitions; the operator can drive them too.

| State | Memory | Disk | Wake | Agent state |
|---|---|---|---|---|
| **Alive** (`alive_running`/`alive_paused`) | full RAM (default 1GB) | ~5–20GB filesystem | already up | preserved (continuous) |
| **Hibernating** | 0 | ~280MB `hibernate.bin` + filesystem | ~1s (measured p95 829ms) | preserved (frozen mid-thought) |
| **Frozen** *(future, 1.1)* | 0 | filesystem only (~5GB) | ~30s+ (R2 download + restore) | preserved (in cloud) |

Plus two trivially-named end states: **Destroyed** (VM gone; a checkpoint can resurrect it) and **Created-but-never-alive** (a transient just after `well create`, auto-progresses to Alive).

Wake-on-traffic: when a hibernated well receives traffic (proxy hit, exec call, etc.), welld transparently resumes it. The agent inside never notices it was paused. See [`lifecycle.md`](lifecycle.md) for the canonical model and [`state-tiers.md`](state-tiers.md) § Benchmarks for measured numbers.

**In plain English:** Three sleep depths. **Alive** = running, costs RAM. **Hibernating** = paused-to-disk, costs only ~280MB per cell (sparse format), wakes in about a second. **Frozen** = paused-to-cloud, costs only the disk locally, wakes in tens of seconds. The watchdog automatically slides idle wells from Alive to Hibernating after `auto_sleep_seconds` (default 60s). Traffic to a hibernated well wakes it transparently; the agent inside doesn't notice.

## What's in 1.0

Wells GA targets early June 2026. The substrate is production-ready for one operator's local fleet running cells. Detail in [`proposals/road-to-wells-1.0.html`](proposals/road-to-wells-1.0.html).

**Stable in 1.0:**

- `well create / destroy / exec / sleep / wake / checkpoint / restore` — full sprites parity
- `cells birth pete --backend=well` end-to-end (production-tested)
- Autosleep + wake-on-traffic + R2 checkpoint sync
- Static IPs from welld's pinned range (`pinned_ip` per-well)
- Image substrate (`well image save / list`, alias system, R2 push/pull)
- Hibernate / wake at p95 829ms / ssh-after-wake p95 1147ms
- Thaw primitive (~481ms per concurrent VM from one hibernated bundle)
- Welld owns DHCP leases (single invariant guardian; no more whack-a-mole)

**Coming in 1.x (not blocking 1.0):**

- **A.2 Frozen tier** (R2 hibernation offload) — punted to 1.1
- **Phase C memory chunks** — lume balloon control + pressure controller for 2–3× cells-per-Mac density
- **Phase D multi-Lab Colony** — wells span multiple local-network Macs as one fleet (depends on A.2)
- **Multi-OS guests** — `well create --image=macos|windows`
- **GPU passthrough**
- **Linux host** (Phase E firecracker engine — deprioritized indefinitely; cloud hosting breaks the cooperation-first economics)

**In plain English:** 1.0 means "wells is stable enough that the cells team can build their product on top without expecting it to wobble." It doesn't mean "wells has every feature we'll ever want." Memory chunks, multi-Mac colonies, frozen-to-R2 hibernation, multi-OS guests, GPU — all real ambitions, all 1.x or beyond.

## SSH users inside a well

Every well boots with two SSH users:

- **`cell`** (uid 1001, home `/cell`, NOPASSWD sudo) — the agent user. Cells's DNA installs here. Cells team's birth flow targets `cell@<ip>`.
- **`ubuntu`** — the cloud-image default user, present for raw-VM debug. Override with `--user ubuntu` to the CLI or `{"user":"ubuntu"}` in the HTTP exec body. `ubuntu` has NOPASSWD sudo into `cell` via a sudoers drop-in, so `sudo -u cell <cmd>` works without a password (used by `well exec --user=cell`).

The two-user split keeps the agent's home (`/cell`) clean of cloud-init droppings (`/home/ubuntu/.cloud-locale-test.skip` and friends).

**In plain English:** Two accounts inside each well — `cell` is the working agent user (where cells installs its DNA), and `ubuntu` is the debug back-door. Cells uses `cell`; if you ssh in manually for poking around, you'll usually want `ubuntu`.

## Engine choice

The engine boundary is `engine/vwell.ts` — one file. Today that file talks to `bin/lume.app` (our soft fork of lume, sources in `engine/vwell-src/`, built via `scripts/build-lume.sh`, signed with our Apple Developer ID + provisioning profile). Lume drives Apple's `Virtualization.framework`.

On Linux (a hypothetical future host), the engine would be Firecracker or QEMU/KVM. The wells daemon stays the same; `engine/vwell.ts` swaps. See [`decisions/0003-multi-engine.md`](decisions/0003-multi-engine.md).

We don't fork the repo per OS. One codebase, swappable engine.

**In plain English:** Wells is engine-pluralist by design. The Mac case is what's tested and shipped; everything else is wire that could be added later. The day we want to run wells on Linux, only one file in the daemon needs to know about the new hypervisor.

## Cross-references

- Roadmap and 1.0 plan: [`ROADMAP.md`](ROADMAP.md), [`proposals/road-to-wells-1.0.html`](proposals/road-to-wells-1.0.html)
- Sub-phase status: [`MVP-PLAN.md`](MVP-PLAN.md)
- Architecture (deeper than this page): [`architecture.md`](architecture.md)
- State layout (full schema): [`state-schema.md`](state-schema.md)
- Lifecycle (state machine details): [`lifecycle.md`](lifecycle.md)
- Cells integration contract: [`cells-integration.md`](cells-integration.md)
- Sprites compat surface: [`sprites-parity.md`](sprites-parity.md)
- Install: [`install.md`](install.md)
- Engine + lume soft-fork: [`engine/vwell-src.txt`](../engine/vwell-src.txt)
