# Sprites parity contract

This is the contract splites commits to in order to be a drop-in stand-in for sprites. The "consumer" is cells (`~/Projects/cells`) — the only real-world caller we currently target. Anything cells does, splites does identically. When the two diverge, splites adapts.

The cells call sites listed below are what we treat as the canonical surface. If a future sprites-side change ships and cells adopts it, we mirror.

## HTTP API endpoints cells hits

cells builds requests through `api()` at `~/Projects/cells/cli/cells.ts:2988`. Base URL `https://api.sprites.dev`, override via `SPRITES_API_URL`. Auth: `Authorization: Bearer $SPRITES_TOKEN` (read from `~/.cells/secrets.json` → `SPRITES_TOKEN`).

| Endpoint | Caller | Reads / sends | Notes |
|---|---|---|---|
| `GET /v1/sprites/{n}` | `cells.ts:3020`, `scripts/harden-birth.ts:183`, `scripts/eval-birth.ts:217` | reads `status`, `url`, `created_at`, `last_running_at` | 404 means missing — cells treats as a known state, not error |
| `POST /v1/sprites/{n}/exec` | `projects/jury/extension/deliberate/index.ts:37` | sends `{command: ["bash","-lc",<script>]}`; reads `exit_code` (or `exitCode`), `stdout`, `stderr` | synchronous — buffers full output; cells accepts both casings |
| `GET /v1/sprites/{n}/policy/network` | `cells.ts:3021` | reads `policy.rules[*].{action, domain}` | tolerated to 404 / fail (`.catch(() => null)`) |
| `PUT /v1/sprites/{n}/services/{id}` | `scripts/register-site-service.sh:41` | sends `{cmd, args, workdir}` | DELETE-then-PUT pattern (PUT is no-op on existing) |
| `DELETE /v1/sprites/{n}/services/{id}` | `scripts/register-site-service.sh:37` | — | idempotent precondition |

WebSocket `wss://<sprite-host>/agent` (`cells.ts:2323`) is the persistent bridge cells's CF Worker holds open. **Splites is not responsible for /agent's frame format** — it's the splite's own app server (cells's `pi` running inside the splite). Splites only proxies the upgrade.

### Quirks splites must honor

- **404 on `GET /v1/sprites/{n}` is success-shaped.** `harden-birth.ts:186` checks `r.status === 404` as "doesn't exist." Don't return 5xx instead.
- **Snake_case wins.** `exit_code`, `created_at`, `last_running_at`. Cells defensively reads camelCase too, but we emit snake_case to match real sprites.
- **Tolerant policy reads.** `GET /policy/network` may legitimately fail (no policy set, splite gone, etc.). Cells wraps the read in `.catch(() => null)`. Splites still returns 200 + `{rules: []}` on no-policy-yet so the success path stays clean.
- **PUT services is "create-only" semantics.** Real sprites silently no-ops on existing services. Cells DELETEs first to clear stale state. Splites today actually mutates on PUT (better behavior); cells's DELETE-then-PUT works either way.
- **WS retry budget.** Cells retries the `/agent` upgrade with 0/3/6/12s backoff (~30s total). Cold splites need to be reachable within that window — same constraint sprites operates under.

## CLI shell-outs cells does

cells spawns a `sprite` binary on `PATH` for these. Splites's `splite` binary is the drop-in. The intended setup: `ln -s $(which splite) ~/.local/bin/sprite` (or rename `splite → sprite`). Argv shapes match exactly.

| Argv | Caller | stdin | stdout/stderr | Notes |
|---|---|---|---|---|
| `sprite destroy <n> --force` | `cells.ts:1470` | none | exit code checked | "not found" counts as success |
| `sprite exec -s <n> [--tty] -- bash -c <script>` | `cells.ts:1975, 2461, 2706, 3116, 3141`, `scripts/configure-cell-proxy.sh`, `scripts/apt-install-on-cell.sh`, `projects/jury/birth-jury.sh:124` | sometimes piped (tar xzf, cat > file) | parsed or streamed depending on caller | `bash -c`, `bash -lc`, sometimes `--tty` for interactive |
| `sprite exec -s <n> --tty -- bash -lc <tmux>` | `cells.ts:862, 905` | inherit | inherit | interactive tmux sessions |
| `sprite restore v1 -s <n>` | `cells.ts:3751` | none | exit code | top-level `restore` (not `checkpoint restore`); blocks until done |
| `sprite url update --auth public -s <n>` | `cells.ts:3842` | none | exit code | hatch step that flips proxy from private to public |
| `sprite info -s <n>` | `scripts/deploy-cell-worker.sh:36` | none | piped to `awk '/^URL:/ {print $2}'` | plain-text format with `URL: <url>` line |
| `sprite checkpoint create -s <n> [--comment <label>]` | `proto/mother/.pi/extensions/sprite-tools/index.ts` | none | exit code | comment optional |
| `sprite create <n>` | `proto/mother/.pi/extensions/sprite-tools/index.ts` | none | exit code | no flags from sprite-tools today |
| `sprite api -s <n> /v1/sprites/<n>/<path> -X <METHOD> -H ... -d <body>` | `proto/mother/.pi/extensions/sprite-tools/index.ts:192` | none | parsed as JSON | raw curl-style passthrough; `-s` is redundant (path has the name) |

### Quirks splites must honor

- **`--force`, not `--yes`.** Splites accepts both as aliases.
- **Top-level `restore`.** Splites accepts both `splite restore <id>` (sprites parity) and `splite checkpoint restore <id>` (splites canonical).
- **`info` plain-text output.** Splites emits a literal `URL: <url>` line so `awk '/^URL:/ {print $2}'` works. Other fields stay lowercase. `--json` output is not affected.
- **`-s <n>` in `splite api`.** Splites silently strips it before parsing positional args. The path alias (`/v1/sprites/...` → `/v1/splites/...`) handles the noun rewrite at the daemon.
- **Exec shell-escape.** Cells passes scripts containing `;`, pipes, quotes, `$VAR`. Splites's `exec` shell-quotes each cmd arg before joining and passing to ssh as a single argument — so the remote shell sees the script verbatim. (Daemon's WS handler already does this; CLI mirrors it.)

## What splites is NOT responsible for

- **The splite's app server at `/agent`.** That's cells's `pi` runtime running inside the splite. Splites proxies the upgrade and gets out of the way.
- **The CF Worker bridge.** Cells's worker dials `wss://<n>.<base>/agent`; splites is one possible answerer but the worker code is cells-side.
- **Cells's secrets, tokens, KV, R2.** Splites stores its own bearer token at `~/.splites/token`; cells's `SPRITES_TOKEN` happens to point at it, but the two are configured separately.

## Path alias

Splites's daemon serves both `/v1/splites/...` (canonical) and `/v1/sprites/...` (alias). Cells uses the latter; splites's CLI uses the former. The alias is implemented at `daemon/splited.ts` as a single `pathname` rewrite at the top of `fetch()`.

## Verification

The bundled smoke `scripts/smoke-cells-call-shapes.sh <splite-name>` exercises every shape in this document against a live splited + splite. If any item in this doc is added or changed, that smoke is the gate.
