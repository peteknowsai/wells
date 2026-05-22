// TypeBox shapes for welld's REST API. Sprites-shaped — field names and
// shapes match what cells expects when it calls a sprite. This is the
// compatibility surface that lets `CELLS_BACKEND=well` work without
// touching cells's response-handling code.

import { Type, type Static } from "@sinclair/typebox";

// Status from the engine. "missing" = registry has it but the engine
// (lume / firecracker / whatever) doesn't know about the bundle anymore.
export const WellStatus = Type.Union([
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("missing"),
]);

// Wedge-detection label — substrate-side SSH-banner probe verdict.
// "ok" by default; "suspected" after 3 consecutive probe failures
// (1.5 min); "confirmed" after 6 (3 min). Cells filters on this to
// drive its recovery loop.
export const WedgeLabelSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("suspected"),
  Type.Literal("confirmed"),
]);

// What `GET /v1/wells` returns per row. Minimal — enough to drive
// `well list` and cells's "show me my wells" UI without full info().
export const WellSummary = Type.Object({
  name: Type.String(),
  status: WellStatus,
  url: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_running_at: Type.Union([Type.String(), Type.Null()]),
  wedge: WedgeLabelSchema,
  // True once the well has been sealed (POST /seal flipped
  // runtime.hibernate_ready). Hibernate refuses on false. Cells reads
  // this to turn its invariant-4 guard from always-seal into a cheap
  // check-then-seal.
  hibernate_ready: Type.Boolean(),
});
export type WellSummary = Static<typeof WellSummary>;

// What `GET /v1/wells/{name}` returns. Adds the per-well metadata
// that's expensive to gather for a list view.
export const WellResource = Type.Object({
  name: Type.String(),
  uuid: Type.String(),
  status: WellStatus,
  url: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_running_at: Type.Union([Type.String(), Type.Null()]),
  cpu: Type.Number(),
  memory: Type.String(),
  disk_size: Type.String(),
  disk_used_bytes: Type.Union([Type.Number(), Type.Null()]),
  // Per-well override on autosleep. undefined → use global default.
  // null → never sleep. number → idle threshold in seconds.
  auto_sleep_seconds: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  wedge: WedgeLabelSchema,
  // True once the well has been sealed (POST /seal flipped
  // runtime.hibernate_ready). Hibernate refuses on false.
  hibernate_ready: Type.Boolean(),
});
export type WellResource = Static<typeof WellResource>;

export const WellsListResponse = Type.Object({
  wells: Type.Array(WellSummary),
});
export type WellsListResponse = Static<typeof WellsListResponse>;

export const CheckpointResource = Type.Object({
  id: Type.String(),
  created_at: Type.String(),
  size_bytes: Type.Number(),
  physical_bytes: Type.Number(),
  comment: Type.Optional(Type.String()),
  expires_at: Type.Optional(Type.String()),
  retain_for_seconds: Type.Optional(Type.Number()),
  r2_uploaded: Type.Optional(Type.Boolean()),
  r2_key: Type.Optional(Type.String()),
});
export type CheckpointResource = Static<typeof CheckpointResource>;

export const CreateCheckpointRequest = Type.Object({
  comment: Type.Optional(Type.String()),
  // Duration string (e.g. "7d", "12h", "30m"). Daemon parses it via
  // checkpoints.parseDuration before persisting.
  retain_for: Type.Optional(Type.String()),
});
export type CreateCheckpointRequest = Static<typeof CreateCheckpointRequest>;

export const CheckpointsListResponse = Type.Object({
  checkpoints: Type.Array(CheckpointResource),
});
export type CheckpointsListResponse = Static<typeof CheckpointsListResponse>;

// Standard error envelope. 4xx/5xx responses carry one of these.
export const ApiError = Type.Object({
  error: Type.String(),
  message: Type.String(),
});
export type ApiError = Static<typeof ApiError>;

// R2 / S3-compatible credentials for cold-tier checkpoint sync. Mirrors
// the WellRecord shape so they pass through unchanged.
export const R2ConfigRequest = Type.Object({
  endpoint: Type.String(),
  bucket: Type.String(),
  access_key_id: Type.String(),
  secret_access_key: Type.String(),
});
export type R2ConfigRequest = Static<typeof R2ConfigRequest>;

// POST /v1/wells body.
export const CreateWellRequest = Type.Object({
  name: Type.String(),
  cpu: Type.Optional(Type.Number()),
  memory: Type.Optional(Type.String()),
  disk: Type.Optional(Type.String()),
  r2: Type.Optional(R2ConfigRequest),
  // Env vars baked into /etc/environment via cloud-init. PAM loads
  // /etc/environment on every session (including SSH non-login), so
  // these are visible to anything cells's birth flow runs. Use this
  // for things like CELLS_PROXY_SECRET that need to be in the well
  // from first boot — saves a post-birth round-trip.
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  // Name of an image to clone from instead of the default
  // ubuntu-<release>-base. Must exist in ~/.wells/images/. Cloned via
  // APFS clonefile so this is sub-millisecond regardless of disk size.
  // Cells's birth flow uses this to skip the ~3-5min cloud-init boot.
  from_image: Type.Optional(Type.String()),
  // W.26 — name of a HIBERNATING source well to thaw from (one
  // hibernate.bin → many running clones). Wells materializes the
  // new well by mirroring src's bundle (config.json + nvram.bin +
  // disk.img + hibernate.bin) and calling VZ.restoreMachineStateFrom.
  // No boot; per-thaw cost ≈ 1s wall-clock. Mutually exclusive with
  // from_image. See docs/findings-thaw.md. Multi-thaw is serialized
  // server-side (lume crashes under ≥2 concurrent restoreState).
  from_thaw: Type.Optional(Type.String()),
});
export type CreateWellRequest = Static<typeof CreateWellRequest>;

// Saved disk images. Frozen snapshots of a well's bundle disk that
// `well create --from-image` can clone in sub-millisecond time.
export const ImageResource = Type.Object({
  name: Type.String(),
  from_well: Type.Union([Type.String(), Type.Null()]),
  from_disk_size: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  notes: Type.Optional(Type.String()),
  size_bytes: Type.Optional(Type.Number()),
});
export type ImageResource = Static<typeof ImageResource>;

export const ImagesListResponse = Type.Object({
  images: Type.Array(ImageResource),
});
export type ImagesListResponse = Static<typeof ImagesListResponse>;

// POST /v1/wells/images body. Source must be stopped (the daemon
// returns 409 well_running if it isn't). No identity rinse here —
// cloud-init-well.yaml's runcmd already resets machine-id, regenerates
// ssh host keys, and sets the new hostname when the fork mounts cidata
// with a new instance-id, so a plain clonefile is enough.
//
// `validate: true` flips the flow: source must be RUNNING; welld
// SSHes in and asserts /etc/netplan, /var/lib/cloud/data/, cloud-init
// + networkd enabled before stopping and saving. Refuses with
// `image_invalid_source` if any check fails. Cells punchlist
// 2026-05-08: defense in depth alongside cells's post-save --verify.
export const ImageSaveRequest = Type.Object({
  name: Type.String(),
  from_well: Type.String(),
  notes: Type.Optional(Type.String()),
  validate: Type.Optional(Type.Boolean()),
  // Explicit rinse override. Defaults to validate's value (true when
  // validate=true, false otherwise). Set explicitly to opt in/out.
  rinse: Type.Optional(Type.Boolean()),
});
export type ImageSaveRequest = Static<typeof ImageSaveRequest>;

// DELETE /v1/wells/{name} response. Idempotent: found=false means
// nothing existed; the action is still considered successful (200).
export const DestroyResponse = Type.Object({
  name: Type.String(),
  found: Type.Boolean(),
  removed_registry: Type.Boolean(),
  removed_state_dir: Type.Boolean(),
  removed_bundle: Type.Boolean(),
});
export type DestroyResponse = Static<typeof DestroyResponse>;

// Network egress policy. Matches sprites's shape: a list of {action, domain}
// rules. Phase 9 only validates the request and stores it — pf-rule
// enforcement on the host's tap interface is deferred to Phase A.
export const NetworkRule = Type.Object({
  action: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  domain: Type.String(),
});
export type NetworkRule = Static<typeof NetworkRule>;

export const NetworkPolicyRequest = Type.Object({
  rules: Type.Array(NetworkRule),
});
export type NetworkPolicyRequest = Static<typeof NetworkPolicyRequest>;

export const NetworkPolicyResponse = Type.Object({
  accepted: Type.Boolean(),
  enforced: Type.Boolean(),
  rules: Type.Array(NetworkRule),
});
export type NetworkPolicyResponse = Static<typeof NetworkPolicyResponse>;

// Per-well service definition. Field names match cells's wire shape
// verbatim — `register-site-service.sh` PUTs `{cmd, args, workdir}` and
// we translate that into a systemd unit inside the guest. `env` and
// `auto_restart` are optional extensions; cells doesn't send them today.
export const ServiceDefinition = Type.Object({
  cmd: Type.String(),
  args: Type.Array(Type.String()),
  workdir: Type.String(),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  auto_restart: Type.Optional(Type.Boolean()),
  // Run the unit as this user. Defaults to `ubuntu` (cloud image's
  // default). Cells team uses this to land services as the `cell`
  // user when their bake DNA lives at /cell/ owned by cell:cell.
  user: Type.Optional(Type.String()),
});
export type ServiceDefinition = Static<typeof ServiceDefinition>;

// What `GET /v1/wells/{n}/services/{id}` returns.
export const ServiceResource = Type.Object({
  id: Type.String(),
  well: Type.String(),
  definition: ServiceDefinition,
  created_at: Type.String(),
});
export type ServiceResource = Static<typeof ServiceResource>;

export const ServicesListResponse = Type.Object({
  services: Type.Array(ServiceResource),
});
export type ServicesListResponse = Static<typeof ServicesListResponse>;

// Synchronous exec — what cells's `projects/jury/extension/deliberate/index.ts:37`
// POSTs. Body shape `{command: ["bash","-lc",<script>]}` matches sprites.
// Response uses snake_case field names (cells defensively reads camelCase too).
export const ExecRequest = Type.Object({
  command: Type.Array(Type.String()),
  // Optional override of the exec user. Welld SSHes in as root (the VM
  // is the sandbox boundary) and runs the command directly; a non-root
  // value sudo-switches. Set to "ubuntu" for raw-VM debug.
  user: Type.Optional(Type.String()),
});
export type ExecRequest = Static<typeof ExecRequest>;

export const ExecResponse = Type.Object({
  exit_code: Type.Number(),
  stdout: Type.String(),
  stderr: Type.String(),
  truncated: Type.Optional(Type.Boolean()),
});
export type ExecResponse = Static<typeof ExecResponse>;

// Per-well URL auth toggle. Cells calls `sprite url update --auth public`
// during the hatch flow to flip a sprite from private (default) to public.
export const WellAuthMode = Type.Union([
  Type.Literal("public"),
  Type.Literal("well"),
]);
export type WellAuthMode = Static<typeof WellAuthMode>;

export const UrlUpdateRequest = Type.Object({
  auth: WellAuthMode,
});
export type UrlUpdateRequest = Static<typeof UrlUpdateRequest>;

// PATCH /v1/wells/{n} body. Sparse — only fields that are present
// get updated. Currently `auto_sleep_seconds` (number | null) is the
// only mutable field; more can be added without bumping the shape.
//
// `null` means "never sleep" (explicit override). Omitting the key
// means "leave the field as-is on the record." A future client that
// wants to *clear* an override back to "use default" can send `0` —
// `shouldAutoSleep` treats 0/NaN as disabled, which is what the user
// wants when they say "use the default."
export const PatchWellRequest = Type.Object({
  auto_sleep_seconds: Type.Optional(
    Type.Union([Type.Number(), Type.Null()]),
  ),
});
export type PatchWellRequest = Static<typeof PatchWellRequest>;
