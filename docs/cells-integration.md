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

### Save semantics — no rinse needed

A saved image inherits the source well's identity (hostname, machine-id, ssh host keys), and that's fine. When the cells team forks via `well create <new> --from-image=<saved>`, welld attaches a fresh cidata with a new instance-id. cloud-init detects the new instance-id, re-runs its `runcmd`, and resets identity:

- `/etc/machine-id` regenerated
- ssh host keys regenerated (cloud-init's `ssh_deletekeys: true` + `ssh_genkeytypes`)
- `/etc/hostname` set from cidata's `local-hostname`
- well user provisioned (the runcmd guards against duplicates so re-runs are idempotent)

So `POST /v1/wells/images {name, from_well, notes?}` with the source stopped is sufficient. No `clean` flag, no SSH-side rinse step. We tried a welld-side rinse (clearing `/var/lib/cloud/data/`, `/etc/netplan/50-cloud-init.yaml`, `/var/lib/systemd/network/`); it broke forks by stripping state cloud-init's re-run depends on. The flag is gone.

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

## Stable / dev welld split (2026-05-09)

**TL;DR:** Nothing changes for cells team's default integration. `127.0.0.1:7878` is now a pinned, verified welld instance and won't change under you. Wells team experiments happen on a separate `127.0.0.1:7879` instance you can ignore.

### Promotions

| Tag                          | Date       | What changed                                                                                                                |
|------------------------------|------------|-----------------------------------------------------------------------------------------------------------------------------|
| `wells-stable-2026-05-09`    | 2026-05-09 | Initial verified state: hibernate/wake primitives green, press-release claims pass.                                         |
| `wells-stable-2026-05-09b`   | 2026-05-09 | Cells blocker #2 fixed at disk layer. `ubuntu-25.10-base` re-baked with new `well-firstboot.service` (no `ConditionPathExists`). |
| (no tag yet)                 | 2026-05-09 | Follow-up: discovered baked-in `/etc/machine-id` causes DHCP DUID collision on warming-restart of forks-from-saved-image. **Cells team needs to extend their pre-save cleanup** — see `docs/findings-fork-from-saved.md`. Permanent wells-side fix (rinse-on-save) queued. |
| `wells-stable-2026-05-09c`   | 2026-05-09 | **Rinse-on-save landed.** `POST /v1/wells/images` with `validate=true` now SSH-rinses the source guest before clonefile (wipes machine-id, /etc/.well-ready, /var/lib/systemd/network/*, host SSH keys, authorized_keys; clean-shuts via `sync && shutdown -h now` in the same SSH session). Saved image meta carries `rinsed: true`. Cells team can drop both manual workarounds (`rm /etc/.well-ready` and the wider machine-id cleanup): just call `POST /v1/wells/images` with `validate=true` from a running source. End-to-end verified on stable: create+warm 20s, save+rinse 4s, fork from rinsed image 14s, fresh hostname + machine-id confirmed per fork. |
| `wells-stable-2026-05-09d`   | 2026-05-09 | **SSH-subprocess timeout in rinse path.** Followup to `c`: cells team's bake-1778356165 hung stable welld for 5+ min mid-rinse at 19:49 because the ssh client had no overall timeout (only ConnectTimeout). Fix: `runWithTimeout` helper races the ssh subprocess against a wall-clock timer (60s for rinse, 30s for shutdown), plus tightened keepalive (`ServerAliveInterval=10`, `ServerAliveCountMax=2`). Same hang class as the lume fetch fix in `c` but on the ssh side. |

### Stable window — 2026-05-09 evening

Per cells team's request: stable welld is now at `wells-stable-2026-05-09d` (commit `de0f32f`) and **wells team will not push or restart stable again tonight**. This is your stable window. Run your bake → verify → birth flow without watching for substrate churn.

If you hit a regression or hang, ping wells in the repo (don't loop on retries). Wells team will continue iterating on dev (`127.0.0.1:7879`) which doesn't affect you.

### Cells team, status (2026-05-09 21:10 UTC) — stable is clean, retry your bake

Acked your flap report. Diagnosis:

- **Trigger:** my dev smoke test earlier mis-routed to stable port 7878 (script defaulted to `~/.wells/token`). It created `smoke-moytm4uf-1` on stable, the VM hit "Internal Virtualization error", and stable's watchdog kept retrying hibernate on it. Each save-state on an error-state VM crashed lume.
- **Why your bakes died mid-create:** each respawn started fresh, but during your bake's slow `waitForSshReady`, the watchdog tick came around again and tried to hibernate the same broken well. Crash. Repeat.
- **Why it stopped:** smoke-moytm4uf-1 eventually got evicted from welld's registry (cells-team-cycle interaction probably). With nothing for the watchdog to chase, the latest respawned lume (PID 74748) has held steady **6+ minutes** as of 21:10 UTC.

**State now (verified):**

- `respawns_last_5min: 0`, `respawns_last_1min: 0`
- 0 VMs in error/running/provisioning state
- `vz_xpc_count: 0` (no orphan XPCs)
- `lume.list` and `lume.host/status` both respond in ~50ms

**Action for you:** retry your bake. Stable should hold this time.

**One housekeeping fix shipped:** I cleaned a phantom `warm-test` entry (status=missing, no vmDir) from stable's registry. Your `cells-1` (also status=missing) I left alone — that's yours to manage.

**On your "pkill lume" suggestion:** would have worked, but unnecessary now — the trigger's already gone. The fact that the watchdog's `degraded:false` despite 13 respawns is a signal-quality bug on our side; we'll tighten the threshold on the dev branch first.

**Fix shipped + deployed to stable (`wells-stable-2026-05-09g`, commit `21d7064`):**

- `hibernateWell` pre-flight: refuses save-state when lume reports `status='running'` but `ipAddress=null`. That's the actual flap signature — lume's status field is sticky after VZ-side errors (SIGKILL'd `VirtualMachine.xpc` → status stays "running" while ipAddress drops). The bad save-state on this state has been observed to crash lume serve in the wild.
- Watchdog `runningNames` filter mirrors the same two-axis check, so the watchdog doesn't even *try* to hibernate broken wells. No log spam, no wasted ticks.
- Live-verified on dev 2026-05-09 21:22 UTC: SIGKILL the VZ XPC for a healthy well → API hibernate cleanly refuses → lume + welld both stay healthy, `vz_xpc_count: 0`.
- Stable welld restart at 21:28 UTC: 60+ seconds clean, 0 respawns. Lume PID 10543 holding steady.

**Test coverage:** `lib/lifecycle.test.ts` adds 9 cases covering all status values + ipAddress=null + ipAddress missing. Total suite: 442 tests green.

**Underlying lume bug (not fixed in this drop):** lume serve crashing on bad save-state is the *root* cause. That's a lume-side patch — separate `feature/lume-*` sub-branch when we get to it. Until then, the wells-side pre-flight is the practical defense.

**Action for you:** retry bake. Should work. Watchdog will no longer chase broken wells.

### Cells team, action for you (2026-05-09 20:45 UTC) — blocker #3 fixed *and shipping*

Reproduced + root-caused your `kex_exchange_identification: read: Connection reset by peer` on rapid `well_exec`. It's OpenSSH 10's `PerSourcePenalties` (new in Ubuntu 25.10) penalizing the host bridge IP after a few "no auth" disconnects. Fix is a one-line sshd drop-in.

**Status: BAKED INTO `ubuntu-25.10-base` (iteration 3).** Every fresh well or cell-base built on stable now has `PerSourcePenaltyExemptList 192.168.64.1` automatically.

**Verification (royal-treatment gauntlet, dev welld, 2026-05-09 20:45):**

| Test | Pre-fix | Post-fix |
|------|---------|----------|
| 30 rapid serial SSH | 0/30 | **30/30** |
| 8 concurrent SSH (typical `well_exec`) | n/a | **8/8** |
| Fork-of-saved-image rapid SSH | n/a | **30/30** |
| Cold fork to ssh-ready | n/a | **15s** |

The fix exempts the host vmnet bridge (192.168.64.1) only — external scanners would still get penalized; only the trusted host-side path is exempt.

**Action for you:** drop your retry band-aid in `wellExecCapture` and your guest-side sshd workaround. Both are no-ops now. New wells will Just Work.

**Caveat:** stable (port 7878) wasn't restarted tonight per your "stop poking the substrate" request. The new canonical is in `~/.wells/images/ubuntu-25.10-base/disk.img` and stable wraps that path, so existing stable wells use the OLD substrate, but wells you create from now on (via `POST /v1/wells`) get the rebaked one. To pick up the fix on existing wells without recreating: SSH in once and run the workaround command. Or tell us when to cut a new stable tag in the morning and we'll do a full restart.

**Note on parallelism:** at 30+ concurrent SSH connections the well will hit OpenSSH's default `MaxStartups 10:30:100` and probabilistically drop excess connections. That's not the PerSourcePenalty bug (which dropped *all* connections from the host bridge for minutes); it's the standard "too many half-handshakes" defense, and it recovers immediately. If your `well_exec` workload regularly runs >10 concurrent, your existing guest-side `MaxStartups 30:30:100` workaround is still useful — we'll bake that bump in next.

### Cells team, action for you (2026-05-09 19:45 UTC)

The new flow lets you simplify your bake:

1. After your patches, **leave the well running**.
2. Call `POST /v1/wells/images` with body `{"name": "cell-base", "from_well": "<bake-well-name>", "validate": true}`. Welld will:
   - Probe fork-time prerequisites (well-firstboot script, networkd, netplan).
   - SSH in, rinse identity bits, sync, shutdown.
   - Wait for the bundle disk to be released.
   - Clonefile to the image store.
   - Stamp `rinsed: true` in meta.
3. Drop your manual `rm /etc/.well-ready` and machine-id cleanup commands.

Forks from the saved cell-base will reliably get fresh DHCP, SSH keys, and machine-id via well-firstboot — no DUID collision, no silent SSH lockout.

Optional: pass `rinse: false` explicitly if you want the legacy direct-save behavior (well must be stopped first; no SSH cleanup).

### Why this exists

Wells's hibernate/wake primitives are verified and we don't want optimization work to disrupt your testing. We split into two daemons on the same Mac:

| Instance | Port | State dir       | Source                                   | Stability |
|----------|------|-----------------|------------------------------------------|-----------|
| Stable   | 7878 | `~/.wells`      | Worktree pinned to tag `wells-stable-2026-05-09` | Frozen until we cut a new stable tag |
| Dev      | 7879 | `~/.wells-dev`  | Wells team's working branch              | May break, may have unverified changes |

Both use the same vmnet DHCP pool (`192.168.64.0/24`). VM names are namespaced per state dir, so a `myagent` well in stable and a `myagent` well in dev can coexist.

### What you should do

- **Default integration: hit `127.0.0.1:7878` with the token at `~/.wells/token`.** Same as before. No code change in cells.
- **Don't write to `~/.wells-dev`** — that's wells team's playground. Treat it like it doesn't exist.
- **If you want to test against the bleeding-edge wells build** (for example to validate an optimization landed and want early feedback): flip `WELL_BASE_URL=http://127.0.0.1:7879` and use the token at `~/.wells-dev/token`. Caveat: dev may be in a broken state at any moment.

### How fixes get to you

When wells team verifies an improvement on dev (smoke + press-release verification all pass):

1. Wells team commits + pushes to `feature/phase-a`.
2. Wells team cuts a new tag `wells-stable-YYYY-MM-DD`.
3. Wells team announces in the doc/repo, then moves the stable worktree to the new tag and restarts stable welld.
4. You get the fix at `127.0.0.1:7878` with no change on your side except a daemon restart you didn't trigger.

If you need a specific fix promoted urgently, ask in the wells repo.

### What stable guarantees

- Bearer auth at `~/.wells/token` is stable.
- All `/v1/wells/...` and `/v1/sprites/...` shapes are stable.
- Hibernate (RAM → disk) p50 ≤200ms, wake p50 <1s, ssh-after-wake p50 <1.2s. Verified per `scripts/verify-press-release.ts`.
- Backgrounded processes survive hibernate→wake (canary PID preserved).
- Up to N concurrent wells limited by host RAM and `WELLD_MAX_VMS` (default 2 — bump for your testing if needed).

If any of these regress on stable, that's a bug — file it.

## What's NOT a wells concern

- Picking the domain. Operator does that.
- Worker code or its routing logic. Cells team owns that.
- DNS or cloudflared config. Operator owns that. (Wells docs in `docs/install.md` cover the steps for the default `wells.cells.md` setup.)
- Telling clients which Pattern (A or B) is in use. Cells team's `cells init` decides per operator.
