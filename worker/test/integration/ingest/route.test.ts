// `POST /ingest/health-connect` end to end, in real workerd against real D1:
// bearer check -> rate limit -> bounded body -> validation -> sealed queue.
//
// This route sits above the owner gate, so what it refuses matters more than
// what it accepts. Every refusal is asserted to be the route's own JSON answer
// and never the login page or a redirect, because "falls through to the gate"
// is exactly the failure this file exists to catch.
//
// Every record below is synthetic, per CLAUDE.md: invented values, RFC 2606
// style package names, no real device.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../../../src/app.ts";
import { STALE_HOURS_PER_ANSWER } from "../../../src/hc/store/platform-stale.ts";
import { MAX_BATCH_RECORDS, MAX_EPOCH_MS } from "../../../src/hc/wire.ts";
import {
  INGEST_PATH,
  INGEST_RATE_LIMIT,
  INGEST_RATE_WINDOW_SECONDS,
  MAX_QUEUED_BATCHES,
  MAX_REPORTED_REJECTIONS,
} from "../../../src/ingest/route.ts";
import { resetDb, testRepos } from "../db/helpers.ts";

import type { Env } from "../../../src/env.ts";

const ORIGIN = "https://healthy.example";

function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

const DATA_KEY = randomDataKey();
// DEV_MODE stays "false": the point is that this route answers on its own, with
// Cloudflare Access notionally in front of everything else.
//
// No runner binding either. These tests assert on what the route queued, and a
// live runner would be draining that queue from its alarm while they look; the
// route treats a failed wake as harmless (`worker/src/hc/kick.ts`), which is
// itself part of what this file proves. The runner has its own tests.
const TEST_ENV = { ...env, DATA_KEY, DEV_MODE: "false", HC_INGEST: undefined } as unknown as Env;

// Repos are closures over a context, not connections, so one set serves every test.
const repos = testRepos({ dataKey: DATA_KEY });

beforeEach(resetDb);

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function gunzipText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function send(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, TEST_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface PostOptions {
  token?: string | null;
  headers?: Record<string, string>;
  /** Sent as is, in place of the gzipped JSON of the first argument. */
  body?: BodyInit;
}

async function post(json: unknown, options: PostOptions = {}): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "content-encoding": "gzip",
    ...options.headers,
  });
  if (typeof options.token === "string") headers.set("authorization", `Bearer ${options.token}`);
  const body = options.body ?? (await gzip(JSON.stringify(json)));
  return send(new Request(ORIGIN + INGEST_PATH, { method: "POST", headers, body }));
}

/** What a refusal looked like: enough to tell the route's own answer from the gate's. */
interface Refusal {
  status: number;
  json: boolean;
  redirected: boolean;
  cacheControl: string | null;
  body: unknown;
}

async function refusalOf(response: Response): Promise<Refusal> {
  const json = (response.headers.get("content-type") ?? "").includes("application/json");
  return {
    status: response.status,
    json,
    redirected: response.headers.has("location"),
    cacheControl: response.headers.get("cache-control"),
    body: json ? await response.json() : await response.text(),
  };
}

function refusal(status: number, error: string): Refusal {
  return { status, json: true, redirected: false, cacheControl: "no-store", body: { error } };
}

const UNAUTHORIZED = refusal(401, "unauthorized");
const BAD_REQUEST = refusal(400, "bad_request");

const T = 1_790_000_000_000;

function stepsRecord(id: string, startMs = T): Record<string, unknown> {
  return {
    id,
    type: "Steps",
    origin: "com.example.wearable",
    device: { type: "WATCH", manufacturer: "Example", model: "Band 1" },
    recordingMethod: "AUTOMATICALLY_RECORDED",
    lastModified: startMs + 90_000,
    start: startMs,
    end: startMs + 60_000,
    startOffsetMin: -300,
    endOffsetMin: -300,
    data: { count: 42 },
  };
}

function batch(deviceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    deviceId,
    appVersion: "0.1.7",
    batchId: crypto.randomUUID(),
    phoneTime: T,
    upserts: [stepsRecord("rec-1"), stepsRecord("rec-2", T + 60_000)],
    deletes: ["rec-0"],
    ...overrides,
  };
}

/** The random half of a token. */
function secretOf(token: string): string {
  return token.slice(token.lastIndexOf(".") + 1);
}

async function queuedBatches(deviceId: string): Promise<number> {
  const depth = await repos.hcIngestQueue.depth(deviceId);
  return depth.batches;
}

async function tableDump(table: "devices" | "hc_ingest_queue"): Promise<string> {
  const statement =
    table === "devices"
      ? env.DB.prepare("SELECT * FROM devices")
      : env.DB.prepare("SELECT * FROM hc_ingest_queue");
  const { results } = await statement.all();
  return JSON.stringify(results);
}

describe("authentication", () => {
  it("answers 401 JSON, not the gate's login page, with no token", async () => {
    const response = await post(batch("x"), { token: null });

    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(refusalOf(response)).resolves.toStrictEqual(UNAUTHORIZED);
  });

  it("answers the same 401 for a malformed, an unknown and a wrong token", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const other = await repos.devices.mint("Other phone");

    for (const candidate of [
      "not-a-token",
      "hcd1.short.secret",
      // A well-formed token for a device that does not exist.
      `hcd1.01ARZ3NDEKTSV4RRFFQ69G5FAV.${secretOf(token)}`,
      // Another device's real secret, presented under this device's id.
      `hcd1.${device.id}.${secretOf(other.token)}`,
      `${token}x`,
    ]) {
      const response = await post(batch(device.id), { token: candidate });
      await expect(refusalOf(response), candidate).resolves.toStrictEqual(UNAUTHORIZED);
    }
    await expect(queuedBatches(device.id)).resolves.toBe(0);
  });

  it("refuses a revoked device and a rotated-away token", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const rotated = await repos.devices.rotate(device.id);
    const current = rotated?.token ?? "";

    const withOld = await post(batch(device.id), { token });
    const withNew = await post(batch(device.id), { token: current });
    await repos.devices.revoke(device.id);
    const afterRevoke = await post(batch(device.id), { token: current });

    await expect(refusalOf(withOld)).resolves.toStrictEqual(UNAUTHORIZED);
    expect(withNew.status).toBe(200);
    await expect(refusalOf(afterRevoke)).resolves.toStrictEqual(UNAUTHORIZED);
  });

  it("stores a digest and never the token or the phone's name", async () => {
    const { token } = await repos.devices.mint("Test phone");

    const dump = await tableDump("devices");

    expect(secretOf(token)).toHaveLength(43);
    expect(dump).not.toContain(secretOf(token));
    expect(dump).not.toContain("Test phone");
  });

  it("answers 405 to other methods without reaching the gate", async () => {
    const response = await send(new Request(ORIGIN + INGEST_PATH));

    expect(response.headers.get("allow")).toBe("POST");
    await expect(refusalOf(response)).resolves.toStrictEqual(refusal(405, "method_not_allowed"));
  });

  it("does not open any other path: a neighbour still meets the gate", async () => {
    const { token } = await repos.devices.mint("Test phone");

    const response = await send(
      new Request(`${ORIGIN}/api/phone/devices`, { headers: { authorization: `Bearer ${token}` } }),
    );

    expect(response.status).toBe(403);
  });

  // Cloudflare Access lets through more than the route serves: its bypass entry
  // covers the path and everything beneath it, case-insensitively. What keeps
  // that one route wide is this fall-through, so it is pinned: a valid token on
  // anything but the exact path meets the owner gate and queues nothing.
  it.each([
    ["a trailing slash", `${INGEST_PATH}/`],
    ["a sub-path", `${INGEST_PATH}/x`],
    ["a deeper sub-path", `${INGEST_PATH}/x/y`],
    ["another casing", INGEST_PATH.toUpperCase()],
  ])("refuses %s at the owner gate, even with a valid token", async (_name, path) => {
    const { device, token } = await repos.devices.mint("Test phone");
    const body = await gzip(JSON.stringify(batch(device.id)));

    const response = await send(
      new Request(ORIGIN + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
      }),
    );

    expect(response.status).toBe(403);
    await expect(queuedBatches(device.id)).resolves.toBe(0);
  });
});

describe("a valid batch", () => {
  it("is queued sealed and acknowledged with its counts", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const body = batch(device.id);

    const response = await post(body, { token });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: 2,
      deleted: 1,
      rejected: [],
      duplicate: false,
    });
    await expect(queuedBatches(device.id)).resolves.toBe(1);

    // Nothing of the batch is readable in the queue table.
    const stored = await tableDump("hc_ingest_queue");
    expect(stored).not.toContain("com.example.wearable");
    expect(stored).not.toContain("rec-1");

    // And what the runner will read back is the body as it was sent.
    const head = await repos.hcIngestQueue.head(device.id);
    const text = await gunzipText(head?.body ?? new Uint8Array());
    expect(JSON.parse(text)).toStrictEqual(body);
  });

  it("acknowledges a replayed batch id without queueing it twice", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const body = batch(device.id);

    await post(body, { token });
    const replay = await post(body, { token });

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ accepted: 2, duplicate: true });
    await expect(queuedBatches(device.id)).resolves.toBe(1);
  });

  it("rejects a bad record by id and keeps the rest", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const noTimes = { ...stepsRecord("rec-bad"), start: undefined, end: undefined };
    const backwards = { ...stepsRecord("rec-backwards"), end: T - 1 };

    const response = await post(
      batch(device.id, { upserts: [stepsRecord("rec-ok"), noTimes, backwards, 7], deletes: [""] }),
      { token },
    );

    await expect(response.json()).resolves.toMatchObject({
      accepted: 1,
      deleted: 0,
      rejected: [
        { id: "rec-bad", errorCode: "invalid_record" },
        { id: "rec-backwards", errorCode: "invalid_record" },
        { id: "upserts[3]", errorCode: "invalid_record" },
        { id: "deletes[0]", errorCode: "invalid_id" },
      ],
    });
  });

  it("keeps a record type this Worker has never heard of", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const novel = { ...stepsRecord("rec-new"), type: "SomeFutureRecordType", data: { x: [1, 2] } };

    const response = await post(batch(device.id, { upserts: [novel], deletes: [] }), { token });

    await expect(response.json()).resolves.toMatchObject({ accepted: 1, rejected: [] });
  });

  it("records the upload and the phone's sync report, sealed", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const syncState = {
      types: [{ type: "Steps", permission: "granted", tokenAgeS: 12, backlog: 0 }],
      batteryExempt: true,
    };

    await post(batch(device.id, { syncState }), { token });

    const after = await repos.devices.get(device.id);
    const reported = await repos.devices.syncStateJson(device.id);
    expect(after?.lastUploadAt).not.toBeNull();
    expect(after?.appVersion).toBe("0.1.7");
    expect(JSON.parse(reported ?? "null")).toStrictEqual(syncState);
    await expect(tableDump("devices")).resolves.not.toContain("batteryExempt");
  });
});

describe("what it refuses after authenticating", () => {
  it("refuses a batch that names another device", async () => {
    const { token } = await repos.devices.mint("Test phone");
    const other = await repos.devices.mint("Other phone");

    const response = await post(batch(other.device.id), { token });

    await expect(refusalOf(response)).resolves.toStrictEqual(BAD_REQUEST);
    await expect(queuedBatches(other.device.id)).resolves.toBe(0);
  });

  it("refuses a wrong envelope whole", async () => {
    const { device, token } = await repos.devices.mint("Test phone");

    for (const body of [
      batch(device.id, { v: 2 }),
      batch(device.id, { batchId: "no spaces allowed" }),
      batch(device.id, { upserts: "nope" }),
      [],
      null,
    ]) {
      const response = await post(body, { token });
      await expect(refusalOf(response)).resolves.toStrictEqual(BAD_REQUEST);
    }
    await expect(queuedBatches(device.id)).resolves.toBe(0);
  });

  it("refuses a body that is not gzip, or not JSON", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const notJson = await gzip("{not json");

    const plain = await post(null, { token, body: JSON.stringify(batch(device.id)) });
    const garbled = await post(null, { token, body: notJson });

    await expect(refusalOf(plain)).resolves.toStrictEqual(BAD_REQUEST);
    await expect(refusalOf(garbled)).resolves.toStrictEqual(BAD_REQUEST);
  });

  it("refuses a body that does not declare gzip JSON", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const unsupported = refusal(415, "unsupported_media_type");

    const identity = await post(batch(device.id), {
      token,
      headers: { "content-encoding": "identity" },
    });
    const text = await post(batch(device.id), { token, headers: { "content-type": "text/plain" } });

    await expect(refusalOf(identity)).resolves.toStrictEqual(unsupported);
    await expect(refusalOf(text)).resolves.toStrictEqual(unsupported);
  });

  it("refuses a small body that expands past the limit", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    // About 40 MiB of one repeated character: a few tens of kilobytes compressed.
    const bomb = await gzip(" ".repeat(40 * 1024 * 1024));

    const response = await post(null, { token, body: bomb });

    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(refusalOf(response)).resolves.toStrictEqual(refusal(413, "payload_too_large"));
    await expect(queuedBatches(device.id)).resolves.toBe(0);
  });

  it("refuses a batch id reused for different content, and takes nothing from it", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const first = batch(device.id);
    const other = { ...first, upserts: [stepsRecord("rec-other")] };

    await post(first, { token });
    const response = await post(other, { token });

    await expect(refusalOf(response)).resolves.toStrictEqual(refusal(409, "batch_id_conflict"));
    await expect(queuedBatches(device.id)).resolves.toBe(1);
  });

  it("refuses a batch of more records than one may carry, so the phone splits it", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    // Not records at all: the limit is on the array lengths, before validation.
    const upserts = Array.from({ length: MAX_BATCH_RECORDS }, () => 0);

    const response = await post(batch(device.id, { upserts, deletes: ["one-more"] }), { token });

    await expect(refusalOf(response)).resolves.toStrictEqual(refusal(413, "payload_too_large"));
    await expect(queuedBatches(device.id)).resolves.toBe(0);
  });

  it("lists only the first rejections and counts them all", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const upserts = Array.from({ length: MAX_REPORTED_REJECTIONS + 50 }, () => 0);

    const response = await post(batch(device.id, { upserts, deletes: [] }), { token });
    const body = await response.json<{ rejected: unknown[]; rejectedTotal: number }>();

    expect(body.rejected).toHaveLength(MAX_REPORTED_REJECTIONS);
    expect(body.rejectedTotal).toBe(MAX_REPORTED_REJECTIONS + 50);
  });

  it("rejects a record whose instant is not a time, and a report that carries one", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const beyond = MAX_EPOCH_MS + 1;
    const record = { ...stepsRecord("rec-far"), start: beyond, end: beyond + 1 };
    const report = { types: [], lastError: { errorCode: "x", at: beyond } };

    const withRecord = await post(batch(device.id, { upserts: [record], deletes: [] }), { token });
    const withReport = await post(batch(device.id, { syncState: report }), { token });

    await expect(withRecord.json()).resolves.toMatchObject({
      accepted: 0,
      rejected: [{ id: "rec-far", errorCode: "invalid_record" }],
    });
    await expect(refusalOf(withReport)).resolves.toStrictEqual(BAD_REQUEST);
  });

  it("tells a device with a deep queue to come back, before reading its body", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const statements = Array.from({ length: MAX_QUEUED_BATCHES + 1 }, (_unused, index) =>
      env.DB.prepare(
        `INSERT INTO hc_ingest_queue (device_id, batch_id, part, parts, body_enc, body_bytes, received_at)
         VALUES (?, ?, 0, 1, 'x', 1, 0)`,
      ).bind(device.id, `filler-${String(index)}`),
    );
    await env.DB.batch(statements);

    // A body that would be refused on its own merits: proof it was never read.
    const response = await post(null, { token, body: "not gzip" });

    expect(response.headers.get("retry-after")).not.toBeNull();
    await expect(refusalOf(response)).resolves.toStrictEqual(refusal(429, "backlogged"));
  });

  it("limits requests per device per window", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    // Spend the window directly rather than with a hundred real requests.
    // `unixepoch()`, not the repos' fixed test clock: the route reads the real one.
    await env.DB.prepare(
      "UPDATE devices SET rate_window_start = unixepoch(), rate_window_count = ? WHERE id = ?",
    )
      .bind(INGEST_RATE_LIMIT, device.id)
      .run();

    const response = await post(batch(device.id), { token });

    expect(response.headers.get("retry-after")).toBe(String(INGEST_RATE_WINDOW_SECONDS));
    await expect(refusalOf(response)).resolves.toStrictEqual(refusal(429, "rate_limited"));
  });
});

/** Mark hours of a device's platform totals stale, as an applied batch would have. */
async function markStale(deviceId: string, type: string, hours: number[]): Promise<void> {
  await env.DB.batch(
    hours.map((at) =>
      env.DB.prepare(
        `INSERT INTO hc_platform_stale (device_id, record_type, hour_utc, marked_seq, marked_at)
         VALUES (?, ?, ?, 1, 0)`,
      ).bind(deviceId, type, at),
    ),
  );
}

describe("the stale platform totals in the answer", () => {
  const HOUR = 3_600_000;
  const hour = Math.floor(T / HOUR) - 24 * 30;

  function total(hourUtc: number): Record<string, unknown> {
    return {
      id: `agg:Steps:${String(hourUtc * HOUR)}`,
      type: "Agg.Steps",
      origin: "healthconnect",
      lastModified: T,
      start: hourUtc * HOUR,
      end: (hourUtc + 1) * HOUR,
      data: { value: 12, unit: "count", origins: ["com.example.wearable"] },
    };
  }

  it("names the device's own stale hours, as hour starts, less the ones this batch carries", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const other = await repos.devices.mint("Other phone");
    await markStale(device.id, "Steps", [hour, hour + 1, hour + 2]);
    await markStale(device.id, "Distance", [hour + 5]);
    await markStale(other.device.id, "Steps", [hour + 9]);

    // The phone's repair of two of them: a total, and the deletion of one.
    const response = await post(
      batch(device.id, {
        upserts: [total(hour)],
        deletes: [`agg:Steps:${String((hour + 2) * HOUR)}`],
      }),
      { token },
    );

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body.staleHours).toStrictEqual({
      Distance: [(hour + 5) * HOUR],
      Steps: [(hour + 1) * HOUR],
    });
  });

  it("says nothing while another batch of the device waits to be applied, and none is an empty list", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    // Nothing stale, nothing queued: the answer says so.
    const first = await post(batch(device.id), { token });
    await expect(first.json()).resolves.toMatchObject({ staleHours: {} });

    // The first batch is still queued (no runner here): it may be the repair.
    await markStale(device.id, "Steps", [hour]);
    const second = await post(batch(device.id), { token });
    expect(second.status).toBe(200);
    const body = await second.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("staleHours");
  });

  it("names no more than a page of one type's hours, the earliest, and every type", async () => {
    const { device, token } = await repos.devices.mint("Test phone");
    const many = Array.from(
      { length: STALE_HOURS_PER_ANSWER + 20 },
      (_unused, index) => hour + index,
    );
    for (let from = 0; from < many.length; from += 90) {
      await markStale(device.id, "Steps", many.slice(from, from + 90));
    }
    await markStale(device.id, "Hydration", [hour]);

    const response = await post(batch(device.id), { token });
    const body = await response.json<{ staleHours: Record<string, number[]> }>();

    expect(body.staleHours.Steps).toStrictEqual(
      many.slice(0, STALE_HOURS_PER_ANSWER).map((at) => at * HOUR),
    );
    expect(body.staleHours.Hydration).toStrictEqual([hour * HOUR]);
    // Nothing is dropped: the rest are still marked for a later answer.
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM hc_platform_stale WHERE device_id = ?",
    )
      .bind(device.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(many.length + 1);
  });
});
