# Wells ↔ Cells integration contract

What `cells init` and the cells team's CF Worker need from wells. Stable surface; everything outside this doc is internal.

## Where the operator's domain choice lives

The operator picks one domain at install time (e.g. `cells.md`, `petesvm.dev`). That choice flows into two places:

1. **`WELL_PUBLIC_BASE` env var on welld.** Welld's daemon dispatches incoming Host headers using this. `cells init` should write this into the operator's shell init (e.g. `~/.zshrc` `export WELL_PUBLIC_BASE=cells.md`) or whatever launcher starts welld.
2. **The cells team's CF Worker config.** So the per-cell Worker knows where to dial when it routes traffic to a wells-backed cell.

Wells doesn't pick the domain. Wells doesn't know what domain the operator chose. Wells just dispatches whatever's in its env var.

## URL/Host dispatch behavior

Welld listens on `127.0.0.1:7878` (overridable via `WELL_PORT`). It serves three things from one listener:

1. **API** (`/healthz`, `/v1/wells/...`, `/v1/sprites/...`) — bearer auth via `Authorization: Bearer $WELL_TOKEN`. Sprites path alias is in place (both `/v1/sprites/...` and `/v1/wells/...` work; bare list endpoints too).
2. **Reverse proxy** — when the request's Host header matches `<name>.${WELL_PUBLIC_BASE}` (single label, exact suffix match), welld looks up the well's IP and forwards to `<ip>:8080`. No bearer auth on this path; per-well `auth` field can demand one.
3. **Per-host metadata + cooperation** at `192.168.64.1:7879` (the bridge gateway from a guest's perspective) — `host.well` resolves to this. Used for `/sleep`. Not relevant for the CF Worker.

The dispatch logic is intentionally narrow. From `lib/proxy.ts`:

```ts
// "pete.wells.cells.md" + base "wells.cells.md" → "pete"
// Multi-label prefixes are rejected to prevent Host smuggling.
```

If the operator sets `WELL_PUBLIC_BASE=cells.md`, only Hosts shaped `<single-label>.cells.md` dispatch. Anything else returns 401/404 against the API or just doesn't match the proxy branch.

## CF Worker → wells routing

Two patterns work today; the cells team picks based on whether they want a Worker translation hop.

### Pattern A — Worker is at the cell's public URL, dials wells via a separate internal address

User-facing: `pete.cells.md` (cells team's per-cell Worker registered here).
Internal: `pete.wells.cells.md` (wells's existing cloudflared tunnel).

Worker code:
```ts
// pete.cells.md/...
async fetch(req: Request) {
  const url = new URL(req.url);
  url.host = `${cell}.wells.${operatorBase}`;  // pete.wells.cells.md
  return fetch(url.toString(), req);
}
```

Operator setup: keep current `WELL_PUBLIC_BASE=wells.cells.md`, keep cloudflared tunnel routing `*.wells.cells.md` to welld. Nothing wells-side changes.

This is the lowest-friction path for an operator who already has wells deployed.

### Pattern B — Operator points the user-facing domain directly at wells, no Worker hop

User-facing AND internal: `pete.cells.md`.

Operator setup:
- `WELL_PUBLIC_BASE=cells.md`
- Cloudflared tunnel routes `*.cells.md` directly to welld (or whatever wildcard the operator wants)
- DNS for `*.cells.md` points at the tunnel
- The cells team's per-cell Worker is NOT in the path

This is the cleanest topology but requires the operator to own DNS for `cells.md` and not have a competing CF Worker eating those requests.

The cells team's birth flow probably wants Pattern A — it preserves your per-cell Worker layer. Pattern B is for operators who don't want any CF Worker hop.

## What `cells init` needs to do for wells

Minimum:

1. Ask the operator for a domain (e.g. "what domain do you want your cells reachable at?"). Default offer: `cells.md`.
2. Set `WELL_PUBLIC_BASE=<domain>` in the operator's env so welld picks it up.
3. Tell the cells team's Worker config that this operator's wells lives at `<domain>` (Pattern B) or `wells.<domain>` (Pattern A) — your call.
4. Run welld (or rely on the existing `bun run daemon/welld.ts &` workflow until we ship a launchd plist).

Optional:

- Configure cloudflared tunnel + DNS automatically (currently a manual step in `docs/install.md`). Worth scripting eventually.

## Wells API surface (sprites-compatible)

Cells code that already works against sprites works against welld unchanged via the path alias:

- `GET /v1/sprites/{name}` → resource shape with `name`, `status` (`running`/`stopped`/`missing`), `url`, `ip`, `created_at`, `cpu`, `memory`, `disk_size`.
- `POST /v1/sprites/{name}/start` and `/stop` — lifecycle. Start is idempotent and unpauses paused wells.
- `POST /v1/sprites/{name}/exec` body `{command: string[], user?: string}` → `{exit_code, stdout, stderr, truncated?}`. Synchronous, 4 MB combined cap. Wake-on-demand: if the well is stopped or paused, welld starts it before SSHing. Caller pays ~5s on first exec after a stop. `user` defaults to `well`; set to `"ubuntu"` for raw-VM access.
- `GET/POST /v1/sprites/{name}/policy/network` — domain allow/deny rules, persisted.
- `PUT /v1/sprites/{name}/url` body `{auth: "public"|"well"}` — flip per-well proxy auth.
- `PUT/DELETE /v1/sprites/{name}/services/{id}` — register/deregister services.
- `POST /v1/sprites/{name}/checkpoints` body `{comment?: string}` — checkpoint create.

All require `Authorization: Bearer $WELL_TOKEN`. Token lives at `~/.wells/token`, auto-generated on first welld start.

## What `well create` accepts

Cells's birth flow can create wells with these flags:

```bash
well create <name> [--cpu=N] [--memory=NGB] [--disk=NGB] \
  [--from-image=IMAGE-NAME] \
  [--env KEY=VALUE]... \
  [--r2-endpoint=URL --r2-bucket=NAME --r2-key=ID --r2-secret=KEY]
```

`--from-image` clones from a saved image (see "Image store" below) instead of `ubuntu-25.10-base`. Clonefile is sub-millisecond regardless of size — useful for forking many wells from a baked-once template.

`--env KEY=VAL` (repeatable) lands the pair in `/etc/environment` on the well at first boot. PAM auto-loads it on every SSH session including non-login. Use this for `CELLS_PROXY_SECRET` so the secret is present from boot — no post-birth round-trip needed.

Wells boot with a `well` user (uid 1001, NOPASSWD sudo, `/home/well/.ssh/authorized_keys` populated with the operator's host key). The agent user inside the well; cells's birth flow targets `/home/well/agent` and bashrc.d there. `well exec`, `well console`, and the `/v1/wells/{n}/exec` HTTP/WS endpoints all default to `well@<ip>`. The `ubuntu` user is still present for raw-VM debug — set `--user ubuntu` on the CLI or `{"user":"ubuntu"}` in the API body to override.

## Image store — fast forks via saved disk snapshots

When the cells team wants to fork many wells from a known-good baseline (e.g., one with the agent code pre-installed), saveable images skip the slow cloud-init bake. APFS clonefile means a 5GB image clones in sub-millisecond regardless of size.

```sh
well image save <well> <image-name>     # snapshot a stopped well's disk
well image list                          # what's saved (also --json)
well image info <image-name>             # disk size, source, created_at, notes
well image rm <image-name>
well create <new-name> --from-image <image-name>
```

REST surface (sprites-aliased too):

- `GET /v1/wells/images` → `{images: [{name, from_well, from_disk_size, created_at, notes?, size_bytes?}]}`
- `POST /v1/wells/images` body `{name, from_well, notes?}` → `ImageResource` (201). Source well must be stopped (clonefile of a hot disk gets a torn snapshot — 409 `well_running` if it's up).
- `GET /v1/wells/images/{name}` → `ImageResource` (404 if missing).
- `DELETE /v1/wells/images/{name}` → `{name, removed}`.
- `POST /v1/wells` body extends to `{… from_image: "<image-name>"}` — clones from that image instead of the default `ubuntu-25.10-base`.

### Save semantics — rinse identity before snapshotting

A saved image inherits the source well's identity: `/etc/hostname`, `/etc/machine-id`, `/etc/ssh/ssh_host_*`, and cloud-init's `/var/lib/cloud/instances/` semaphores. Clone that image into a new well and the clone DHCPs as the source's hostname (collision territory) until cloud-init re-runs and updates the hostname — and our DHCP discovery is by hostname, so welld won't find the new well's lease.

For cleanly-forkable images, the cells team should rinse identity inside the well before calling save. A reasonable rinse script:

```sh
sudo rm -f /etc/machine-id /var/lib/dbus/machine-id
sudo rm -f /etc/ssh/ssh_host_*
sudo rm -rf /var/lib/cloud/instances/*
sudo truncate -s 0 /etc/hostname
```

Then stop the well, then call `POST /v1/wells/images`. The cidata mounted on next clone's first boot triggers cloud-init to regenerate machine-id, ssh host keys, and set the new hostname from cidata's meta-data.

(`ubuntu-25.10-base` was baked this way — it's the canonical example of a cleanly-forkable image.)

## Operating signals — health + degraded mode

Two read-only surfaces for cells's automation to detect "wells is in a bad place" without poking individual wells:

### `GET /healthz` (no auth)

```json
{
  "ok": true,
  "version": "0.1.0-pre",
  "started_at": "2026-05-08T...",
  "lume": {
    "base_url": "http://127.0.0.1:7777",
    "owned": true,
    "respawns_last_hour": 0,
    "respawns_last_5min": 0,
    "respawns_last_1min": 0
  },
  "degraded": false
}
```

`degraded: true` flips on when welld's lume supervisor has respawned lume serve 5+ times in the last 5 minutes. At that rate, lume is bouncing under load and user-facing operations are fragile. **Cells's birth flow should poll `/healthz` and back off when `degraded` is true** rather than retrying into a flapping system. When the rate drops, `degraded` flips back to false.

`respawns_last_*` are sliding windows. A handful per hour is normal under stress. Hundreds is a red flag.

### `well doctor` CLI

```sh
$ well doctor
=== welld ===
  version:      0.1.0-pre
  uptime:       12m
  degraded:     no
  lume owned:   yes (welld supervises)
  lume respawns 1m/5m/1h: 0/0/0
=== lume serve ===
  status:   healthy
  VMs:      0 / 2 max
=== orphaned lume run subprocesses ===
  (none)
=== wells ===
  pete            stopped    192.168.64.7
  ...
RESULT: wells is HEALTHY
```

Read-only one-shot diagnostic, safe to run during a live birth flow. Exit codes:

- `0` — healthy
- `1` — unhealthy (welld unreachable, lume unreachable, or registry list failed)
- `2` — degraded (high respawn rate; functional but fragile)

Use in automation: `well doctor || handle_failure`.

## What's NOT a wells concern

- Picking the domain. Operator does that.
- Worker code or its routing logic. Cells team owns that.
- DNS or cloudflared config. Operator owns that. (Wells docs in `docs/install.md` cover the steps for the default `wells.cells.md` setup.)
- Telling clients which Pattern (A or B) is in use. Cells team's `cells init` decides per operator.
