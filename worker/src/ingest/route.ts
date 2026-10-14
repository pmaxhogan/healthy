/**
`POST /ingest/health-connect`: where a paired phone delivers its records.

This is the one machine-facing route in the Hono app, and it sits ABOVE the
owner gate (see `worker/src/app.ts`): the phone has no Cloudflare Access
identity and no password session, so Access is configured to let this path
through and the bearer check below is the whole of its authentication.

Access lets through more than this file serves: its bypass entry covers the
path and everything beneath it, and matches without regard to case. Only the
exact path is registered here, so a sub-path or another casing falls to the
owner gate, which checks the Access identity itself and answers 403. That
fail-closed fall-through is what keeps the opening one route wide -- so
NOTHING may ever be registered beneath this path without its own
authentication: it would be on the internet with no Access in front of it.
Read it as the security boundary it is.

What the route does, in order, and why in that order:

  1. Token shape  -- parsed before any database read, so a request without a
     well-formed token costs nothing but CPU.
  2. Token check  -- one row by primary key, then a constant-time comparison
     of digests. Missing, malformed, unknown, wrong and revoked all answer the
     same 401, so the route is not an oracle for which device ids exist.
  3. Rate limit   -- per device, counted before the body is read; then
     backpressure: a device whose queue is already deep is told to wait,
     again before its body is read.
  4. Size limits  -- on the bytes actually read and actually expanded, never
     on a header (`body.ts`).
  5. Validation   -- the envelope strictly, each record on its own (`wire.ts`).
     The batch's `deviceId` must be the token's, and a batch of more records
     than one may carry is refused whole so the phone splits it.
  6. Queue        -- the body is sealed into `hc_ingest_queue` in one
     transaction, and only then is the batch acknowledged. A batch id seen
     before is acknowledged again only if its content is the same. The log
     row written with it carries which sync run the batch says it is part
     of, so a run can be seen the moment it uploads and not once applied.
  7. Stale totals -- with the batch queued, the answer says which hours of
     the device's platform totals the store knows to be out of date, when it
     can tell (`staleHoursFor`, worker/src/hc/store/platform-stale.ts). The
     only way anything reaches the phone from here: it has no route of its
     own, and must never get one beneath this path (see above).

It does not apply the batch. A month of backfill touches hundreds of stored
rows, which does not fit one request's D1 query budget; the alarm-driven
runner (`worker/src/hc/runner.ts`) does that, in order, afterwards. So
`accepted` in the answer means "validated and durably queued", which is the
promise the phone needs before it commits its changes token.

It adds, and reads back one thing. Nothing here reads a record back: the
one thing the answer carries out of the store is which hours of which record
types of THIS device have a platform total that is out of date (step 7), so
that the phone can work them out again. That is record type names -- the
SDK's class names, the same for every user -- and hours: when the device's
owner had activity of a type, to the hour, and no value, no origin, nothing
else. So a stolen token can push data to its own device and learn those
hours of its own device, and can do nothing else: not read a record or a
total, not touch another device, not reach the admin API or the MCP.

Logging: this app's own device id, counts, sizes, stable error codes and
the code for what started the sync run. Never the token, never a record id, never an origin app's package name.
*/

import { Hono } from "hono";

import { makeCtx } from "../db/client.ts";
import { reposFor } from "../db/index.ts";
import { bearerDeviceToken, verifyDeviceToken } from "../hc/device-token.ts";
import { kickIngestRunner } from "../hc/kick.ts";
import { carriedPlatformHours } from "../hc/platform-totals.ts";
import { staleHoursFor } from "../hc/store/platform-stale.ts";
import { exceedsRecordLimit, parseBatch, runStampOf } from "../hc/wire.ts";
import { errorFields, makeLogger } from "../lib/log.ts";

import { MAX_COMPRESSED_BYTES, MAX_RAW_BYTES, gunzipCapped, readCapped } from "./body.ts";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { Repos } from "../db/index.ts";
import type { HcSyncState, ParsedBatch, Rejection } from "../hc/wire.ts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const INGEST_PATH = "/ingest/health-connect";

/** Requests one device may make per window. A backfill sends a few a minute. */
export const INGEST_RATE_LIMIT = 120;
export const INGEST_RATE_WINDOW_SECONDS = 60;

/** A device with this much already waiting is asked to come back later. */
const MAX_QUEUED_BYTES = 96 * 1024 * 1024;
export const MAX_QUEUED_BATCHES = 400;
const BACKLOG_RETRY_SECONDS = 30;

/**
A digest that is no device's, compared against when the device id is
unknown, so "no such device" and "wrong token" spend the same work.
*/
const NO_DEVICE_HASH = "A".repeat(43);

type IngestErrorCode =
  | "unauthorized"
  | "bad_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "backlogged"
  | "batch_id_conflict"
  | "method_not_allowed";

interface IngestResponse {
  /** Records validated and durably queued. */
  accepted: number;
  /** Deletes validated and durably queued. */
  deleted: number;
  /** The first `MAX_REPORTED_REJECTIONS` of them; `rejectedTotal` is how many there were. */
  rejected: Rejection[];
  rejectedTotal: number;
  /** True when this batch id had already been accepted: nothing was queued again. */
  duplicate: boolean;
  /** Epoch milliseconds. */
  serverTime: number;
  /**
  Hours whose stored platform total is out of date, for the phone to work
  out again: by record type (`Steps`), each hour as the epoch milliseconds
  of its start. Present only when the store can say -- nothing else of the
  device's is waiting to be applied -- and then the whole of what is stale,
  up to `STALE_HOURS_PER_ANSWER` hours of each type, the earliest (the rest
  come in later answers; nothing is dropped). An empty object means none.
  Absent means "not known now": the phone keeps what it was told before.
  */
  staleHours?: Record<string, number[]>;
}

function refuse(
  c: Context<AppHonoEnv>,
  error: IngestErrorCode,
  status: ContentfulStatusCode,
  headers: Record<string, string> = {},
): Response {
  return c.json({ error }, status, { "cache-control": "no-store", ...headers });
}

/**
Rejections listed in one answer. The count is always exact; the list is for
a person reading the phone's log, and a batch with thousands of bad records
is a bug the first few already describe.
*/
export const MAX_REPORTED_REJECTIONS = 100;

/** The largest sync report kept. A real one is a few kilobytes. */
const MAX_SYNC_STATE_CHARS = 128 * 1024;

/**
The phone's sync report as the JSON to seal, or null to keep the last one.
A report too large to be one is not stored -- and is not a reason to refuse
the records that came with it, which are already queued by now.
*/
function syncStateJson(syncState: HcSyncState | undefined): string | null {
  if (syncState === undefined) return null;
  const text = JSON.stringify(syncState);
  return text.length > MAX_SYNC_STATE_CHARS ? null : text;
}

type IngestContext = Context<AppHonoEnv>;
type Log = ReturnType<typeof makeLogger>;

/** Steps 1 to 3: the device this request speaks for, or the refusal to send. */
async function authenticate(c: IngestContext, repos: Repos, log: Log): Promise<string | Response> {
  const unauthorized = (): Response =>
    refuse(c, "unauthorized", 401, { "www-authenticate": "Bearer" });

  const presented = bearerDeviceToken(c.req.header("authorization"));
  if (presented === null) return unauthorized();

  const device = await repos.devices.authRow(presented.deviceId);
  const tokenOk = await verifyDeviceToken(presented.token, device?.tokenHash ?? NO_DEVICE_HASH);
  if (device === null || !tokenOk || device.revokedAt !== null) {
    log.warn("ingest.unauthorized", { known: device !== null, revoked: device?.revokedAt != null });
    return unauthorized();
  }

  const count = await repos.devices.bumpRate(device.id, INGEST_RATE_WINDOW_SECONDS);
  if (count > INGEST_RATE_LIMIT) {
    log.warn("ingest.rate_limited", { deviceId: device.id, count });
    return refuse(c, "rate_limited", 429, { "retry-after": String(INGEST_RATE_WINDOW_SECONDS) });
  }
  return device.id;
}

interface ReadBatch {
  parsed: ParsedBatch;
  /** The gzip body exactly as it arrived: this is what gets queued. */
  compressed: Uint8Array<ArrayBuffer>;
  rawBytes: number;
}

/** The first media type of a header, lower-cased, without its parameters. */
function mediaType(header: string | undefined): string | undefined {
  return header?.split(";", 1)[0]?.trim().toLowerCase();
}

/** Steps 4 and 5: the body, bounded and validated, or the refusal to send. */
async function readBatch(
  c: IngestContext,
  deviceId: string,
  log: Log,
): Promise<ReadBatch | Response> {
  const refused = (errorCode: string, error: IngestErrorCode, status: 400 | 413): Response => {
    log.warn("ingest.refused", { deviceId, errorCode });
    return refuse(c, error, status);
  };
  const sized = (stage: string, reason: "too_large" | "malformed"): Response =>
    reason === "too_large"
      ? refused(`${stage}_too_large`, "payload_too_large", 413)
      : refused(`${stage}_malformed`, "bad_request", 400);

  const encoding = c.req.header("content-encoding")?.trim().toLowerCase();
  if (encoding !== "gzip" || mediaType(c.req.header("content-type")) !== "application/json") {
    return refuse(c, "unsupported_media_type", 415);
  }
  const stream: ReadableStream<Uint8Array> | null = c.req.raw.body;
  if (stream === null) return refused("body_missing", "bad_request", 400);

  const compressed = await readCapped(stream, MAX_COMPRESSED_BYTES);
  if (!compressed.ok) return sized("body", compressed.reason);
  const raw = await gunzipCapped(compressed.bytes, MAX_RAW_BYTES);
  if (!raw.ok) return sized("gzip", raw.reason);

  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw.bytes),
    );
  } catch {
    return refused("json_malformed", "bad_request", 400);
  }
  if (exceedsRecordLimit(json)) return refused("too_many_records", "payload_too_large", 413);
  const parsed = parseBatch(json);
  if (parsed === null) return refused("envelope_invalid", "bad_request", 400);
  // A token speaks for one device only. A batch naming another is refused as a
  // bad request rather than a 401: the caller is who it says, it is the batch
  // that is wrong.
  return parsed.deviceId === deviceId
    ? { parsed, compressed: compressed.bytes, rawBytes: raw.bytes.length }
    : refused("device_mismatch", "bad_request", 400);
}

/**
Step 7: the device's stale platform-total hours, or null when the answer
cannot say. The batch is already queued and acknowledged by now, so a read
that fails leaves the field out -- "not known now" -- and does not turn the
acknowledgement into an error the phone would answer by sending it again.
*/
async function readStaleHours(
  c: IngestContext,
  deviceId: string,
  parsed: ParsedBatch,
  log: Log,
): Promise<Record<string, number[]> | null> {
  try {
    const ctx = makeCtx(c.env.DB, c.env, { log });
    return await staleHoursFor(ctx, deviceId, parsed.batchId, carriedPlatformHours(parsed));
  } catch (error) {
    log.warn("ingest.stale_hours_failed", { deviceId, ...errorFields(error) });
    return null;
  }
}

export const ingestRouter = new Hono<AppHonoEnv>();

ingestRouter.post(INGEST_PATH, async (c) => {
  const log = makeLogger({ src: "ingest" });
  const repos = reposFor(c.env.DB, c.env, { log });

  // --- 1 to 3. Who is this, and how often ------------------------------------
  const deviceId = await authenticate(c, repos, log);
  if (deviceId instanceof Response) return deviceId;

  // Backpressure, before the body costs anything. Not atomic with the insert
  // below: requests already past this line can overshoot the limit by what the
  // rate limit lets through in one window, which is bounded and accepted.
  const depth = await repos.hcIngestQueue.depth(deviceId);
  if (depth.bytes > MAX_QUEUED_BYTES || depth.batches > MAX_QUEUED_BATCHES) {
    // Something is waiting, so make sure something is working on it.
    c.executionCtx.waitUntil(kickIngestRunner(c.env, deviceId));
    log.warn("ingest.backlogged", { deviceId, batches: depth.batches, bytes: depth.bytes });
    return refuse(c, "backlogged", 429, { "retry-after": String(BACKLOG_RETRY_SECONDS) });
  }

  // --- 4 + 5. The body, bounded and validated --------------------------------
  const read = await readBatch(c, deviceId, log);
  if (read instanceof Response) return read;
  const { parsed, compressed, rawBytes } = read;

  // --- 6. Queue, then acknowledge --------------------------------------------
  const run = runStampOf(parsed.syncState);
  const { duplicate, conflict } = await repos.hcIngestQueue.enqueue({
    deviceId,
    batchId: parsed.batchId,
    body: compressed,
    rawBytes,
    upserts: parsed.upserts.length,
    deletes: parsed.deletes.length,
    rejected: parsed.rejected.length,
    phoneTime: parsed.phoneTime,
    run,
  });
  if (conflict) {
    // The same batch id, different content. Acknowledging it would tell the
    // phone that records were taken which were not.
    log.warn("ingest.refused", { deviceId, errorCode: "batch_id_conflict" });
    return refuse(c, "batch_id_conflict", 409);
  }
  await repos.devices.recordUpload(deviceId, {
    appVersion: parsed.appVersion,
    syncStateJson: syncStateJson(parsed.syncState),
  });
  c.executionCtx.waitUntil(kickIngestRunner(c.env, deviceId));

  log.info("ingest.accepted", {
    deviceId,
    duplicate,
    upserts: parsed.upserts.length,
    deletes: parsed.deletes.length,
    rejected: parsed.rejected.length,
    bodyBytes: compressed.length,
    rawBytes,
    runTrigger: run.trigger,
  });
  // --- 7. Stale platform totals ---------------------------------------------
  const staleHours = await readStaleHours(c, deviceId, parsed, log);
  const body: IngestResponse = {
    accepted: parsed.upserts.length,
    deleted: parsed.deletes.length,
    rejected: parsed.rejected.slice(0, MAX_REPORTED_REJECTIONS),
    rejectedTotal: parsed.rejected.length,
    duplicate,
    serverTime: Date.now(),
    ...(staleHours !== null && { staleHours }),
  };
  return c.json(body, 200, { "cache-control": "no-store" });
});

// Terminal for every other method, so nothing on this path ever falls through
// to the gate below it and answers with a login page.
ingestRouter.all(INGEST_PATH, (c) => refuse(c, "method_not_allowed", 405, { allow: "POST" }));
