// `/api/phone`: pairing, rotating, revoking and wiping phones, and what each one
// has reported.
//
// Two things are checked end to end rather than by reading rows: that a token
// the API hands out really authenticates `POST /ingest/health-connect` (and stops
// doing so after a rotate or a revoke), and that the stored row holds a digest,
// never the token. Everything is synthetic.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { INGEST_PATH } from "../../../src/ingest/route.ts";

import { CSRF, ORIGIN, call, freshOwner, json, testRepos } from "./helpers.ts";

import type {
  ApiError,
  DeviceCoverageRowDto,
  DeviceDto,
  DeviceIngestLogDto,
  PairedDeviceDto,
  WipeDeviceResponse,
} from "@shared/types.ts";

const owner = freshOwner();

// The shared reset does not know about the Health Connect tables. Deleting the
// devices empties every table that hangs off them.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM devices").run();
});

/** A paired device, with the token read out of the pairing code (the response has no other copy). */
type Paired = PairedDeviceDto & { token: string };

function withToken(paired: PairedDeviceDto): Paired {
  const { token } = JSON.parse(paired.pairing) as { token: string };
  return { ...paired, token };
}

async function pair(name = "Example phone"): Promise<Paired> {
  const response = await owner().send("POST", "/api/phone/devices", { name });
  expect(response.status).toBe(201);
  return withToken(await json<PairedDeviceDto>(response));
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const batches = { sent: 0 };

/** One empty, valid batch from `deviceId` with `token`: what a phone's first sync looks like. */
async function ingest(deviceId: string, token: string): Promise<Response> {
  batches.sent += 1;
  const body = await gzip(
    JSON.stringify({
      v: 1,
      deviceId,
      appVersion: "0.0.1",
      batchId: `batch-${String(batches.sent).padStart(6, "0")}`,
      phoneTime: 1_790_000_000_000,
      upserts: [],
      deletes: [],
    }),
  );
  return call(INGEST_PATH, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-encoding": "gzip",
      "content-type": "application/json",
    },
    body,
  });
}

/** The status of an `/ingest` call: what a phone learns about its token. */
async function ingestStatus(deviceId: string, token: string): Promise<number> {
  const response = await ingest(deviceId, token);
  return response.status;
}

async function sendStatus(method: string, path: string, body?: unknown): Promise<number> {
  const response = await owner().send(method, path, body);
  return response.status;
}

async function getStatus(path: string): Promise<number> {
  const response = await owner().get(path);
  return response.status;
}

async function listDevices(): Promise<DeviceDto[]> {
  return json<DeviceDto[]>(await owner().get("/api/phone/devices"));
}

async function firstDeviceStatus(): Promise<string | undefined> {
  const devices = await listDevices();
  return devices[0]?.status;
}

async function bodyText(path: string): Promise<string> {
  const response = await owner().get(path);
  return response.text();
}

async function seedSyncState(
  deviceId: string,
  recordType: string,
  columns: { permission: string; count?: number; lastUploadAt?: number | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hc_sync_state
       (device_id, record_type, permission_state, first_ms, last_ms, record_count, last_upload_at, token_age_s, backlog)
     VALUES (?, ?, ?, 1700000000000, 1790000000000, ?, ?, 30, 0)`,
  )
    .bind(
      deviceId,
      recordType,
      columns.permission,
      columns.count ?? 0,
      columns.lastUploadAt ?? null,
    )
    .run();
}

describe("authentication and CSRF", () => {
  it("refuses every route without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/phone/devices"],
      ["POST", "/api/phone/devices"],
      ["PATCH", "/api/phone/devices/x"],
      ["POST", "/api/phone/devices/x/rotate"],
      ["POST", "/api/phone/devices/x/revoke"],
      ["POST", "/api/phone/devices/x/wipe"],
      ["GET", "/api/phone/devices/x/coverage"],
      ["GET", "/api/phone/devices/x/ingest-log"],
    ] as const) {
      const response = await call(path, {
        method,
        headers: { origin: ORIGIN, ...CSRF, "content-type": "application/json" },
      });

      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects a mutation with no x-healthy-csrf header, and writes nothing", async () => {
    const response = await call("/api/phone/devices", {
      method: "POST",
      headers: { cookie: owner().cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Example phone" }),
    });

    expect(response.status).toBe(403);
    expect(await json<DeviceDto[]>(await owner().get("/api/phone/devices"))).toStrictEqual([]);
  });
});

describe("GET /api/phone/devices", () => {
  it("is empty before anything is paired, and never cached", async () => {
    const response = await owner().get("/api/phone/devices");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json<DeviceDto[]>(response)).toStrictEqual([]);
  });

  it("lists a freshly paired phone as never uploaded, with nothing queued or stored", async () => {
    const { device } = await pair();

    const [listed] = await json<DeviceDto[]>(await owner().get("/api/phone/devices"));

    expect(listed).toStrictEqual({
      id: device.id,
      name: "Example phone",
      status: "never",
      createdAt: expect.any(String),
      rotatedAt: null,
      revokedAt: null,
      lastSeenAt: null,
      lastUploadAt: null,
      appVersion: null,
      queue: { batches: 0, bytes: 0 },
      parked: { batches: 0, bytes: 0, errorCodes: [] },
      parkedMarks: 0,
      report: null,
      totals: { recordCount: 0, typesGranted: 0, typesDenied: 0 },
    });
  });

  it("shows an uploading phone as active, with its queue, report and totals", async () => {
    const { device, token } = await pair();
    const ingested = await ingest(device.id, token);
    expect(ingested.status).toBe(200);
    // What the phone reported, as the apply step would have stored it.
    await testRepos().devices.recordUpload(device.id, {
      appVersion: "0.1.7",
      syncStateJson: JSON.stringify({
        types: [],
        batteryExempt: true,
        backgroundRead: false,
        historyRead: true,
        backfillComplete: false,
        exerciseRoutes: "denied",
        lastError: { errorCode: "hc_rate_limited", at: 1_790_000_000_000 },
      }),
    });
    await seedSyncState(device.id, "HeartRate", { permission: "granted", count: 7 });
    await seedSyncState(device.id, "Steps", { permission: "granted", count: 3 });
    await seedSyncState(device.id, "Weight", { permission: "denied" });

    const [listed] = await json<DeviceDto[]>(await owner().get("/api/phone/devices"));

    expect(listed?.status).toBe("active");
    expect(listed?.appVersion).toBe("0.1.7");
    expect(listed?.lastUploadAt).not.toBeNull();
    expect(listed?.lastSeenAt).not.toBeNull();
    expect(listed?.totals).toStrictEqual({ recordCount: 10, typesGranted: 2, typesDenied: 1 });
    expect(listed?.report).toStrictEqual({
      batteryExempt: true,
      backgroundRead: false,
      historyRead: true,
      backfillComplete: false,
      exerciseRoutes: "denied",
      lastErrorCode: "hc_rate_limited",
      lastErrorAt: "2026-09-21T14:13:20.000Z",
    });
    // The empty batch was queued, and the runner has not applied it in this test.
    expect(listed?.queue.batches).toBe(1);
    expect(listed?.queue.bytes).toBeGreaterThan(0);
  });

  it("calls a phone stale once its last upload is more than six hours old", async () => {
    const { device } = await pair();
    const now = Math.floor(Date.now() / 1000);
    const setUpload = (age: number) =>
      env.DB.prepare("UPDATE devices SET last_upload_at = ? WHERE id = ?")
        .bind(now - age, device.id)
        .run();

    await setUpload(6 * 3600 - 30);
    expect(await firstDeviceStatus()).toBe("active");
    await setUpload(6 * 3600 + 30);
    expect(await firstDeviceStatus()).toBe("stale");
  });

  it("ignores a sync report it cannot read instead of failing the page", async () => {
    const { device } = await pair();
    await testRepos().devices.recordUpload(device.id, {
      appVersion: null,
      syncStateJson: '{"batteryExempt":"maybe"}',
    });

    const response = await owner().get("/api/phone/devices");
    const devices = await json<DeviceDto[]>(response);

    expect(response.status).toBe(200);
    expect(devices[0]?.report).toBeNull();
  });
});

describe("POST /api/phone/devices", () => {
  it("mints a device and returns the token and the QR text once", async () => {
    const response = await owner().send("POST", "/api/phone/devices", { name: "  Example phone " });
    const raw = await json<PairedDeviceDto>(response);
    const paired = withToken(raw);

    expect(response.status).toBe(201);
    expect(Object.keys(raw)).toHaveLength(2);
    expect(raw).not.toHaveProperty("token");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(paired.device.name).toBe("Example phone");
    expect(paired.device.status).toBe("never");
    expect(paired.token).toMatch(/^hcd1\.[0-9A-Z]{26}\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(paired.pairing)).toStrictEqual({
      v: 1,
      url: ORIGIN,
      deviceId: paired.device.id,
      token: paired.token,
    });
  });

  it("never shows the token again", async () => {
    const paired = await pair();

    const listed = await bodyText("/api/phone/devices");
    const coverage = await bodyText(`/api/phone/devices/${paired.device.id}/coverage`);
    const log = await bodyText(`/api/phone/devices/${paired.device.id}/ingest-log`);

    for (const text of [listed, coverage, log]) {
      expect(text).not.toContain(paired.token);
      expect(text).not.toContain(paired.token.split(".", 3)[2]);
    }
  });

  it("stores only a digest of the token, and seals the name", async () => {
    const paired = await pair();

    const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
      .bind(paired.device.id)
      .first<{ name_enc: string; token_hash: string }>();

    expect(row).not.toBeNull();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(paired.token);
    expect(stored).not.toContain(paired.token.split(".", 3)[2]);
    expect(row?.token_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.name_enc).not.toContain("Example phone");
  });

  it("issues a token the ingest route accepts", async () => {
    const { device, token } = await pair();

    const response = await ingest(device.id, token);

    expect(response.status).toBe(200);
    expect(await json<{ accepted: number }>(response)).toMatchObject({ accepted: 0 });
  });

  it("rejects a missing, empty, blank or over-long name, and an unknown key", async () => {
    for (const body of [
      {},
      { name: "" },
      { name: " ".repeat(3) },
      { name: "x".repeat(61) },
      { name: "a", extra: 1 },
    ]) {
      const response = await owner().send("POST", "/api/phone/devices", body);

      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await json<DeviceDto[]>(await owner().get("/api/phone/devices"))).toStrictEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await call("/api/phone/devices", {
      method: "POST",
      headers: {
        cookie: owner().cookie,
        origin: ORIGIN,
        ...CSRF,
        "content-type": "application/json",
      },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/phone/devices/:id", () => {
  it("renames a phone", async () => {
    const { device } = await pair();

    const response = await owner().send("PATCH", `/api/phone/devices/${device.id}`, {
      name: "Renamed phone",
    });

    const renamed = await json<DeviceDto>(response);
    const devices = await listDevices();

    expect(response.status).toBe(200);
    expect(renamed.name).toBe("Renamed phone");
    expect(devices[0]?.name).toBe("Renamed phone");
  });

  it("is a 404 for a phone that does not exist and a 400 for a bad name", async () => {
    const { device } = await pair();

    expect(await sendStatus("PATCH", "/api/phone/devices/nope", { name: "x" })).toBe(404);
    expect(await sendStatus("PATCH", `/api/phone/devices/${device.id}`, { name: "" })).toBe(400);
  });
});

describe("POST /api/phone/devices/:id/rotate", () => {
  it("returns a new token once, and the old one stops working at the ingest route", async () => {
    const { device, token: oldToken } = await pair();
    expect(await ingestStatus(device.id, oldToken)).toBe(200);

    const response = await owner().send("POST", `/api/phone/devices/${device.id}/rotate`);
    const rotatedRaw = await json<PairedDeviceDto>(response);
    const rotated = withToken(rotatedRaw);
    expect(rotatedRaw).not.toHaveProperty("token");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rotated.token).not.toBe(oldToken);
    expect(rotated.device.rotatedAt).not.toBeNull();
    expect(JSON.parse(rotated.pairing)).toMatchObject({
      deviceId: device.id,
      token: rotated.token,
    });
    expect(await ingestStatus(device.id, oldToken)).toBe(401);
    expect(await ingestStatus(device.id, rotated.token)).toBe(200);
  });

  it("is a 404 for an unknown phone and a 409 for a revoked one", async () => {
    const { device } = await pair();
    await owner().send("POST", `/api/phone/devices/${device.id}/revoke`);

    expect(await sendStatus("POST", "/api/phone/devices/nope/rotate")).toBe(404);
    const revoked = await owner().send("POST", `/api/phone/devices/${device.id}/rotate`);
    expect(revoked.status).toBe(409);
    expect(JSON.stringify(await json<ApiError>(revoked))).not.toContain("hcd1.");
  });
});

describe("POST /api/phone/devices/:id/revoke", () => {
  it("makes the ingest route answer 401 and keeps the data", async () => {
    const { device, token } = await pair();
    await seedSyncState(device.id, "Steps", { permission: "granted", count: 3 });
    expect(await ingestStatus(device.id, token)).toBe(200);

    const response = await owner().send("POST", `/api/phone/devices/${device.id}/revoke`);
    const revoked = await json<DeviceDto>(response);

    expect(response.status).toBe(200);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.totals.recordCount).toBe(3);
    expect(await ingestStatus(device.id, token)).toBe(401);
  });

  it("is idempotent and a 404 for an unknown phone", async () => {
    const { device } = await pair();

    expect(await sendStatus("POST", `/api/phone/devices/${device.id}/revoke`)).toBe(200);
    expect(await sendStatus("POST", `/api/phone/devices/${device.id}/revoke`)).toBe(200);
    expect(await sendStatus("POST", "/api/phone/devices/nope/revoke")).toBe(404);
  });
});

async function parkOne(): Promise<{ id: string }> {
  const { device, token } = await pair();
  expect(await ingestStatus(device.id, token)).toBe(200);
  await env.DB.prepare("UPDATE hc_ingest_queue SET parked_at = 1790000000 WHERE device_id = ?")
    .bind(device.id)
    .run();
  await env.DB.prepare(
    "UPDATE hc_ingest_log SET status = 'failed', error_code = 'apply_failed' WHERE device_id = ?",
  )
    .bind(device.id)
    .run();
  return device;
}

describe("parked uploads", () => {
  it("shows parked batches and their error codes, and not as queue depth", async () => {
    await parkOne();

    const [listed] = await listDevices();

    expect(listed?.queue.batches).toBe(0);
    expect(listed?.parked.batches).toBe(1);
    expect(listed?.parked.bytes).toBeGreaterThan(0);
    expect(listed?.parked.errorCodes).toStrictEqual(["apply_failed"]);
  });

  it("puts them back in the queue on retry-failed", async () => {
    const device = await parkOne();

    const response = await owner().send("POST", `/api/phone/devices/${device.id}/retry-failed`);

    expect(response.status).toBe(200);
    expect(await json<{ requeued: number }>(response)).toStrictEqual({ requeued: 1, remarked: 0 });
    const [listed] = await listDevices();
    expect(listed?.parked.batches).toBe(0);
    expect(listed?.queue.batches).toBe(1);
    const again = await owner().send("POST", `/api/phone/devices/${device.id}/retry-failed`);
    expect(await json<{ requeued: number }>(again)).toStrictEqual({ requeued: 0, remarked: 0 });
  });

  it("shows parked rebuild marks and puts them back on retry-failed", async () => {
    const { device } = await pair();
    await env.DB.prepare(
      "INSERT INTO hc_dirty (device_id, kind, key, marked_at) VALUES (?, 'parked:day', '2026-01-01', 1)",
    )
      .bind(device.id)
      .run();

    const before = await listDevices();
    expect(before[0]?.parkedMarks).toBe(1);
    const response = await owner().send("POST", `/api/phone/devices/${device.id}/retry-failed`);

    expect(await json<{ requeued: number; remarked: number }>(response)).toStrictEqual({
      requeued: 0,
      remarked: 1,
    });
    const after = await listDevices();
    expect(after[0]?.parkedMarks).toBe(0);
  });

  it("is a 404 for an unknown phone and needs a session", async () => {
    expect(await sendStatus("POST", "/api/phone/devices/nope/retry-failed")).toBe(404);
    const anonymous = await call("/api/phone/devices/x/retry-failed", {
      method: "POST",
      headers: { origin: ORIGIN, ...CSRF },
    });
    expect(anonymous.status).toBe(401);
  });
});

describe("hostile stored values", () => {
  it("still renders a phone whose sync report carries an impossible instant", async () => {
    const { device } = await pair();
    await testRepos().devices.recordUpload(device.id, {
      appVersion: null,
      syncStateJson: JSON.stringify({
        types: [],
        lastError: { errorCode: "x", at: Number.MAX_SAFE_INTEGER },
      }),
    });

    const response = await owner().get("/api/phone/devices");
    const [listed] = await json<DeviceDto[]>(response);

    expect(response.status).toBe(200);
    expect(listed?.report?.lastErrorAt).toBeNull();
  });

  it("still renders coverage whose stored instants are out of range", async () => {
    const { device } = await pair();
    await env.DB.prepare(
      "INSERT INTO hc_sync_state (device_id, record_type, permission_state, first_ms, last_ms, record_count) VALUES (?, 'Steps', 'granted', 9007199254740991, -9007199254740991, 1)",
    )
      .bind(device.id)
      .run();

    const response = await owner().get(`/api/phone/devices/${device.id}/coverage`);
    const [row] = await json<DeviceCoverageRowDto[]>(response);

    expect(response.status).toBe(200);
    expect(row?.firstAt).toBeNull();
    expect(row?.lastAt).toBeNull();
  });

  it("reads a revoked phone that never uploaded as revoked", async () => {
    const { device } = await pair();
    await owner().send("POST", `/api/phone/devices/${device.id}/revoke`);

    const [listed] = await listDevices();

    expect(listed?.status).toBe("revoked");
  });
});

describe("POST /api/phone/devices/:id/wipe", () => {
  it("refuses without the device id as confirmation, and deletes nothing", async () => {
    const { device } = await pair();

    for (const body of [{}, { confirm: "Example phone" }, { confirm: "wrong" }]) {
      const response = await owner().send("POST", `/api/phone/devices/${device.id}/wipe`, body);

      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await json<DeviceDto[]>(await owner().get("/api/phone/devices"))).toHaveLength(1);
  });

  it("is a 404 for an unknown phone", async () => {
    expect(await sendStatus("POST", "/api/phone/devices/nope/wipe", { confirm: "nope" })).toBe(404);
  });

  it("deletes the phone and its data once the id is confirmed", async () => {
    const { device } = await pair();
    await seedSyncState(device.id, "Steps", { permission: "granted", count: 3 });
    let done = false;

    for (let call_ = 0; !done && call_ < 20; call_++) {
      const response = await owner().send("POST", `/api/phone/devices/${device.id}/wipe`, {
        confirm: device.id,
      });
      expect(response.status).toBe(200);
      ({ done } = await json<WipeDeviceResponse>(response));
    }

    expect(done).toBe(true);
    expect(await json<DeviceDto[]>(await owner().get("/api/phone/devices"))).toStrictEqual([]);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM hc_sync_state").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });
});

describe("GET /api/phone/devices/:id/coverage", () => {
  it("is empty for a phone that has reported nothing", async () => {
    const { device } = await pair();

    const response = await owner().get(`/api/phone/devices/${device.id}/coverage`);

    expect(response.status).toBe(200);
    expect(await json<DeviceCoverageRowDto[]>(response)).toStrictEqual([]);
  });

  it("reports each type with its permission, counts and coverage status", async () => {
    const { device, token } = await pair();
    expect(await ingestStatus(device.id, token)).toBe(200);
    const recentUpload = Math.floor(Date.now() / 1000) - 60;
    await env.DB.prepare("UPDATE devices SET last_upload_at = ? WHERE id = ?")
      .bind(recentUpload, device.id)
      .run();
    await seedSyncState(device.id, "HeartRate", {
      permission: "granted",
      count: 9,
      lastUploadAt: recentUpload,
    });
    await seedSyncState(device.id, "Sleep", {
      permission: "granted",
      count: 0,
      lastUploadAt: recentUpload,
    });
    await seedSyncState(device.id, "Weight", { permission: "denied" });
    await seedSyncState(device.id, "Vo2Max", { permission: "unavailable" });

    const rows = await json<DeviceCoverageRowDto[]>(
      await owner().get(`/api/phone/devices/${device.id}/coverage`),
    );
    const byType = new Map(rows.map((row) => [row.recordType, row]));

    expect(byType.get("HeartRate")).toMatchObject({
      permission: "granted",
      recordCount: 9,
      status: "ok",
      firstAt: "2023-11-14T22:13:20.000Z",
      lastAt: "2026-09-21T14:13:20.000Z",
      tokenAgeS: 30,
      backlog: 0,
      backfillComplete: false,
      notice: null,
    });
    expect(byType.get("Sleep")).toMatchObject({ recordCount: 0, status: "ok" });
    expect(byType.get("Weight")?.status).toBe("unsupported");
    expect(byType.get("Weight")?.notice).toContain("not permitted");
    expect(byType.get("Vo2Max")?.status).toBe("unsupported");
    expect(byType.get("Vo2Max")?.notice).toContain("not available on this phone");
  });

  it("calls every type stale once the phone has been silent for over six hours", async () => {
    const { device } = await pair();
    const old = Math.floor(Date.now() / 1000) - 7 * 3600;
    await env.DB.prepare("UPDATE devices SET last_upload_at = ? WHERE id = ?")
      .bind(old, device.id)
      .run();
    await seedSyncState(device.id, "HeartRate", {
      permission: "granted",
      count: 9,
      lastUploadAt: old,
    });

    const [row] = await json<DeviceCoverageRowDto[]>(
      await owner().get(`/api/phone/devices/${device.id}/coverage`),
    );

    expect(row).toMatchObject({ status: "stale", ageHours: 7 });
  });

  it("leaves the platform's own hourly totals out of the table and out of the type totals", async () => {
    const { device } = await pair();
    await seedSyncState(device.id, "Steps", { permission: "granted", count: 3 });
    await seedSyncState(device.id, "Agg.Steps", { permission: "unknown", count: 24 });

    const rows = await json<DeviceCoverageRowDto[]>(
      await owner().get(`/api/phone/devices/${device.id}/coverage`),
    );
    const devices = await json<DeviceDto[]>(await owner().get("/api/phone/devices"));
    const listed = devices.find((entry) => entry.id === device.id);

    expect(rows.map((row) => row.recordType)).toStrictEqual(["Steps"]);
    expect(listed?.totals).toMatchObject({ typesGranted: 1, typesDenied: 0 });
  });

  it("is a 404 for an unknown phone", async () => {
    expect(await getStatus("/api/phone/devices/nope/coverage")).toBe(404);
  });
});

describe("GET /api/phone/devices/:id/ingest-log", () => {
  it("lists recent batches, newest first, as counts and codes only", async () => {
    const { device, token } = await pair();
    for (let i = 0; i < 3; i++) expect(await ingestStatus(device.id, token)).toBe(200);
    // No runner is bound in these tests (see `TEST_ENV` in helpers.ts), so the
    // rows are as the route left them; pinning them keeps what is asserted
    // below explicit all the same.
    await env.DB.prepare(
      "UPDATE hc_ingest_log SET status = 'queued', error_code = NULL, applied_at = NULL, apply_ms = NULL",
    ).run();
    await env.DB.prepare(
      "UPDATE hc_ingest_log SET status = 'failed', error_code = 'apply_failed', apply_ms = 12 WHERE rowid = (SELECT max(rowid) FROM hc_ingest_log)",
    ).run();

    const response = await owner().get(`/api/phone/devices/${device.id}/ingest-log`);
    const rows = await json<DeviceIngestLogDto[]>(response);

    expect(response.status).toBe(200);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ status: "failed", errorCode: "apply_failed", applyMs: 12 });
    expect(rows[1]).toMatchObject({ status: "queued", errorCode: null, upserts: 0, deletes: 0 });
    // Counts, sizes and a code: nothing else is in a row.
    expect(rows[0]).toStrictEqual({
      receivedAt: expect.any(String),
      appliedAt: null,
      status: "failed",
      errorCode: "apply_failed",
      upserts: 0,
      deletes: 0,
      rejected: 0,
      applied: 0,
      superseded: 0,
      removed: 0,
      bodyBytes: expect.any(Number),
      rawBytes: expect.any(Number),
      applyMs: 12,
    });
  });

  it("applies ?limit= and rejects one out of range", async () => {
    const { device, token } = await pair();
    for (let i = 0; i < 3; i++) expect(await ingestStatus(device.id, token)).toBe(200);

    const limited = await json<DeviceIngestLogDto[]>(
      await owner().get(`/api/phone/devices/${device.id}/ingest-log?limit=2`),
    );

    expect(limited).toHaveLength(2);
    expect(await getStatus(`/api/phone/devices/${device.id}/ingest-log?limit=0`)).toBe(400);
    expect(await getStatus("/api/phone/devices/nope/ingest-log")).toBe(404);
  });
});
