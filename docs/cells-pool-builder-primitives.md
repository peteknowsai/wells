# Wells REST primitives for cells's pool builder

**Audience:** cells team building the cells-side pool manager (Piece 2 of the boundary cleanup).
**Status:** Stable contract. Wells locks this surface during cells's migration so you can build to a fixed target.
**Companion:** `docs/proposals/wells-cells-boundary-cleanup-answers.md` (Q1-Q5) · `docs/cells-integration.md` (operating chronicle).

This is a focused reference for the wells endpoints your pool manager will call to (a) bake hibernated pool members, (b) birth them when claimed, and (c) destroy them when expired.

---

## Auth + transport

- Welld listens on `127.0.0.1:7878` (overridable via `WELL_PORT`).
- All endpoints below require `Authorization: Bearer $WELL_TOKEN` (token at `~/.wells/token`, auto-generated on first welld start).
- 401 if the bearer is missing or wrong. 4xx with JSON `{error, message}` body for everything else.

## The pool manager's lifecycle, end-to-end

```
[bake]    POST /v1/wells {name, from_image, env?, hibernate_ready:true}
          → 201 WellResource (well is alive_running, cidata detached, hibernate-legal)
                                  │
                                  ▼
          (cells's bake step:  POST /v1/wells/<n>/exec to install DNA / agent stack)
                                  │
                                  ▼
          POST /v1/wells/<n>/hibernate
          → 200 (well is now hibernating; RAM released to disk)

[wait]    (pool sits at depth; cells's refill loop watches its own state)

[claim]   POST /v1/wells/<n>/wake
          → 200 (well restored; alive_running again, ~1-2s)
                                  │
                                  ▼
          (cells's birth step: SSH via /exec to rotate hostname/machine-id/etc)
                                  │
                                  ▼
          (cell is alive, addressable at <n>.cells.md via vhost dispatch)

[expire]  DELETE /v1/wells/<n>
          → 200 (bundle torn down, lease released, registry remove)
```

---

## `POST /v1/wells` — create + boot a fresh well

The bake-side primitive. Creates a Linux VM, waits for SSH-ready, and returns. Pass `hibernate_ready: true` to get a hibernate-legal well at the end (slightly slower but required if you intend to hibernate it).

### Request

```http
POST /v1/wells
Authorization: Bearer $WELL_TOKEN
Content-Type: application/json

{
  "name": "my-egg-abc123",                  // required. POSIX-like. See validation below.
  "cpu": 4,                                  // optional. Defaults to 4.
  "memory": "1GB",                           // optional. Defaults to 1GB. Format: NNN(MB|GB|TB).
  "disk": "50GB",                            // optional. Defaults to 50GB. Same format.
  "from_image": "ubuntu-25.10-base",         // optional. Defaults to ubuntu-25.10-base.
  "env": {                                   // optional. Baked into /etc/environment on first boot.
    "CELLS_PROXY_SECRET": "<value>"
  },
  "hibernate_ready": true,                   // OPTIONAL. Default false. SEE BELOW.
  "r2": { ... }                              // optional. Per-well R2 creds for checkpoint sync.
}
```

### `hibernate_ready` — the critical field for pool builders

- `false` (default): well boots with cidata.iso attached, reaches alive_running, returns. ~6-8s faster. **Cannot hibernate** — calls to `/hibernate` return 409 `well_not_hibernate_ready`.
- `true`: well does the "warming sequence" — boot with cidata, run cloud-init, stop, restart WITHOUT cidata, wait for SSH. ~6-8s slower. **Can hibernate** — `hibernate.config.json` shows no auxiliary mounts so Apple's VZ restoreState succeeds.

**For your pool builder:** pass `hibernate_ready: true`. Always. Pool members must hibernate.

### Validation rules (HTTP 400 if violated)

- `name`: 3-50 chars, `[a-z][a-z0-9-]*`, ends with alphanumeric. Reserved prefixes: `pool-` (historical adopted-bundle naming).
- `memory`, `disk`: `^\d+(MB|GB|TB)$` (case-insensitive).
- `cpu`: integer 1-32.
- `from_image`: must exist locally OR be auto-pullable from R2 (if `WELL_R2_LIBRARY_*` env is set on welld). Throws 404 `image_not_found` if unresolvable.
- `from_thaw` and `from_image` are mutually exclusive (one or the other, not both).

### Response — 201 Created

```json
{
  "name": "my-egg-abc123",
  "uuid": "...",
  "status": "running",
  "url": "https://my-egg-abc123.cells.md",   // null if no WELL_PUBLIC_BASE configured
  "ip": "192.168.64.234",                     // post-DHCP-grant (or static if W.72 enabled)
  "created_at": "2026-05-13T...",
  "last_running_at": "2026-05-13T...",
  "cpu": 4,
  "memory": "1GB",
  "disk_size": "50GB",
  "disk_used_bytes": 1234567,
  "auto_sleep_seconds": null                  // unset means use defaults.auto_sleep_seconds
}
```

### Timing

| Variant                                  | p50  | p95  |
|------------------------------------------|------|------|
| `from_image: ubuntu-25.10-base`, `hibernate_ready: false` | ~6s  | ~10s |
| Same with `hibernate_ready: true`        | ~10s | ~17s |
| `from_image: <bake>` (your saved bake)   | ~5s  | ~10s |
| `from_thaw: <source>` (hibernate clone)  | ~1s  | ~2s  |

`from_thaw` is the fastest path. If your bake stays warm somewhere reachable, thawing from it produces a new well at ~1s wall-clock. **Serialized**: multiple concurrent `from_thaw` calls queue server-side (lume crashes on ≥2 concurrent restoreState — see `docs/findings-thaw.md`).

### Error codes

| Status | Code                       | When                                                        |
|--------|----------------------------|-------------------------------------------------------------|
| 400    | `validation_failed`        | name/sizing/env shape wrong                                 |
| 404    | `image_not_found`          | `from_image` missing locally + not in R2                    |
| 409    | `name_in_use`              | a registered well already has that name                     |
| 409    | `static_ip_exhausted`      | configured static-IP range full (W.72)                      |
| 500    | `bake_failed`              | lume.create or DHCP timeout — body includes context         |
| 503    | `degraded`                 | welld supervisor reports lume bouncing; back off            |

### Retry guidance

- 500 `bake_failed`: safe to retry with the SAME `name` after a few seconds — welld auto-cleans the partial bundle on failure. If the error message mentions DHCP, wait at least 5s (vmnet bridge sometimes needs to settle).
- 503 `degraded`: poll `GET /healthz` until `degraded: false`, then retry.
- 409 `name_in_use`: pick a different name. Don't DELETE the existing well unless you own it.

---

## `POST /v1/wells/{name}/hibernate` — release RAM to disk

The pool-make-ready primitive. Save the VM's full state (RAM + CPU + device state) to disk and release the running process. The well returns to status `stopped`; `runtime.state` becomes `hibernating` so wake knows where to find the saved state.

### Request

```http
POST /v1/wells/my-egg-abc123/hibernate
Authorization: Bearer $WELL_TOKEN
```

No body.

### Response — 200 OK

```json
{
  "ok": true,
  "name": "my-egg-abc123",
  "state": "hibernating",
  "hibernate_ms": 250
}
```

### Gate behavior

- Refuses with **409 `well_not_hibernate_ready`** if the well was created with `hibernate_ready: false`. The well doesn't have the disk-only steady-state Apple VZ requires for restore.
- Refuses with **409 `well_not_running`** if the well is already stopped or hibernating.
- Refuses with **409 `well_in_transition`** if a hibernate/wake is already in flight for this well.

### Timing

| Phase                          | typical    |
|--------------------------------|------------|
| VZ saveMachineState            | 200-400ms  |
| XPC child kill (W.74)          | < 50ms     |
| **Total wall-clock**           | 250-500ms  |

### Behavior on the file system

- `~/.wells/vms/<name>/hibernate.bin` — Apple's encrypted saved state (AEA1)
- `~/.wells/vms/<name>/hibernate.config.json` — VZ config snapshot (disk-only after warming sequence)
- `~/.wells/vms/<name>/runtime.json` updates: `state: hibernating`, `ip: null` (cleared on hibernate)
- Lume's bundle directory persists; the VM process exits

### Sibling-survive (W.74)

Hibernating one well does NOT affect any other running wells. Wells uses a per-VM XPC child kill (not lume serve respawn) so other VMs on the host stay alive.

---

## `POST /v1/wells/{name}/wake` — restore from hibernate.bin

The pool-claim primitive. Restore the VM's saved state and let it resume execution from the exact instruction it was hibernated at.

### Request

```http
POST /v1/wells/my-egg-abc123/wake
Authorization: Bearer $WELL_TOKEN
```

No body.

### Response — 200 OK

```json
{
  "ok": true,
  "name": "my-egg-abc123",
  "state": "alive_running",
  "ip": "192.168.64.234",
  "wake_ms": 820
}
```

### Gate behavior

- Refuses with **409 `well_not_hibernating`** if the well isn't in the hibernating state.
- Refuses with **409 `well_in_transition`** if another hibernate/wake is in flight.

### Timing

| Phase                          | typical     |
|--------------------------------|-------------|
| VZ restoreMachineState         | 200-800ms   |
| DHCP grant (or static IP take) | 50-500ms    |
| SSH-ready probe                | 0-300ms     |
| **Total wall-clock**           | 800-1500ms  |

### Concurrency caveat

VZ's `restoreMachineState` crashes if invoked concurrently. Welld serializes wakes server-side via a per-host mutex — your pool manager doesn't need to serialize, BUT if you fire many wakes in parallel they'll queue, not parallelize.

### What survives across hibernate → wake

- Process memory, open file descriptors, in-flight TCP connections (will need reset by peers — VZ doesn't replay packets)
- Disk state (unaffected by hibernate)
- Hostname, machine-id, SSH host keys (same as pre-hibernate)

### What does NOT survive

- TCP connections to/from the well — peers see RST after wake.
- `journalctl` clock skew may show a gap; some daemons (chronyd) recover gracefully, some don't.
- If your bake set up systemd timers, they may fire late post-wake.

### Cells's identity rotation post-wake

After `/wake`, your birth flow should SSH in and rotate hostname / machine-id / SSH host keys. The well is still wearing the previous tenant's identity. Wells's `well exec` (next section) is the right primitive.

---

## `POST /v1/wells/{name}/exec` — SSH passthrough

Sync exec (HTTP) for short commands. WebSocket upgrade for interactive sessions or commands that exceed the 4 MB sync cap.

### Sync mode — HTTP POST

```http
POST /v1/wells/my-egg-abc123/exec
Authorization: Bearer $WELL_TOKEN
Content-Type: application/json

{
  "command": ["bash", "-c", "hostnamectl set-hostname new-name"],
  "user": "ubuntu"                            // optional. Defaults to "well".
}
```

Response 200:

```json
{
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "truncated": false                          // true if combined output exceeded 4 MB
}
```

Welld SSHes as `well` (the only firstboot-provisioned user) and `sudo -n -u <user>` if `user` is anything else. `user: "ubuntu"` for raw-VM access. `user: "root"` for root-level changes. Note: `cell` (cells's bake-created user) works too if cells's bake creates it.

### WS upgrade mode

Same path, but client sends `Upgrade: websocket` headers. Welld establishes an SSH session under your control. Use this for interactive shells, multi-MB output, or long-running commands.

WS frame protocol:
- Client → server: JSON frames `{type: "stdin"|"resize"|"close", data}`
- Server → client: JSON frames `{type: "stdout"|"stderr"|"exit", data}`

See `docs/cells-integration.md` for the existing WS contract — it's stable.

### Timing

- First exec after wake: ~150-300ms (SSH ControlMaster reuse pays here)
- Subsequent execs on warm ControlMaster: ~10-30ms
- First exec ever (cold ControlMaster): ~200-500ms

### Wake-on-traffic

If the well is hibernated, **`/exec` does NOT auto-wake.** You must call `/wake` first. (The `/start` endpoint DOES auto-wake from hibernate, but it's for sprites-API compatibility — your pool flow should call `/wake` explicitly.)

---

## `DELETE /v1/wells/{name}` — destroy

The pool-expire primitive. Bundle teardown, lume VM removal, DHCP lease release, registry remove.

### Request

```http
DELETE /v1/wells/my-egg-abc123
Authorization: Bearer $WELL_TOKEN
```

### Response — 200 OK

```json
{
  "name": "my-egg-abc123",
  "removed": true
}
```

### Behavior

- If well is running, welld stops it first (gracefully — ACPI shutdown, 30s timeout, forceful fallback).
- Lume bundle dir removed.
- DHCP lease released via `welld-dhcp-helper` (if installed).
- Registry entry removed.
- Idempotent: deleting a non-existent name returns 200 `{removed: false}`.

### Timing

~2-4s for a running well (stop + teardown). ~1s for a stopped/hibernating well.

---

## `GET /v1/wells/{name}` — observed state

Read the current state of a well. Use for pool-side reconciliation (does wells still know about this name? Did its IP change after wake?).

### Response — 200 OK

```json
{
  "name": "my-egg-abc123",
  "uuid": "...",
  "status": "running",                         // running | stopped | missing
  "url": "https://my-egg-abc123.cells.md",
  "ip": "192.168.64.234",                      // null if no lease yet
  "created_at": "2026-05-13T...",
  "last_running_at": "2026-05-13T...",
  "cpu": 4,
  "memory": "1GB",
  "disk_size": "50GB",
  "disk_used_bytes": 1234567,
  "auto_sleep_seconds": null
}
```

### `status` field semantics

- `running` — lume reports the VM is up. Cell *may* be reachable (check `ip`).
- `stopped` — the VM is stopped (could be hibernating; check `runtime.state` via `/healthz` or by inspecting `~/.wells/vms/<name>/runtime.json` if you have host access).
- `missing` — registry has this name but lume doesn't know about the bundle. Usually means manual cleanup happened. Treat as a stale registry entry.

### Per Q4 in the answers doc

Wells reports observed state, not inferred state. `status: running, ip: null` is a valid response — wells doesn't try to derive "reachable" or "unreachable." Your pool manager owns reachability reasoning.

---

## `GET /v1/wells` — list all wells

```json
{
  "wells": [
    { "name": "my-egg-1", "status": "running", "url": "...", "ip": "...", "created_at": "...", "last_running_at": "..." },
    ...
  ]
}
```

Lightweight rows (no per-well disk usage, no R2 config). Use for "what wells does welld know about" reconciliation.

---

## `GET /healthz` — back-off signal

No auth. Poll periodically. Back off your refill burst when `degraded: true`.

```json
{
  "ok": true,
  "version": "0.1.0-pre",
  "started_at": "2026-05-13T...",
  "lume": {
    "base_url": "http://127.0.0.1:7777",
    "owned": true,
    "respawns_last_hour": 0,
    "respawns_last_5min": 0,
    "respawns_last_1min": 0
  },
  "vz_xpc_count": 12,                          // host VZ XPC count — useful for orphan detection
  "degraded": false,                           // back off when true
  "vmnet_leases": {
    "total": 23,
    "orphan_count": 2,
    "orphans": [{ "name": "...", "ip": "..." }]
  }
}
```

`degraded: true` means lume serve respawned 5+ times in 5 minutes. Your pool refill should pause until it flips back. Sync ops (single creates, hibernates, wakes) are still likely to work but fragile.

---

## Image management (you'll use this for your bake)

You probably want to save your post-bake-recipe state as a wells image, then create future pool members via `from_image: <your-bake>`. That cuts the per-bake cost from ~minutes (DNA install, agent setup) to ~seconds (clonefile).

### `POST /v1/wells/images` — save current well's disk as an image

```http
POST /v1/wells/images
Authorization: Bearer $WELL_TOKEN
Content-Type: application/json

{
  "name": "cell-base-2026-05-13",
  "from_well": "my-baking-well",
  "notes": "DNA + bun + claude-code installed",
  "validate": true                             // recommended
}
```

`validate: true` is important: welld SSH-rinses the source guest before clonefile (wipes machine-id, /etc/.well-ready, SSH host keys, authorized_keys, /var/lib/systemd/network/*; clean-shuts in the same SSH session). The resulting image produces clean forks where cloud-init re-runs identity setup.

Without `validate: true`, you have to manage the rinse yourself before save, OR forks will inherit the source's identity wholesale.

### `well create --from-image <name>` then hibernate is the pool-bake idiom

```
1. POST /v1/wells {name, from_image: "ubuntu-25.10-base", hibernate_ready: true}
2. POST /v1/wells/<n>/exec with your DNA install commands
3. POST /v1/wells/images {name: "cell-base-vN", from_well: <n>, validate: true}
4. DELETE /v1/wells/<n>                       // the baking well, no longer needed
5. POST /v1/wells {name: <pool-member-1>, from_image: "cell-base-vN", hibernate_ready: true}
6. POST /v1/wells/<pool-member-1>/hibernate
   → cell-base-vN is now the pool source; each pool member is cheap to create
```

The image lives at `~/.wells/images/<name>/{disk.img, meta.json, manifest.json}`. R2 sync is available via `well image push <name>` if you want to share bakes across Macs (Phase E Colony pattern).

---

## What's deliberately NOT in this doc

- **`POST /v1/wells/pool/...`** — deleted in Piece 2. Your pool, your endpoints.
- **`well pool` CLI subcommand** — deleted in Piece 2.
- **DHCP lease publishing** — wells doesn't write to `/var/db/dhcpd_leases` (deleted Piece 1). If your pool member's IP drifts post-wake, that's vmnet's bootpd, not wells.
- **Identity rotation primitive** — per Q2 in the answers doc, identityReset.ts moves to cells. SSH in via `/exec` and run whatever rotation you want.

---

## Where to ping for questions

The `/tmp/cells-wells-chat/` log convention has worked well during V1 acceptance. Use it for design questions; tag responses with the section name from this doc for cleanliness.

Wells will lock this surface during your migration. If anything in this doc proves wrong or insufficient during your build, ping immediately — we'll fix wells, not ship workarounds in cells.

— wells team · 2026-05-13 · post-V1 / pre-Piece-2
