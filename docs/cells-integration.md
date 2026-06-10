# Wells ↔ Cells integration contract

What `cells init` and the cells team's CF Worker need from wells. Stable surface; everything outside this doc is internal.

## ✅ Wake regression resolved 2026-05-10 ~12:18 UTC

Host reboot fixed it — the cause was below us in the stack (Apple VZ daemon / TCC / accumulated lume process state, exactly as `docs/findings-wake-regression-permission-denied.md` predicted). Post-reboot wake-stress smoke: 30/30 cycles passed. Hibernate p95 201ms, wake p95 829ms, ssh-after-wake p95 1147ms. Watchdog autosleep + wake-on-traffic fully operational again. You can drop the `auto_sleep_seconds: null` mitigation.

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
- `POST /v1/sprites/{name}/exec` body `{command: string[], user?: string}` → `{exit_code, stdout, stderr, truncated?}`. Synchronous, 4 MB combined cap. Wake-on-demand: if the well is stopped or paused, welld starts it before SSHing. Caller pays ~5s on first exec after a stop. `user` defaults to `root` (HOME=/root); set to `"ubuntu"` for raw-VM access or `"well"` for the SSH entry user.
- `GET/POST /v1/sprites/{name}/policy/network` — domain allow/deny rules, persisted.
- `PUT /v1/sprites/{name}/url` body `{auth: "public"|"well"}` — flip per-well proxy auth.
- `PUT/DELETE /v1/sprites/{name}/services/{id}` — register/deregister services. The `ServiceDefinition` body accepts an optional `user` field (default `ubuntu`); set `user: "cell"` to land the `User=` directive in the systemd unit so the service runs as cells's bake-created user without a sudo wrap. POSIX-username shape only.
- `POST /v1/sprites/{name}/services/apply` — re-materialize every registered service def onto the guest (2026-06-10, cells production-readiness ask #2). Wake-on-demand like PUT. Returns `{well, applied: [id...], failed: [{id, error}...]}` — 200 even on partial failure; read the body. Service defs are **name-keyed declarations that survive destroy**: welld re-applies them automatically at the end of every create (fresh or `from_thaw`) of the same name, so a re-birth keeps its services without a re-PUT. This endpoint is the explicit heal for drift detected later (e.g. `cells doctor`). Create-time re-apply failures are logged loudly by welld but never fail the create — check `GET .../services` + this endpoint if a re-created well's services look absent.
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

`--env KEY=VAL` (repeatable) lands the pair in `/etc/environment` on the well at first boot (`well-firstboot.sh` writes a wells-managed block there). PAM auto-loads `/etc/environment` on every SSH session including non-login. Use this for `CELLS_PROXY_SECRET` so the secret is present from boot — no post-birth round-trip needed. Verified end-to-end against `well exec -- cat /etc/environment` 2026-05-10. **Note: requires `ubuntu-25.10-base` baked at or after 2026-05-10 ~16:00 UTC** (the firstboot script propagating to `/etc/environment` shipped today; earlier images source `well.env` but don't propagate).

Wells boot with `root` as the SSH entry user (`PermitRootLogin prohibit-password`) plus the cloud image's default `ubuntu` user. welld's per-well auth key lives in **`/etc/ssh/wells-keys/root`**, not `/root/.ssh/authorized_keys` — `/root` is your agent's `$HOME`, and wells deliberately keeps its SSH-entry auth out of it so a cell writing to its own home (DNA, `.ssh`, perms) can't lock welld out. You own `/root` freely; don't expect a wells key there.

`well exec`, `well console`, and the `/v1/wells/{n}/exec` HTTP/WS endpoints SSH in as `root@<ip>` and run the command directly. A non-root `--user` (or `{"user":...}` on the WS frame) sudo-switches via `sudo -n -H -u <target>` — the `-H` means HOME always matches the target. Cells's bake-created `cell` user is still reachable via `well exec --user=cell` even though firstboot never set up SSH for it. Use `--user=ubuntu` for raw-VM debug. TTY allocation passes through the sudo wrap cleanly (`well exec --tty --user=cell -- bash -i` works for interactive shells).

> **Migration note (2026-05-22):** the `well` transport user was removed — SSH now lands as `root` directly, no sudo hop on the default path. This requires `ubuntu-25.10-base` baked at or after 2026-05-22; forks from an earlier base have a `well` user and no root key and will not accept exec from the post-migration daemon. Rebake `cell-base` on the new base. See `docs/proposals/ssh-as-root-drop-well-user.html`.

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

#### Image library on R2 (added 2026-05-10, W.3-W.5)

Each Mac that runs welld can `push` baked images to R2 and `pull` them back later or on a different Mac. Foundation for Phase E (multi-Mac Colony) — operators bake on one Mac, distribute via R2.

```sh
well image push <name>                    # local → R2 library
well image pull <name>                    # R2 → local (--force re-pulls if local exists)
```

Configure once per-Mac via env when launching welld:

```
WELL_R2_LIBRARY_ENDPOINT=https://<account>.r2.cloudflarestorage.com
WELL_R2_LIBRARY_BUCKET=wells-images
WELL_R2_LIBRARY_ACCESS_KEY_ID=<key>
WELL_R2_LIBRARY_SECRET_ACCESS_KEY=<secret>
```

When all four are set, `well create --from-image <name>` **auto-pulls from R2** if the image is missing locally — so a fresh Mac joining a Colony only has to know the image name. Default base image (`ubuntu-25.10-base`) is excluded from auto-pull (the bake script is the canonical producer; we don't want a fresh Mac silently inheriting a stale base). Layout: `<bucket>/images/<name>/{disk.img, meta.json, manifest.json}`. Manifest carries sha256 + size; pull verifies sha256 before rotating disk into place. Per-image overrides on the push REST endpoint (`POST /v1/wells/images/<name>/push` with R2 config in body) let one-off images target a different bucket. See `docs/proposals/image-library-on-r2.md` for the full design.

### Save semantics — no rinse needed

A saved image inherits the source well's identity (hostname, machine-id, ssh host keys), and that's fine. When the cells team forks via `well create <new> --from-image=<saved>`, welld attaches a fresh cidata with a new instance-id. cloud-init detects the new instance-id, re-runs its `runcmd`, and resets identity:

- `/etc/machine-id` regenerated
- ssh host keys regenerated (cloud-init's `ssh_deletekeys: true` + `ssh_genkeytypes`)
- `/etc/hostname` set from cidata's `local-hostname`
- root SSH key + per-well identity re-applied by `well-firstboot.sh` (idempotent — gated on `/etc/.well-ready`)

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
  "vz_xpc_count": 0,
  "degraded": false,
  "vmnet_leases": {
    "total": 23,
    "orphan_count": 2,
    "orphans": [{"name": "...", "ip": "..."}]
  }
}
```

`degraded: true` flips on when welld's lume supervisor has respawned lume serve 5+ times in the last 5 minutes. At that rate, lume is bouncing under load and user-facing operations are fragile. **Cells's birth flow should poll `/healthz` and back off when `degraded` is true** rather than retrying into a flapping system. When the rate drops, `degraded` flips back to false.

`respawns_last_*` are sliding windows. A handful per hour is normal under stress. Hundreds is a red flag.

`vz_xpc_count` counts host processes whose exec path matches Apple's VZ XPC service marker — compare against lume's vm_count to detect orphans. `-1` means the ps walk failed (don't read it as 0).

`vmnet_leases` summarizes `/var/db/dhcpd_leases` against the registry — `orphan_count` counts entries vmnet has but welld doesn't track. Useful for spotting bootpd cruft after rapid create/destroy cycles.

The `pool` block that used to live here is gone post-Pi2 (2026-05-13). Pool management moved to cells; the next-create predictor lives on cells's side now (`cells pool list` or equivalent).

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
| `wells-stable-2026-05-09h`   | 2026-05-09 | **Lume periodic hang fixed at root + stale-lease bug fixed.** Two issues from the cells team flap report. (1) Lume's `NetworkUtils.runWithTimeout` was polling `process.isRunning` with `Thread.sleep(0.1)` AND `DHCPLeaseParser.getIPFromARP` ran `arp -an` via unbounded `Process.waitUntilExit()`. Both block the calling thread; lume's HTTP handlers run on `@MainActor` (single thread), so every info request held the actor for up to 6s per running VM. Under DHCP churn the unbounded ARP call hung indefinitely → welld supervisor SIGKILLed lume every 3-5 minutes. Confirmed via `sample` against stable's PID 75872: 8% of MainActor samples stuck in `nanosleep`. Fixes: DHCP file lookup short-circuits ARP fallback for NAT mode (your case), ARP bounded with 2s `DispatchSemaphore.wait` timeout, `runWithTimeout` rewired to terminationHandler + single semaphore wait (no poll loop), inline `isSSHAvailable` probe removed from `getVMDetailsLightweight` and `VM.details`. (2) Welld's `waitForDhcpLease` MAC/hostname-match returned stale entries (vmnet keeps lease entries indefinitely; smoke-7 returned `192.168.64.134` in 15ms when real VM came up at .136). Fixed with snapshot-aware `isFreshLease` filter. Verified on dev: 4 back-to-back create+warm cycles ~14s each, zero lume respawns. **Breaking change to lume API**: `sshAvailable` field is now always `null` in `lume info`/`lume list` responses; welld doesn't read it, but if anything in your stack does, that's the only behavioral change. |
| `wells-stable-2026-05-09i`   | 2026-05-09 | **Create+warm latency tuning.** `ubuntu-25.10-base` re-baked with `dhcp-identifier: mac` in netplan (deterministic DHCP across the warming-restart) + pre-allocated 512 MB swap (skips per-well swap setup). `well create` now uses `sysrq-trigger` for the warming-side guest halt instead of `shutdown -h now` — 4-5s faster per create. P50 ~10.5s on dev. |
| `wells-stable-2026-05-09j`   | 2026-05-09 | **Pre-warmed pool ships — sub-3s create.** Welld now keeps `pool_size` ready members in `~/.wells/pool/`; `well create` adopts a pool member by symlinking the welld bundle (lume bundle stays at `pool-XXXX` because Apple's VZ saved-state encodes absolute paths to nvram/disk/hibernate.bin), restoring from hibernate, then SSH-hot-swapping in-guest identity (hostname + machine-id). End-to-end **2.0-2.2s create** when pool has a ready member; falls through to fresh-create on miss. **New CLI**: `well pool list`, `well pool refill`, `well pool drain`. **New REST**: `GET /v1/wells/pool` (target_size, ready_count, members), `POST /v1/wells/pool/refill`, `POST /v1/wells/pool/drain`. **Opt-in**: pool stays empty until you set `defaults.pool_size > 0` in `~/.wells/defaults.json` (default `0`). After that, the background filler keeps depth at target — refills async after each adoption + every 60s housekeeping tick. Live-verified end-to-end on dev: 3/3 cycles pool-served at 813-991ms pure adoption + ~1.3s identity reset = 2.0-2.2s; full lifecycle (pool→adopt→idle→watchdog hibernate→wake→ssh) all green in one smoke. **No breaking changes** — adopted wells appear identical to fresh-create wells from your perspective; new `lume_name` field on the registry record is internal-only. SSH host keys NOT regenerated on adoption (each pool member already has unique keys from `well-firstboot.sh`); reopen if you need cryptographic identity rotation per adoption. |
| `wells-stable-2026-05-11d`   | 2026-05-11 | **W.70 — Batch the bootpd kick (incident fix for `-11b/c`).** Followup to `-11c`: cells team at 09:01Z reported substrate incident — 4 of 5 running wells went dark (.64.4/.5/.10/.13 ping/SSH timeout; lume still reported `running`). **Root cause**: W.68's bash helper (`scripts/welld-dhcp-helper.sh`) kicked bootpd via `launchctl kickstart -k system/com.apple.bootpd` after EVERY `publish-hostname` invocation. The W.68 publisher sweep ran every 10s with 16 alive wells = 96 SIGKILLs of bootpd per minute. In-flight DHCP renewals failed mid-handshake; guests lost their leases on macOS's vmnet bridge. **Mitigation** (commit `7ada635`, 09:01:50Z kickstart): periodic sweep + startup sweep disabled in `daemon/welld.ts` to stop the bleed. /healthz reported `lease_publisher: {last_publish_at: null, ...0}` until W.70 shipped. **Fix** (`fe22c0a`, 09:04:49Z kickstart): bash helper's `publish-hostname` no longer kicks; new standalone `kick-bootpd` verb. `lib/dhcpHelper.ts` exports `kickBootpd()`. `lib/leasePublisher.ts:publishAllAlive()` loops `publishLease` (no kick per call), calls `kickBootpd()` once at end of sweep if anything published. Net: ONE SIGKILL of bootpd per 10s sweep (6/min total) instead of N-per-sweep. Sweep restored, invariant still enforced within the window. **Casualties**: 4 wells from the storm didn't auto-recover (their kernel-side IP knowledge survived but vmnet's bridge-side mapping was wiped). Recovery: `well stop <name> && well start <name>` forces fresh DHCP. Surviving VMs unaffected; new VMs work. **Deploy gotcha**: `scripts/install-dhcp-helper.sh` must re-run before the W.70 kickstart — same as `-11b`. **Lesson learned**: scaling-test the helper kick frequency before the next sweep-based design ships. Suite 725 green. |
| `wells-stable-2026-05-11c`   | 2026-05-11 | **W.69 — Resurrect stamps `runtime.ip` from startWell's observed lease.** Followup to `-11b` deploy: cells team's post-bounce verification 08:52Z surfaced one zombie (`egg-94b5e5`) where welld reported running+ip=.5 but ping/ssh failed at that address. Root cause: W.65 resurrect's `startWell` call observed a fresh lease but didn't write the IP to `runtime.json` — the pre-bounce `runtime.ip` stamp survived. vmnet doesn't guarantee same-IP across cold restart, so the resurrected VM came up at a different address; the W.68 publisher trusted the stale stamp and wrote a stale entry. **Fix** (`lib/resurrect.ts`): after successful `startWell`, read current runtime + `writeRuntime` with refreshed `last_transition_at` and `ip: startResult.ip`. Future bounces stamp correctly. **Limitation**: existing zombies (created pre-W.69 with stale stamps) don't self-heal on the next bounce because resurrect skips wells lume already reports running. Recovery options for an existing zombie: destroy + recreate, OR hibernate + wake cycle (clears `runtime.ip` per W.68's wakeWell update; sweep lazy-backfills from actual lease). A v2 reconciler (compare stamped vs MAC-observed, prefer observed on mismatch) would self-heal but isn't queued yet. Suite 725 green. Commit `d40848f`. |
| `wells-stable-2026-05-11b`   | 2026-05-11 | **Welld owns the DHCP lease invariant — 5-patch bundle.** Substrate ships the architectural fix for "if welld says running, the cell is reachable." Five patches deployed in one bounce: **W.14 slice 3** (`bin/lume` → `bin/vwell` wrapper rename — internal; `.app` bundle keeps upstream `lume` name). **W.65** (startup resurrection — wells whose prior runtime.state was `alive_*` get cold-started on welld bounce; cells's Tier 4 birth wedge survives bounces). **W.66** (failure-path lease release in `lib/poolFill.ts` + `daemon/welld.ts:handleCreateWell` catch blocks — covers cells's background-refill leak directly). **W.67** (`/flush` is orphan-only definitionally — partitions leases against `(well.name, well.lume_name, poolMember.name)` union; nuclear flush escape hatch removed from welld API surface, still available via direct sudo to the helper for operators who genuinely need it). **W.68 — the architectural ship**: welld now actively OWNS the lease entries for wells whose registry says `alive_running`/`alive_paused`. `/var/db/dhcpd_leases` becomes a derived artifact; welld publishes via privileged helper's new `publish-hostname <name> <ip> <mac>` verb (atomic add-or-replace; drops by hostname OR ip to clear stale aliases) on every alive transition + ~10s periodic sweep + immediate startup sweep. External mutations (sudo flushes, bootpd quirks, host-reboot edges) self-heal within the sweep window. **WellRuntime gains `ip` field**: stamped at createWell from `warmedIp`; cleared on hibernate + wake; lazy-backfilled via `resolveWellIp` on first sweep encounter for pre-W.68 wells. `/healthz` gains `lease_publisher: {last_publish_at, considered, published_count, skipped_count}` block. **Stamped-vs-observed tradeoff**: when both exist, welld's stamp wins — lease file is no longer authoritative. **Deploy gotcha**: `scripts/install-dhcp-helper.sh` must re-run BEFORE the bounce (helper at `/usr/local/sbin/welld-dhcp-helper` needs the new `publish-hostname` verb). **Live-verified at 08:47:35Z bounce**: 19 alive wells considered, 11 published across the first 2 sweeps (10s apart), 0 orphans, 0 lume respawns. W.65 resurrected 8+ wells cold-started post-bounce (one stale registry entry `probe-ubuntu` failed clean — lume reports VM not found, graceful log, didn't crash welld). **Cells team action**: substrate is now sturdy on the DHCP front; if anything looks off in cells's flow, ping with `/healthz.lease_publisher` output. Test suite 696 → 725 green. |
| `wells-stable-2026-05-11a`   | 2026-05-11 | **DHCP lease release + auto-resurrect on welld restart (cells team 06:28Z + 06:58Z asks).** Two cells-team-surfaced issues, both addressed end-to-end with cells team coordinating via chat-channel. **(1) DHCP lease leak**: `/var/db/dhcpd_leases` (vmnet bootpd, not dnsmasq) never GC's. Failed bakes / aborted creates leak entries; eventually new wells time out at the DHCP step (90s) when their hostname/MAC collides with a stale entry. Repro: cells drained pool + refilled 10 → first one hung; stable's lease table had 252 entries, 234 of them orphans (names not in registry). **Fix**: new privileged helper `/usr/local/sbin/welld-dhcp-helper` (root:wheel 0755, NOPASSWD via `/etc/sudoers.d/welld-dhcp` scoped to that exact binary + caller — A.3-design option 1B narrow-scope privilege). Helper verbs: `release-hostname <name>` (parses leases file, drops matching `{...}` block, `launchctl kickstart -k system/com.apple.bootpd`) and `flush-all`. Welld's `destroyWell` auto-releases on every destroy via `lib/dhcpHelper.ts:releaseLeaseBestEffort` (uses `lume_name` so pool-adopted wells release their `pool-XXXX` entry). Two new REST endpoints: `DELETE /v1/lume/leases/<hostname>` + `POST /v1/lume/leases/flush`. `/healthz` now reports `vmnet_leases: {total, orphan_count, orphans: [{name, ip}]}` (first 50) for poll-based visibility. Install: `bash scripts/install-dhcp-helper.sh` (one-time, prompts sudo once). **(2) Startup resurrection**: welld restart cycles the lume supervisor + clips every running well's VZ XPC child → all running wells go to `status=stopped`. Cells's Tier 4 birth wedge relies on running-resident eggs; losing them on every restart blew their pool. **Fix**: `lib/resurrect.ts:resurrectAliveWells` runs once at welld startup. Walks registry, reads each prior runtime.json, restarts wells whose state was `alive_running` or `alive_paused` (skipping hibernating-via-hibernate.bin, stopped, error_orphaned, and any that lume already sees running). Serialized to avoid DHCP thundering herd. Lifecycle truth: runtime.json wins on startup. **Cells team action**: cells's pool can now safely tolerate welld restarts. Use `POST /v1/lume/leases/flush` whenever between phases to clean accumulated zombies. |
| `wells-stable-2026-05-10h`   | 2026-05-10 | **`clearLastTouched` on well create + destroy — watchdog state-leak fix.** Followup to `-10g`: after the rinse fix unblocked cells's P1.3 birth, watchdog auto-hibernated `ck-pi-gpt55` 6s after well-create finished (21:21 warmed → 21:21:07 hibernating, then immediate wake + lume `killAndRestart`). Root cause: `clearLastTouched()` existed in `lib/idle.ts` but was never called. Recreating a well with the same name inherited the prior instance's in-memory `lastTouched` timestamp — if older than `auto_sleep_seconds`, the watchdog's first tick treated the new well as already-idle. **Fix** (`daemon/welld.ts`): `clearLastTouched(name)` fires in both `handleCreateWell` (before parsing body) and `handleDestroyWell` (after lume teardown); also clears `watchdogHibFailures` map on destroy (same leak shape). Pure in-memory state — no API change. Note: the map still resets on welld restart, which is fine because a freshly-restarted welld has observed zero touches. Live-verified end-to-end with cells team in the same chat-channel sprint as the `-10g` rinse fix. |
| `wells-stable-2026-05-10g`   | 2026-05-10 | **Rinse stops triggering `sshd-keygen.service` on cell-base forks (live debug with cells team).** Followup to `-10f`: the entropy fix landed in `ubuntu-25.10-base` but `cell-base` forks (built on top by cells's bake) still hung at DHCP-no-SSH — and now in *every* fork, not just intermittent. Root cause (traced via shared chat channel `/tmp/cells-wells-chat/`): `rinseGuest` explicitly emptied `/etc/machine-id` (`rm -f` then `touch`) to mark forks as "first boot" so cloud-init-era code paths would re-run. That triggered Ubuntu's `sshd-keygen.service`, which has `ConditionFirstBoot=yes` (fires on empty machine-id). The service tried to regenerate host keys with cold-boot entropy on Apple VZ guests and stalled indefinitely in `getrandom()`. Ubuntu-base forks weren't affected because cloud-init populated `/etc/machine-id` during base bake → `ConditionFirstBoot=no` → service skipped. The `-10f` entropy fix's three layers were all present (haveged active, Ed25519-only firstboot) but layer 2 (`random.trust_cpu=on`) was a silent no-op anyway: cells team confirmed `/etc/default/grub` had the edit but `/boot/grub/grub.cfg` never reflected it (update-grub didn't propagate on this ARM cloud image because of an overriding `50-cloudimg-settings.cfg` drop-in). **Fix** (`lib/rinseWell.ts`): rinse no longer deletes `/etc/machine-id` or `/etc/ssh/ssh_host_*`. Forks inherit the source's machine-id + Ed25519/ECDSA host keys briefly; `well-firstboot.sh` regenerates both per-fork after `network-online.target`. Netplan's `dhcp-identifier: mac` keeps DHCP unaffected by the shared-machine-id window. **Verified end-to-end with cells team in ~25 min**: re-bake `cell-base` from new welld → bake green, verify-fork passed cleanly → `well create probe --from-image=cell-base --env CELLS_PROXY_SECRET=...` → SSH ready immediately, `/etc/environment` carries wells-env block. **Cells team action**: re-bake `cell-base` on the new welld; ubuntu-25.10-base is unchanged from `-10f` (already has haveged + Ed25519-only firstboot, both still load-bearing as defense-in-depth for the well-firstboot regen path). |
| `wells-stable-2026-05-10f`   | 2026-05-10 | **First-boot entropy fix (cells team's intermittent cell-base + --env hang).** Diagnosis: ssh-keygen RSA generation stalled in `getrandom()` waiting for entropy at first boot of cell-base forks. Apple VZ guests have notoriously thin entropy at boot; cell-base's bake adds bun + pi + DNA installs that warm the pool at bake but leave it sometimes-too-cold at fork. Failure was intermittent (~20% rate), NOT specific to `CELLS_PROXY_SECRET` — `--env CELLS_X=y` and even `--env FOO=bar` would also hang occasionally. Cells team's "4 reproductions in a row" was an unlucky run. **Three layers of defense, all in `ubuntu-25.10-base` (re-baked 2026-05-10 ~18:53 UTC):** (1) `haveged` package installed + enabled — feeds /dev/random from CPU jitter. (2) `random.trust_cpu=on` in `/etc/default/grub` — kernel trusts the VZ-provided hardware RNG immediately, no waiting for user-space seeding. (3) `well-firstboot.sh` skips RSA host-key generation; only Ed25519 (~32B entropy) and ECDSA-P256 (~64B) — modern SSH clients prefer Ed25519 anyway. **Verified:** 20/20 stress trials of `ubuntu-25.10-base + --env CELLS_PROXY_SECRET=test` passed (was intermittent before). **Cells team action**: re-bake `cell-base` on top of the new `ubuntu-25.10-base` to inherit the entropy fix at the disk-image layer. The retry-loop workaround can be dropped after rebake. |
| `wells-stable-2026-05-10e`   | 2026-05-10 | **Cells team P1.3 unblock bundle.** Four asks landed: (1) **`well-firstboot.sh` propagates `--env` passthroughs to `/etc/environment`**. Their cells.W.27 was real — firstboot was sourcing `well.env` for hostname/user only, never propagating to PAM. New `etc-environment.append` lives in cidata, firstboot writes a wells-managed `# wells-env --- begin/end` block. Verified end-to-end on stable: `well create probe --env CELLS_PROXY_SECRET=xyz` then `well exec -- cat /etc/environment` shows `CELLS_PROXY_SECRET="xyz"` cleanly. **Requires the new `ubuntu-25.10-base` (re-baked 2026-05-10 ~15:14 UTC)** — re-bake `cell-base` on top of that to inherit the fix. (2) **`ServiceDefinition.user` field** — schema gains optional `user`; `composeUnit` emits `User=<user>` (defaults to ubuntu for back-compat). Cells's `cell` user (owning `/cell/`) can run services natively. POSIX-username shape only. (3) **`well exec --user=<u>` SSH-as-well + sudo-switch** — REST + WS + CLI all updated. SSH lands as `well` (the only user firstboot sets up beyond `ubuntu`), then `sudo -n -u <user> bash -c '<cmd>'` if `--user` names anything else. Cells's `cell` user (no SSH setup) is now reachable without their client-side `sudo -u cell` wrap. `well console --user=u` does the same via `sudo -i` for a login shell. Verified live for `well`, `ubuntu`, `root`, and `cell` (created on the fly via useradd, no SSH setup). (4) **`well exec --tty`** passes through sudo cleanly — `ssh -tt well@ip -- sudo -n -u cell -i` keeps stdin/stdout/stderr live; cmdShell + cmdTui patterns work. **Plus**: W.2 R2 round-trip smoke verified (41:18 wall on 50GB sparse, sha match) with three plumbing fixes (16MB partSize, async upload, streaming sha256); bake script switched from broken `lume run` CLI to lume HTTP. 539/539 tests green. Wake regression (their #2) was already done by host reboot at 12:18 UTC. |
| `wells-stable-2026-05-10d`   | 2026-05-10 | **Bundle: graceful-stop + plist PATH /usr/sbin + images shape tolerance + pool zombie auto-prune.** (1) **Graceful stop** (the big one): lume's `BaseVirtualizationService.stop()` now sends ACPI `requestStop()` to the guest, polls state→.stopped (200ms intervals, 30s timeout), forceful fallback only on hang. Pre-fix, `well stop` (and the save+fork pipeline) was Apple's forceful `VZVirtualMachine.stop()` ("pull the cord") which dropped in-flight VirtIO writes before host fsync — your bake's /cell tree, /etc/profile.d shims, sed-edits all silently vanished from forks of saved images. Post-fix: smoke verified on dev — write `/cell/marker.txt` + sync → `well stop` + `start` → marker survives; same well → save (validate=true) → fork → marker survives in fork. **Your bake unblocks.** Findings: `docs/findings-graceful-stop.md`. (2) **Plist PATH** (`scripts/welld.plist.template`) gains `/usr/sbin:/sbin` so launchd-started welld can find `lsof` (`lib/diskReleased.ts`). Existing welld installs need an `install-launchd.sh` re-run to pick up. (3) **Images shape tolerance** (`daemon/welld.ts:handleListImages`): `GET /v1/wells/images` per-entry validates against `ImageResource` and drops malformed entries with a warn log instead of 500'ing the whole list — your `cmdBake`'s `.catch(() => null)` conflict-detection no longer collapses on a single drifted meta. Drop the `well image rm cell-base` workaround. (4) **Pool zombie auto-prune** (`lib/poolFiller.ts:prunePoolZombies`): runs at welld startup before the filler, drops any registry entry whose lume bundle dir is missing on disk + logs each as warn. New `well pool drain --all` (`?all=true` query) for nuking the pool when needed. **Substrate facts you can rely on now** (verified 2026-05-10 09:30 UTC on dev): create+warm p95 = 17.4s (was 27.1s — see `docs/findings-create-warm-distribution-2026-05-10.md`); concurrent-fork ceiling = **4** (N≤4 all succeed cleanly; N≥5 hits vmnet bootp DHCP race causing some timeouts; lume itself stays stable — `docs/findings-concurrent-fork-crash.md`); concurrent-restoreState ceiling = **1** (must serialize wake/thaw — `docs/findings-thaw.md`). |
| `wells-stable-2026-05-10c`   | 2026-05-10 | (Superseded by `-10d`.) Initial graceful-stop bundle without plist/images/pool fixes. |
| `wells-stable-2026-05-10b`   | 2026-05-10 | **Adopted-lume supervisor fix — stops the silent-death window.** Cells team incident this morning (~05:11 UTC): stable lume on `:7777` died mid-`lume create bundle` and never respawned, every well showed `missing`. Root cause: yesterday's WS-proxy stable promotion (`2026-05-10a` at 04:22) restarted welld via launcher; lume `:7777` was already up from earlier, so welld **adopted** instead of spawning. Pre-fix, the supervisor only ran on the spawn path — `lume_owned: false` meant no healthcheck, no respawn. When the adopted lume crashed at 05:11, welld didn't notice. Window of unsupervised-lume = whatever time elapsed between welld restart and the next lume crash. **Fix** (`engine/lumeProcess.ts`): `ensureLumeServe` now ALWAYS attaches the supervisor, both spawn-path and adopt-path. Adopt-path uses `lsof -nP -iTCP:7777 -sTCP:LISTEN` to discover the PID; supervisor liveness check stacks `Subprocess.exitCode` (when we own it) with `process.kill(pid, 0)` (works either way). New `WELL_LUME_NO_SUPERVISE=1` opt-out for advanced users. Healthz now exposes `lume.owned: true|false` so cells team can spot the adopted state if it recurs. Live-verified on dev welld :7879: spawn welld, kill lume out from under it, supervisor respawns within ~3s; restart welld so it adopts the new lume, kill lume again, supervisor respawns. Belt-and-suspenders against this exact failure mode. **No API changes** — purely internal robustness. |
| `wells-stable-2026-05-10a`   | 2026-05-10 | **WS proxy header forwarding fixed — `cells talk` 1011 unblocker.** Cells team report: `cells talk` over the local welld vhost path (`ws://127.0.0.1:7878/agent` with `Host: <well>.wells.cells.md` + `Authorization: Bearer …`) was opening then closing 1011 within ~50ms, before any frame could flow. Cell-side bridge log showed connect→disconnect with no auth-fail entry. Root cause: `daemon/welld.ts` constructed `new WebSocket(d.upstreamUrl)` with **zero** request headers — `Authorization`, `Cookie`, `Origin`, `Sec-WebSocket-Protocol`, custom `X-*` all silently dropped at the proxy hop. Cell's bearer check (or anything expecting upgrade-time context) saw a naked handshake and tore down; Bun's client emitted `onerror` rather than a clean `onclose`, which the bridge translated to `ws.close(1011)`. **Fix**: new helper `buildUpstreamWsInit(req)` in `lib/proxy.ts` walks the original headers, strips hop-by-hop + `Host` + Bun-managed `Sec-WebSocket-*` control headers, forwards everything else; subprotocols extracted into Bun's `protocols` option. Welld's bridge passes the result as the second arg to `new WebSocket(url, init)`. **Verified end-to-end**: a standalone smoke (`scripts/smoke-vhost-ws-proxy.ts`) stands up a fake cell + slim proxy mirroring welld's bridge, drives a real WS with the cells team's exact Host+Authorization shape, asserts 7/7 — Authorization arrives, X-* arrives, Host correctly recomputed (no smuggling), bidirectional frames flow, close is 1000 not 1011. Plus the unit + e2e tests in `lib/proxy.test.ts` cover the strip rules + the underlying Bun-WebSocket-honors-headers contract. **No API changes**: same endpoint, same auth, same WS shape — your existing `cells talk` repro should now succeed without modification. **Local-direct still preferred for latency** (resolve IP via `GET /v1/wells/<n>` and connect direct to `ws://<ip>:8080/agent`), but the proxy now works correctly when you want vhost dispatch on-Mac, and is the only viable path off-Mac through cloudflared. |

### Stable window — 2026-05-09 evening

Per cells team's request: stable welld is now at `wells-stable-2026-05-09d` (commit `de0f32f`) and **wells team will not push or restart stable again tonight**. This is your stable window. Run your bake → verify → birth flow without watching for substrate churn.

If you hit a regression or hang, ping wells in the repo (don't loop on retries). Wells team will continue iterating on dev (`127.0.0.1:7879`) which doesn't affect you.

### Stable bumped 2026-05-10 — pool feature shipped

Stable promoted from `2026-05-09h` → `2026-05-09j` (skipping `i`'s docs since both `i` and `j` shipped close together; see Promotions table for the merged story). Net new: pre-warmed pool with sub-3s `well create`, `well pool` CLI, `GET/POST /v1/wells/pool` REST. **Opt-in via `~/.wells/defaults.json`**: set `"pool_size": N` to enable. Default `0` keeps current behavior — no pool, fresh-create as before. No breaking changes for existing flows; adopted wells look identical to fresh-create from cells team's perspective.

### Stable bumped 2026-05-10 — supervisor fix for adopted lume

Stable promoted to `wells-stable-2026-05-10b` (commit `af21853`). Closes the silent-death window from this morning's incident: when welld restarts and finds lume already running, it now still attaches the supervisor (previously: spawn-only, which is why ~05:11 lume died with no respawn). Adopt-path discovers PID via `lsof`, liveness checked via `process.kill(pid, 0)`, respawn behavior identical to spawn-path. Healthz `lume.owned: true|false` tells you which path welld took; recovery is automatic either way. No API changes for cells team — purely internal robustness. If you want the previous adopt-without-supervise behavior for any reason, set `WELL_LUME_NO_SUPERVISE=1` before launching welld.

### Stable bumped 2026-05-10 — `cells talk` 1011 fix shipped

Stable promoted to `wells-stable-2026-05-10a` (commit `3477980`). Single-issue fix: WS upgrades through welld's vhost-dispatch proxy now forward the client's headers (`Authorization`, `Cookie`, `Origin`, custom `X-*`) and subprotocols to the upstream cell. Before: cells team's `cells talk` repro opened then closed 1011 within ~50ms because the cell's bearer check saw a naked upgrade. After: open + bidirectional frames + clean 1000 close, verified by a standalone smoke that exercises the full vhost+bridge path with the team's exact Host header pattern. Re-run your repro — it should just work.

**Local-direct is still the recommended path for latency** when both talker and cell are on the same Mac: query `GET /v1/wells/<n>` for the IP, then `ws://<ip>:8080/agent` directly with your bearer. Skips a hop, fewer moving parts. The vhost proxy is what cloudflared uses off-Mac and is now correct for any on-Mac caller that wants Host-header dispatch.

### Cells team, status (2026-05-09 22:25 UTC) — root cause for tonight's lume flap on stable

**Found it.** Two lume serves on different ports (stable's `:7777` and our dev `:7780`) `SIGKILL` each other's `VirtualMachine.xpc` children on every respawn. Lume's orphan-sweep at startup walks `proc_listallpids` and kills any VirtualMachine.xpc — no notion of which lume owns which VM. When stable's lume respawns, it kills *our* dev VMs; our welld's supervisor sees the dev VMs disappear and respawns dev lume, which sweeps back, killing stable's VMs. Death spiral.

Crash times match exactly across both: stable 22:13:23.051, dev 22:13:23.326 (165ms after stable's sweep). Same pattern at 22:18:58. Cells team's "Pattern 2 — crashes around warming-restart" was probably this same loop coinciding with VZ child stop+start during warming.

**Fix tonight (already applied):** killed dev welld + dev lume at 22:25 UTC. Stable should stabilize. Watch `respawns_last_5min` on `/healthz` — if it stays at 0 for the next 10–15 min, the hypothesis is confirmed.

**Permanent fix:** lume patch to scope orphan-sweep to VMs spawned by *this* lume instance. Three approaches in `docs/findings-lume-orphan-sweep-cross-contamination.md`. Lives on a `feature/lume-orphan-sweep-scoped` sub-branch; not for tonight.

**Side effect:** wells dev work pauses while cells team is live on stable, until the lume patch lands. The dev/stable split (`docs/cells-integration.md` § "Why this exists") was conditional on lume's orphan-sweep being more selective than it actually is.

**Action for you:** retry your bake. If stable's `respawns_last_5min` stays clean for 10 min, you're unblocked. If not, ping back — there's another bug we haven't caught yet.

### Cells team, action for you (2026-05-09 ~21:50 UTC) — `WELL_PUBLIC_BASE` defaults + override surface

Re your `well info` URL placeholder issue:

**Default:** the launcher scripts now default `WELL_PUBLIC_BASE` to `wells.cells.md` (Pattern A — matches your CF Worker bridge `<name>.cells.md` → `<name>.wells.cells.md`). Out-of-box, `well info`'s URL field will render as `https://<name>.wells.cells.md` for any well.

**Control surface (you own the value):** override the default by setting `WELL_PUBLIC_BASE` in welld's env before launch. The launcher uses the bash `${VAR-default}` form so an explicit override (including explicit empty for "no public base configured") is honored:

```sh
# Pattern A (default — what cells team is using today)
./run-welld-stable.sh

# Pattern B (cleaner — direct routing, no `wells.` infix)
WELL_PUBLIC_BASE=cells.md ./run-welld-stable.sh

# Operator's own domain
WELL_PUBLIC_BASE=mycoworker.dev ./run-welld-stable.sh

# Explicit empty (surfaces em-dash sentinel — useful for testing)
WELL_PUBLIC_BASE= ./run-welld-stable.sh
```

**Cells-side change still recommended:** even with the default landed, harden `deploy-cell-worker.sh` against the em-dash case. If someone runs welld with `WELL_PUBLIC_BASE=` (explicit empty), URL renders as em-dash and your awk pipeline blows up again. Defensive parse:

```bash
URL=$(well info -s "$NAME" | awk '/^URL:/ {print $2}')
if [[ "$URL" == "—" ]] || [[ -z "$URL" ]] || ! [[ "$URL" =~ ^[a-z0-9.-]+$ ]]; then
  echo "ERROR: well '$NAME' has no public URL configured"; exit 1
fi
```

**Stable status:** the launcher fix is in `feature/phase-a` HEAD but doesn't take effect on stable until the next stable restart. *Not* restarting tonight per your testing window. If you want the default applied right now, ping back and we can do a quick bounce.

**Em-dash is the intentional sentinel.** `cli/well.ts:152` renders `r.url ?? "—"` to make config gaps visible. Don't try to suppress it on the wells side — your script should treat it as a hard fail.

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

### Cells team — both flap issues real-fixed (2026-05-09 23:52 UTC)

Stable promoted to `wells-stable-2026-05-09h` (commit `5b897bb`). Both issues from your morning report are fixed at root.

**Lume's periodic hang (`unresponsive, exitCode:null` every 3-5 min).** Root cause: lume's `NetworkUtils.runWithTimeout` polled `process.isRunning` with `Thread.sleep(0.1)` between iterations, AND `DHCPLeaseParser.getIPFromARP` ran `arp -an` via unbounded `Process.waitUntilExit()`. Both block the calling thread. Lume's HTTP handlers run on `@MainActor` (single thread), so every `lume info` / `lume list` request held the actor for up to 6s per running VM. Under DHCP churn the unbounded ARP call hung indefinitely → your supervisor's 35s HTTP timeout fired → SIGKILL → respawn → repeat. Confirmed live with `sample` against stable's PID 75872 (capture in `/tmp/lume-stable-baseline-1778369707.txt`): 8% of MainActor samples stuck in `nanosleep` via `NSThread.sleep` at `NetworkUtils.swift:25,32`.

The patch:
- DHCP file lookup short-circuits ARP fallback when an IP is found (NAT mode, your case, never needs ARP)
- ARP subprocess bounded with 2s `DispatchSemaphore.wait` timeout
- `runWithTimeout` rewired to `terminationHandler` + single semaphore wait — still blocks the calling thread for at most `timeout` seconds, but ONCE not in a polling loop
- Inline `isSSHAvailable` probe removed from `getVMDetailsLightweight` and `VM.details` (it was the slowest blocker — 4s per VM)

**Stale-lease lookup in welld create flow (the side bug).** Your smoke-7 hit it 22:50:05: welld returned `192.168.64.134` in 15ms and ssh-poked a dead address while real DHCP arrived 4-6s later. Fixed in `lib/createWell.ts` with a snapshot-aware `isFreshLease` filter — MAC and hostname matches now reject any candidate that already existed in the pre-start snapshot.

**Verified on dev:** 4 back-to-back `create+warm` cycles, each ~14s wall-clock, zero lume respawns. Compare to stable's pre-fix flap pattern (3-15min between hangs, 5-13 respawns/hour).

**Breaking change to lume API to flag:** `sshAvailable` field is now always `null` in `lume info`/`lume list` responses. Welld doesn't read this field; if anything in your stack does, that's the only behavioral change. Probe SSH yourself if you need it.

**Diagnostic instrumentation:** welld's supervisor now captures a 3s `sample <pid>` stack dump to `/tmp/lume-hang-<ts>-pid<pid>.txt` before SIGKILLing an unresponsive lume. If anything regresses, the next hang gives us actionable telemetry without you having to repro.

**Action for you:** retry your smoke. Stable should hold clean now. If you see another hang in the wild, ping back with the latest `/tmp/lume-hang-*.txt` we'll have captured.

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

**Exactly what `validate: true` rinses** (`lib/rinseWell.ts:47-58`, canonical):
- `/var/lib/systemd/network/*` — DHCP lease state.
- `/etc/machine-id` — wiped + re-touched empty so first-boot regenerates.
- `/etc/.well-ready` — first-boot sentinel.
- `/etc/ssh/ssh_host_*` — host keys, regenerated by `well-firstboot`.
- `/home/ubuntu/.ssh/authorized_keys` and `/home/well/.ssh/authorized_keys` — SSH inbound creds, re-seeded by `well-firstboot` on the fork.

It does **not** touch any other files under `/home/<user>/`. If you need cell-specific content to survive a save+fork, put it outside `/home/` — e.g., `/cell/`, `/opt/cells/`, `/var/lib/cells/` — so it's clearly cell-identity, not user-home transient data, and isn't conflated with what the rinse calls "identity."

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
