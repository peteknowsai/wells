import { describe, expect, test } from "bun:test";
import {
  handleListImages,
  handleGetImage,
  handleSaveImage,
  handleDeleteImage,
  handlePushImage,
  handlePullImage,
  resolveR2LibraryConfig,
  type ListImagesDeps,
  type GetImageDeps,
  type SaveImageDeps,
  type DeleteImageDeps,
  type PushImageDeps,
  type PullImageDeps,
  type R2LibraryConfig,
} from "./image.ts";

function validMeta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ubuntu-25.10-base",
    from_well: "pete",
    from_disk_size: "10GB",
    created_at: "2026-05-12T00:00:00Z",
    ...over,
  };
}

function jsonReq(body: unknown, method = "POST"): Request {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/", {
    method,
    headers: { "content-length": String(bodyStr.length) },
    body: bodyStr,
  });
}

// ──────────────────────────── List ────────────────────────────

describe("handleListImages", () => {
  test("empty list → 200 with empty images", async () => {
    const deps: ListImagesDeps = { listImages: async () => [] };
    const res = await handleListImages(deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { images: unknown[] };
    expect(body.images).toEqual([]);
  });

  test("valid entries pass through; malformed entries dropped (W.25 tolerance)", async () => {
    const deps: ListImagesDeps = {
      listImages: async () => [
        validMeta({ name: "a" }),
        { name: "broken" }, // missing required fields
        validMeta({ name: "b" }),
      ],
    };
    const res = await handleListImages(deps);
    const body = await res.json() as { images: Array<{ name: string }> };
    expect(body.images.map((i) => i.name)).toEqual(["a", "b"]);
  });
});

// ──────────────────────────── Get ────────────────────────────

describe("handleGetImage", () => {
  test("404 when imageMeta returns null", async () => {
    const deps: GetImageDeps = { imageMeta: async () => null };
    const res = await handleGetImage("ghost", deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("200 with the meta when valid", async () => {
    const deps: GetImageDeps = { imageMeta: async (n) => validMeta({ name: n }) };
    const res = await handleGetImage("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string };
    expect(body.name).toBe("pete");
  });

  test("500 internal when meta shape drifts", async () => {
    const deps: GetImageDeps = { imageMeta: async () => ({ name: "broken" }) };
    const res = await handleGetImage("pete", deps);
    expect(res.status).toBe(500);
  });
});

// ──────────────────────────── Delete ────────────────────────────

describe("handleDeleteImage", () => {
  test("success: returns name + removed=true", async () => {
    const deps: DeleteImageDeps = { removeImage: async () => true };
    const res = await handleDeleteImage("pete", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; removed: boolean };
    expect(body.name).toBe("pete");
    expect(body.removed).toBe(true);
  });

  test("removed=false (idempotent miss) → still 200", async () => {
    const deps: DeleteImageDeps = { removeImage: async () => false };
    const res = await handleDeleteImage("ghost", deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean };
    expect(body.removed).toBe(false);
  });

  test("throw → 400 delete_failed", async () => {
    const deps: DeleteImageDeps = {
      removeImage: async () => {
        throw new Error("locked: image in use");
      },
    };
    const res = await handleDeleteImage("pete", deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("delete_failed");
    expect(body.message).toContain("in use");
  });
});

// ──────────────────────────── Save ────────────────────────────

function makeSaveDeps(over: Partial<SaveImageDeps> = {}): SaveImageDeps {
  return {
    lumeInfo: async () => ({ status: "stopped" }),
    resolveLumeName: async (n) => n,
    resolveWellIp: async () => "192.168.65.10",
    probeImageSource: async () => [],
    rinseGuest: async () => {},
    waitForDiskReleased: async () => {},
    transitionWellStop: async () => {},
    saveImage: async (opts) => validMeta({ name: opts.imageName }),
    vmSshKey: (n) => `/tmp/keys/${n}`,
    bundleDiskPath: (n) => `/tmp/bundle/${n}/disk.img`,
    ...over,
  };
}

describe("handleSaveImage", () => {
  test("400 bad_json on malformed body", async () => {
    const res = await handleSaveImage(jsonReq("not-json{"), makeSaveDeps());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_json");
  });

  test("400 bad_request when schema fails", async () => {
    const res = await handleSaveImage(jsonReq({}), makeSaveDeps());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("409 well_running when no-validate but well is running", async () => {
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete" }),
      deps,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("well_running");
  });

  test("400 validate_requires_running when validate=true and well not running", async () => {
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "stopped" }),
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validate_requires_running");
  });

  test("500 no_ip when validate=true and running but lease missing", async () => {
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      resolveWellIp: async () => null,
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("no_ip");
  });

  test("400 image_invalid_source when probe returns reasons", async () => {
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      probeImageSource: async () => ["missing /etc/.well-ready", "wrong shell"],
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("image_invalid_source");
    expect(body.message).toContain("missing /etc/.well-ready");
  });

  test("validate=true default: wantRinse=true → rinseGuest + waitForDiskReleased fire", async () => {
    let rinsed = false;
    let waited = false;
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      rinseGuest: async () => {
        rinsed = true;
      },
      waitForDiskReleased: async () => {
        waited = true;
      },
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(res.status).toBe(201);
    expect(rinsed).toBe(true);
    expect(waited).toBe(true);
  });

  test("validate=true, rinse=false → transitionWellStop fires (no rinse)", async () => {
    let rinsed = false;
    let stopped = false;
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      rinseGuest: async () => {
        rinsed = true;
      },
      transitionWellStop: async () => {
        stopped = true;
      },
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true, rinse: false }),
      deps,
    );
    expect(res.status).toBe(201);
    expect(rinsed).toBe(false);
    expect(stopped).toBe(true);
  });

  test("rinseGuest throws → 500 rinse_failed", async () => {
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      rinseGuest: async () => {
        throw new Error("ssh handshake failed");
      },
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("rinse_failed");
  });

  test("waitForDiskReleased throws → 500 disk_released_timeout", async () => {
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      waitForDiskReleased: async () => {
        throw new Error("still locked after 60s");
      },
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("disk_released_timeout");
  });

  test("saveImage throws → 400 save_failed", async () => {
    const deps = makeSaveDeps({
      saveImage: async () => {
        throw new Error("disk full");
      },
    });
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete" }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("save_failed");
  });

  test("success no-validate: 201 with meta", async () => {
    const deps = makeSaveDeps();
    const res = await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete" }),
      deps,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { name: string };
    expect(body.name).toBe("img");
  });

  test("saveImage receives rinsed=true after validate+rinse path", async () => {
    let opts: { rinsed?: boolean } | undefined;
    const deps = makeSaveDeps({
      lumeInfo: async () => ({ status: "running" }),
      saveImage: async (o) => {
        opts = o;
        return validMeta({ name: o.imageName });
      },
    });
    await handleSaveImage(
      jsonReq({ name: "img", from_well: "pete", validate: true }),
      deps,
    );
    expect(opts?.rinsed).toBe(true);
  });
});

// ──────────────────────────── R2 config resolver ────────────────────────────

describe("resolveR2LibraryConfig", () => {
  test("all four fields from body → returns config", async () => {
    const req = jsonReq({
      endpoint: "https://r2.example",
      bucket: "b",
      access_key_id: "k",
      secret_access_key: "s",
    });
    const r = await resolveR2LibraryConfig(req, {});
    expect("config" in r).toBe(true);
    if ("config" in r) {
      expect(r.config.bucket).toBe("b");
    }
  });

  test("missing fields → 400 r2_config_missing", async () => {
    const req = jsonReq({ endpoint: "https://r2.example" });
    const r = await resolveR2LibraryConfig(req, {});
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.status).toBe(400);
      const body = await r.error.json() as { error: string; message: string };
      expect(body.error).toBe("r2_config_missing");
      expect(body.message).toContain("bucket");
    }
  });

  test("env fallback when body absent", async () => {
    const req = new Request("http://localhost/", { method: "POST" });
    const r = await resolveR2LibraryConfig(req, {
      endpoint: "https://r2.example",
      bucket: "envb",
      access_key_id: "envk",
      secret_access_key: "envs",
    });
    expect("config" in r).toBe(true);
    if ("config" in r) {
      expect(r.config.bucket).toBe("envb");
    }
  });

  test("body overrides env", async () => {
    const req = jsonReq({ bucket: "bodyb" });
    const r = await resolveR2LibraryConfig(req, {
      endpoint: "https://r2.example",
      bucket: "envb",
      access_key_id: "envk",
      secret_access_key: "envs",
    });
    if ("config" in r) {
      expect(r.config.bucket).toBe("bodyb");
    } else {
      throw new Error("expected config");
    }
  });

  test("invalid JSON body → 400 bad_request", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-length": "5" },
      body: "{not!",
    });
    const r = await resolveR2LibraryConfig(req, {});
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.status).toBe(400);
    }
  });
});

// ──────────────────────────── Push ────────────────────────────

const validR2: R2LibraryConfig = {
  endpoint: "https://r2.example",
  bucket: "b",
  access_key_id: "k",
  secret_access_key: "s",
};

describe("handlePushImage", () => {
  test("success: 201 with result", async () => {
    const deps: PushImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pushImage: async () => ({ ok: true }),
      version: "1.0.0",
    };
    const res = await handlePushImage("img", jsonReq({}), deps);
    expect(res.status).toBe(201);
  });

  test("r2 config error short-circuits", async () => {
    const errResp = Response.json({ error: "r2_config_missing" }, { status: 400 });
    const deps: PushImageDeps = {
      resolveR2Config: async () => ({ error: errResp }),
      pushImage: async () => {
        throw new Error("should not reach");
      },
      version: "1.0.0",
    };
    const res = await handlePushImage("img", jsonReq({}), deps);
    expect(res.status).toBe(400);
  });

  test("not-found message → 404 push_failed", async () => {
    const deps: PushImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pushImage: async () => {
        throw new Error("image 'img' not found locally");
      },
      version: "1.0.0",
    };
    const res = await handlePushImage("img", jsonReq({}), deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("push_failed");
  });

  test("other error → 500 push_failed", async () => {
    const deps: PushImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pushImage: async () => {
        throw new Error("R2 5xx");
      },
      version: "1.0.0",
    };
    const res = await handlePushImage("img", jsonReq({}), deps);
    expect(res.status).toBe(500);
  });

  test("version is passed to pushImage", async () => {
    let captured = "";
    const deps: PushImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pushImage: async (_n, _c, v) => {
        captured = v;
        return {};
      },
      version: "v1.2.3",
    };
    await handlePushImage("img", jsonReq({}), deps);
    expect(captured).toBe("v1.2.3");
  });
});

// ──────────────────────────── Pull ────────────────────────────

describe("handlePullImage", () => {
  test("success: 201 with result", async () => {
    const deps: PullImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pullImage: async () => ({ ok: true }),
    };
    const res = await handlePullImage("img", jsonReq({}), deps);
    expect(res.status).toBe(201);
  });

  test("manifest-not-in-r2 → 404 pull_failed", async () => {
    const deps: PullImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pullImage: async () => {
        throw new Error("manifest.json not in R2");
      },
    };
    const res = await handlePullImage("img", jsonReq({}), deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pull_failed");
  });

  test("other error → 500", async () => {
    const deps: PullImageDeps = {
      resolveR2Config: async () => ({ config: validR2 }),
      pullImage: async () => {
        throw new Error("network unreachable");
      },
    };
    const res = await handlePullImage("img", jsonReq({}), deps);
    expect(res.status).toBe(500);
  });
});
