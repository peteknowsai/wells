// Pure handlers for /v1/wells/images/* endpoints.
//
// List is tolerant of per-entry shape drift (cells team W.25 — a single
// malformed meta used to make the whole list 500, which broke bake's
// existence-probe). The validate-then-save flow on POST has the most
// branching, mirrored as deps so each leg is testable in isolation.

import { Value } from "@sinclair/typebox/value";
import { apiError } from "../apiResponse.ts";
import {
  ImageResource,
  type ImagesListResponse,
  ImageSaveRequest,
} from "../schemas.ts";
import { log } from "../log.ts";

export interface R2LibraryConfig {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

// ──────────────────────────── List ────────────────────────────

export interface ListImagesDeps {
  listImages(): Promise<unknown[]>;
}

export async function handleListImages(
  deps: ListImagesDeps,
): Promise<Response> {
  const images = await deps.listImages();
  const valid: unknown[] = [];
  for (const meta of images) {
    if (Value.Check(ImageResource, meta)) {
      valid.push(meta);
    } else {
      const errors = [...Value.Errors(ImageResource, meta)].slice(0, 3);
      log.warn("listImages: dropping malformed image meta", {
        name: (meta as { name?: unknown })?.name ?? "(unknown)",
        errors: errors.map((e) => `${e.path}: ${e.message}`),
      });
    }
  }
  const body: ImagesListResponse = {
    images: valid as ImagesListResponse["images"],
  };
  return Response.json(body);
}

// ──────────────────────────── Get ────────────────────────────

export interface GetImageDeps {
  imageMeta(name: string): Promise<unknown | null>;
}

export async function handleGetImage(
  name: string,
  deps: GetImageDeps,
): Promise<Response> {
  const meta = await deps.imageMeta(name);
  if (!meta) return apiError(404, "not_found", `image '${name}' not found`);
  if (!Value.Check(ImageResource, meta)) {
    log.error("response shape failed validation", {
      route: `GET /v1/wells/images/${name}`,
    });
    return new Response("internal: response shape mismatch\n", { status: 500 });
  }
  return Response.json(meta);
}

// ──────────────────────────── Delete ────────────────────────────

export interface DeleteImageDeps {
  removeImage(name: string): Promise<boolean>;
}

export async function handleDeleteImage(
  name: string,
  deps: DeleteImageDeps,
): Promise<Response> {
  let removed: boolean;
  try {
    removed = await deps.removeImage(name);
  } catch (e) {
    return apiError(400, "delete_failed", (e as Error).message);
  }
  return Response.json({ name, removed });
}

// ──────────────────────────── Save ────────────────────────────

export interface SaveImageDeps {
  // Wide return — engine type changes shouldn't ripple. Handler reads .status only.
  lumeInfo(name: string): Promise<unknown | null>;
  resolveLumeName(name: string): Promise<string>;
  resolveWellIp(name: string): Promise<string | null>;
  probeImageSource(
    ip: string,
    keyPath: string,
    timeoutMs: number,
  ): Promise<string[]>;
  rinseGuest(opts: { ip: string; keyPath: string }): Promise<void>;
  waitForDiskReleased(diskPath: string, timeoutMs: number): Promise<void>;
  transitionWellStop(name: string): Promise<unknown>;
  saveImage(opts: {
    fromWell: string;
    imageName: string;
    rinsed: boolean;
    notes?: string;
  }): Promise<unknown>;
  vmSshKey(name: string): string;
  bundleDiskPath(name: string): string;
}

export async function handleSaveImage(
  req: Request,
  deps: SaveImageDeps,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return apiError(400, "bad_json", "request body is not valid JSON");
  }
  if (!Value.Check(ImageSaveRequest, parsed)) {
    return apiError(
      400,
      "bad_request",
      [...Value.Errors(ImageSaveRequest, parsed)]
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ") || "request body failed validation",
    );
  }
  const body = parsed as ImageSaveRequest;
  const info = await deps.lumeInfo(await deps.resolveLumeName(body.from_well));
  const infoStatus = (info as { status?: unknown } | null)?.status;

  // Default rinse=true when validate=true (the typical bake flow).
  // Direct save (validate=false) keeps rinse opt-in.
  const wantRinse = body.rinse ?? body.validate === true;
  let didRinse = false;

  if (body.validate === true) {
    if (!info || infoStatus !== "running") {
      return apiError(
        400,
        "validate_requires_running",
        `validate=true needs '${body.from_well}' running (we SSH in for fork-time checks); start the well first`,
      );
    }
    const ip = await deps.resolveWellIp(body.from_well);
    if (!ip) {
      return apiError(
        500,
        "no_ip",
        `well '${body.from_well}' is running but has no resolvable IP — can't SSH for validation`,
      );
    }
    const reasons = await deps.probeImageSource(
      ip,
      deps.vmSshKey(body.from_well),
      10_000,
    );
    if (reasons.length > 0) {
      return apiError(
        400,
        "image_invalid_source",
        `source guest is missing fork-time prerequisites: ${reasons.join("; ")}`,
      );
    }
    if (wantRinse) {
      log.info("save: rinsing guest + shutting down", { well: body.from_well });
      try {
        await deps.rinseGuest({ ip, keyPath: deps.vmSshKey(body.from_well) });
        didRinse = true;
      } catch (e) {
        return apiError(500, "rinse_failed", (e as Error).message);
      }
      try {
        await deps.waitForDiskReleased(
          deps.bundleDiskPath(await deps.resolveLumeName(body.from_well)),
          60_000,
        );
      } catch (e) {
        return apiError(500, "disk_released_timeout", (e as Error).message);
      }
    } else {
      log.info("save: probe passed, stopping for clonefile", {
        well: body.from_well,
      });
      try {
        await deps.transitionWellStop(body.from_well);
      } catch (e) {
        return apiError(500, "stop_failed", (e as Error).message);
      }
    }
  } else if (info && infoStatus === "running") {
    return apiError(
      409,
      "well_running",
      `well '${body.from_well}' is running — stop it first or pass validate=true to have welld stop+probe+save atomically`,
    );
  }

  try {
    const meta = await deps.saveImage({
      fromWell: body.from_well,
      imageName: body.name,
      rinsed: didRinse,
      ...(body.notes ? { notes: body.notes } : {}),
    });
    if (!Value.Check(ImageResource, meta)) {
      log.error("response shape failed validation", {
        route: "POST /v1/wells/images",
      });
      return new Response("internal: response shape mismatch\n", { status: 500 });
    }
    return Response.json(meta, { status: 201 });
  } catch (e) {
    return apiError(400, "save_failed", (e as Error).message);
  }
}

// ──────────────────────────── R2 config resolver ────────────────────────────

export interface R2EnvSource {
  endpoint?: string;
  bucket?: string;
  access_key_id?: string;
  secret_access_key?: string;
}

export async function resolveR2LibraryConfig(
  req: Request,
  env: R2EnvSource,
): Promise<{ config: R2LibraryConfig } | { error: Response }> {
  let bodyConfig: Partial<R2LibraryConfig> = {};
  if (
    req.headers.get("content-length") &&
    req.headers.get("content-length") !== "0"
  ) {
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        bodyConfig = body as Partial<R2LibraryConfig>;
      }
    } catch {
      return {
        error: apiError(400, "bad_request", "request body must be JSON or empty"),
      };
    }
  }
  const config: R2LibraryConfig = {
    endpoint: bodyConfig.endpoint ?? env.endpoint ?? "",
    bucket: bodyConfig.bucket ?? env.bucket ?? "",
    access_key_id: bodyConfig.access_key_id ?? env.access_key_id ?? "",
    secret_access_key:
      bodyConfig.secret_access_key ?? env.secret_access_key ?? "",
  };
  const missing = (Object.keys(config) as (keyof R2LibraryConfig)[]).filter(
    (k) => !config[k],
  );
  if (missing.length > 0) {
    return {
      error: apiError(
        400,
        "r2_config_missing",
        `R2 library config missing fields: ${missing.join(", ")} — pass in body or set WELL_R2_LIBRARY_* env`,
      ),
    };
  }
  return { config };
}

// ──────────────────────────── Push ────────────────────────────

export interface PushImageDeps {
  resolveR2Config(
    req: Request,
  ): Promise<{ config: R2LibraryConfig } | { error: Response }>;
  pushImage(
    name: string,
    config: R2LibraryConfig,
    version: string,
  ): Promise<unknown>;
  version: string;
}

export async function handlePushImage(
  name: string,
  req: Request,
  deps: PushImageDeps,
): Promise<Response> {
  const cfg = await deps.resolveR2Config(req);
  if ("error" in cfg) return cfg.error;
  try {
    const result = await deps.pushImage(name, cfg.config, deps.version);
    return Response.json(result, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /not found locally|malformed/i.test(msg) ? 404 : 500;
    return apiError(status, "push_failed", msg);
  }
}

// ──────────────────────────── Pull ────────────────────────────

export interface PullImageDeps {
  resolveR2Config(
    req: Request,
  ): Promise<{ config: R2LibraryConfig } | { error: Response }>;
  pullImage(name: string, config: R2LibraryConfig): Promise<unknown>;
}

export async function handlePullImage(
  name: string,
  req: Request,
  deps: PullImageDeps,
): Promise<Response> {
  const cfg = await deps.resolveR2Config(req);
  if ("error" in cfg) return cfg.error;
  try {
    const result = await deps.pullImage(name, cfg.config);
    return Response.json(result, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /manifest\.json not in R2/i.test(msg) ? 404 : 500;
    return apiError(status, "pull_failed", msg);
  }
}
