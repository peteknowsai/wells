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
- `POST /v1/sprites/{name}/exec` body `{command: string[]}` → `{exit_code, stdout, stderr, truncated?}`. Synchronous, 4 MB combined cap.
- `GET/POST /v1/sprites/{name}/policy/network` — domain allow/deny rules, persisted.
- `PUT /v1/sprites/{name}/url` body `{auth: "public"|"well"}` — flip per-well proxy auth.
- `PUT/DELETE /v1/sprites/{name}/services/{id}` — register/deregister services.
- `POST /v1/sprites/{name}/checkpoints` body `{comment?: string}` — checkpoint create.

All require `Authorization: Bearer $WELL_TOKEN`. Token lives at `~/.wells/token`, auto-generated on first welld start.

## What `well create` accepts

Cells's birth flow can create wells with these flags:

```bash
well create <name> [--cpu=N] [--memory=NGB] [--disk=NGB] \
  [--env KEY=VALUE]... \
  [--r2-endpoint=URL --r2-bucket=NAME --r2-key=ID --r2-secret=KEY]
```

`--env KEY=VAL` (repeatable) lands the pair in `/etc/environment` on the well at first boot. PAM auto-loads it on every SSH session including non-login. Use this for `CELLS_PROXY_SECRET` so the secret is present from boot — no post-birth round-trip needed.

Wells boot with a `sprite` user (uid 1001, NOPASSWD sudo, `/home/sprite/.ssh/authorized_keys` populated with the operator's host key). Cells's birth flow should target `sprite@<ip>` to mirror the sprites contract.

## What's NOT a wells concern

- Picking the domain. Operator does that.
- Worker code or its routing logic. Cells team owns that.
- DNS or cloudflared config. Operator owns that. (Wells docs in `docs/install.md` cover the steps for the default `wells.cells.md` setup.)
- Telling clients which Pattern (A or B) is in use. Cells team's `cells init` decides per operator.
