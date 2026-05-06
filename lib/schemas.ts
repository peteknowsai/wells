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

// Standard error envelope. 4xx/5xx responses carry one of these.
export const ApiError = Type.Object({
  error: Type.String(),
  message: Type.String(),
});
export type ApiError = Static<typeof ApiError>;
