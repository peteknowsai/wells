// TypeBox shapes for splited's REST API. Sprites-shaped — field names and
// shapes match what cells expects when it calls a sprite. This is the
// compatibility surface that lets `CELLS_BACKEND=splite` work without
// touching cells's response-handling code.

import { Type, type Static } from "@sinclair/typebox";

// Status from the engine. "missing" = registry has it but the engine
// (lume / firecracker / whatever) doesn't know about the bundle anymore.
export const SpliteStatus = Type.Union([
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("missing"),
]);

// What `GET /v1/splites` returns per row. Minimal — enough to drive
// `splite list` and cells's "show me my splites" UI without full info().
export const SpliteSummary = Type.Object({
  name: Type.String(),
  status: SpliteStatus,
  url: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_running_at: Type.Union([Type.String(), Type.Null()]),
});
export type SpliteSummary = Static<typeof SpliteSummary>;

// What `GET /v1/splites/{name}` returns. Adds the per-splite metadata
// that's expensive to gather for a list view.
export const SpliteResource = Type.Object({
  name: Type.String(),
  uuid: Type.String(),
  status: SpliteStatus,
  url: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_running_at: Type.Union([Type.String(), Type.Null()]),
  cpu: Type.Number(),
  memory: Type.String(),
  disk_size: Type.String(),
  disk_used_bytes: Type.Union([Type.Number(), Type.Null()]),
});
export type SpliteResource = Static<typeof SpliteResource>;

export const SplitesListResponse = Type.Object({
  splites: Type.Array(SpliteSummary),
});
export type SplitesListResponse = Static<typeof SplitesListResponse>;

export const CheckpointResource = Type.Object({
  id: Type.String(),
  created_at: Type.String(),
  size_bytes: Type.Number(),
  physical_bytes: Type.Number(),
});
export type CheckpointResource = Static<typeof CheckpointResource>;

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

// POST /v1/splites body.
export const CreateSpliteRequest = Type.Object({
  name: Type.String(),
  cpu: Type.Optional(Type.Number()),
  memory: Type.Optional(Type.String()),
  disk: Type.Optional(Type.String()),
});
export type CreateSpliteRequest = Static<typeof CreateSpliteRequest>;

// DELETE /v1/splites/{name} response. Idempotent: found=false means
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
