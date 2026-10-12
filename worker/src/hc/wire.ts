/**
 * The wire contract between the companion app and `POST /ingest/health-connect`.
 *
 * One module, used twice: by the ingest route, to decide what it acknowledges,
 * and by the runner that later applies the queued batch, so the two can never
 * disagree about which records a batch holds.
 *
 * The envelope is strict and the records are not. A batch whose envelope is
 * wrong is refused whole (the phone has a bug, and silently taking part of it
 * would hide that). A record that is wrong is rejected on its own, by id, with
 * a stable error code, and the rest of the batch is kept: one malformed record
 * from one app must not hold up everything else the phone has to say.
 *
 * `type` is NOT checked against a list of known record types. The store is
 * lossless, and a type a newer Health Connect SDK adds has to be kept, not
 * dropped, until this Worker learns to read it. `data` is kept as it arrived.
 *
 * Times are epoch milliseconds; zone offsets are minutes, or null when the
 * record carries none.
 */

import { z } from "zod";

const WIRE_VERSION = 1;

/** `type`: a Health Connect record class name without its `Record` suffix, or `Agg.<Metric>`. */
const RECORD_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
/** A batch id: the phone mints a UUID, but any opaque token of this shape will do. */
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

const MAX_ID_LENGTH = 200;
const MAX_ORIGIN_LENGTH = 255;
/**
 * Free-text metadata the phone copies from another app's record: a device's
 * make and model, a client record id. Generous on purpose -- a record is
 * rejected whole when one of these is over its bound, and the phone must not
 * truncate, so the bound only exists to refuse nonsense.
 */
const MAX_METADATA_LENGTH = 1024;

/**
 * The most records (upserts plus deletes) one batch may carry. Above it the
 * batch is refused whole, with 413, and the phone sends two smaller ones: a
 * refusal, not a truncation, so nothing is ever dropped. It exists because the
 * byte limits alone do not bound the work: a few kilobytes of gzip can expand
 * to millions of one-byte array elements, each of which costs a validation and
 * (when it is not a record) a rejection entry.
 */
export const MAX_BATCH_RECORDS = 25_000;

/**
 * What started a sync run: a short stable code (`periodic`, `alarm`, `manual`,
 * `app_open`, `backfill`). Checked for its shape and not against a list, so a
 * trigger a later build of the app adds is stored as it is given.
 */
const RUN_TRIGGER_PATTERN = /^[a-z][a-z0-9_]{0,23}$/u;
/** How a sync run ended: `ok`, `interrupted`, or the error code it failed with. */
const RUN_END_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

/** Record types one sync report may list. The SDK has a few dozen. */
const MAX_REPORTED_TYPES = 500;

/**
 * The latest instant taken, 2200-01-01T00:00:00Z. Far past any real record,
 * and far inside what `Date` and `Intl` can represent: a larger integer is
 * still a valid JSON number, but it is not a time, and everything downstream
 * that buckets by day would throw on it.
 */
export const MAX_EPOCH_MS = 7_258_118_400_000;

const epochMs = z.number().int().nonnegative().max(MAX_EPOCH_MS);
/** Minutes east of UTC. No real zone is more than 18 hours out. */
const offsetMinutes = z
  .number()
  .int()
  .min(-18 * 60)
  .max(18 * 60)
  .nullable()
  .optional();

const deviceSchema = z.looseObject({
  type: z.string().max(64).optional(),
  manufacturer: z.string().max(MAX_METADATA_LENGTH).optional(),
  model: z.string().max(MAX_METADATA_LENGTH).optional(),
});

const recordSchema = z
  .looseObject({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    type: z.string().regex(RECORD_TYPE_PATTERN),
    origin: z.string().min(1).max(MAX_ORIGIN_LENGTH),
    device: deviceSchema.optional(),
    recordingMethod: z.string().max(64).optional(),
    lastModified: epochMs,
    clientRecordId: z.string().max(MAX_METADATA_LENGTH).nullable().optional(),
    clientRecordVersion: z.number().int().nullable().optional(),
    start: epochMs.optional(),
    end: epochMs.optional(),
    startOffsetMin: offsetMinutes,
    endOffsetMin: offsetMinutes,
    time: epochMs.optional(),
    offsetMin: offsetMinutes,
    data: z.record(z.string(), z.unknown()),
  })
  .refine(
    (record) =>
      record.time === undefined
        ? record.start !== undefined && record.end !== undefined && record.end >= record.start
        : record.start === undefined && record.end === undefined,
    { message: "a record carries either time, or start and end with end >= start" },
  );

/** One Health Connect record as the phone serialised it. Unknown fields are kept. */
export type HcRecord = z.infer<typeof recordSchema>;

const backfillSchema = z.looseObject({
  complete: z.boolean(),
  oldestDoneMs: epochMs.nullable().optional(),
});

const typeStateSchema = z.looseObject({
  type: z.string().regex(RECORD_TYPE_PATTERN),
  permission: z.enum(["granted", "denied", "unavailable"]),
  tokenAgeS: z.number().int().nonnegative().nullable().optional(),
  backlog: z.number().int().nonnegative().nullable().optional(),
  backfill: backfillSchema.optional(),
});

/**
 * How the sync run before this batch's own ended, named by when it started.
 * A run that is cut off never sends its closing report, so the next one says
 * it for it.
 */
const previousRunSchema = z.looseObject({
  startedAt: epochMs,
  end: z.string().regex(RUN_END_PATTERN),
});

const syncStateSchema = z.looseObject({
  types: z.array(typeStateSchema).max(MAX_REPORTED_TYPES),
  backgroundRead: z.boolean().optional(),
  historyRead: z.boolean().optional(),
  batteryExempt: z.boolean().optional(),
  hcProviderVersion: z.string().max(64).optional(),
  androidSdk: z.number().int().optional(),
  backfillComplete: z.boolean().optional(),
  /** Permission to read exercise routes (GPS), reported apart from the record types. */
  exerciseRoutes: z.enum(["granted", "denied", "unavailable"]).optional(),
  lastError: z
    .looseObject({ errorCode: z.string().max(64), at: epochMs })
    .nullable()
    .optional(),
  // Which sync run the batch was uploaded in. Optional, all three: a build of
  // the app from before they existed sends none. Like the rest of the report
  // they are part of the envelope, so one that is there and malformed refuses
  // the batch.
  /** What started the run. */
  runTrigger: z.string().regex(RUN_TRIGGER_PATTERN).optional(),
  /** The phone's clock when the run began: the same in every batch of one run. */
  runStartedAt: epochMs.optional(),
  previousRun: previousRunSchema.optional(),
});

/** The phone's own report of its sync health. Latest wins. */
export type HcSyncState = z.infer<typeof syncStateSchema>;

const envelopeSchema = z.object({
  v: z.literal(WIRE_VERSION),
  deviceId: z.string().min(1).max(64),
  appVersion: z.string().min(1).max(64),
  batchId: z.string().regex(BATCH_ID_PATTERN),
  phoneTime: epochMs,
  // Elements are validated one by one below, so one bad record is a rejection
  // rather than a refused batch.
  upserts: z.array(z.unknown()).default([]),
  deletes: z.array(z.unknown()).default([]),
  syncState: syncStateSchema.optional(),
});

/** Why one record or delete was not taken. Stable strings: the phone logs them. */
type RejectionCode = "invalid_record" | "invalid_id";

export interface Rejection {
  /** The record's id when it had a usable one, else its position in the array. */
  id: string;
  errorCode: RejectionCode;
}

export interface ParsedBatch {
  deviceId: string;
  appVersion: string;
  batchId: string;
  phoneTime: number;
  upserts: HcRecord[];
  /** Health Connect record ids to delete. */
  deletes: string[];
  syncState: HcSyncState | undefined;
  rejected: Rejection[];
}

function idOf(value: unknown, index: number, prefix: string): string {
  if (typeof value === "object" && value !== null && "id" in value) {
    const { id } = value;
    if (typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH) return id;
  }
  return `${prefix}[${String(index)}]`;
}

/**
 * True when a decoded body carries more records than one batch may. Checked
 * before anything is validated, on the array lengths alone, so an oversized
 * batch costs nothing more than the parse that produced it.
 */
export function exceedsRecordLimit(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const { upserts, deletes } = json as { upserts?: unknown; deletes?: unknown };
  const count =
    (Array.isArray(upserts) ? upserts.length : 0) + (Array.isArray(deletes) ? deletes.length : 0);
  return count > MAX_BATCH_RECORDS;
}

/**
 * Read a decoded request body as a batch.
 *
 * Returns null when the envelope itself is not a batch this version reads; the
 * caller answers 400 and queues nothing. Otherwise every usable record and
 * delete, and one `Rejection` for each that was not.
 */
export function parseBatch(json: unknown): ParsedBatch | null {
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  const { data } = envelope;

  const rejected: Rejection[] = [];
  const upserts: HcRecord[] = [];
  for (const [index, candidate] of data.upserts.entries()) {
    const record = recordSchema.safeParse(candidate);
    if (record.success) upserts.push(record.data);
    else rejected.push({ id: idOf(candidate, index, "upserts"), errorCode: "invalid_record" });
  }

  const deletes: string[] = [];
  for (const [index, candidate] of data.deletes.entries()) {
    if (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= MAX_ID_LENGTH
    ) {
      deletes.push(candidate);
    } else {
      rejected.push({ id: `deletes[${String(index)}]`, errorCode: "invalid_id" });
    }
  }

  return {
    deviceId: data.deviceId,
    appVersion: data.appVersion,
    batchId: data.batchId,
    phoneTime: data.phoneTime,
    upserts,
    deletes,
    syncState: data.syncState,
    rejected,
  };
}

/**
 * What a batch says of the sync run it belongs to, and of the one before it:
 * the four values kept on its `hc_ingest_log` row. Null for whatever the batch
 * did not say.
 */
export interface BatchRunStamp {
  trigger: string | null;
  /** Epoch milliseconds, by the phone's clock. */
  startedMs: number | null;
  previousStartedMs: number | null;
  previousEnd: string | null;
}

export function runStampOf(syncState: HcSyncState | undefined): BatchRunStamp {
  return {
    trigger: syncState?.runTrigger ?? null,
    startedMs: syncState?.runStartedAt ?? null,
    previousStartedMs: syncState?.previousRun?.startedAt ?? null,
    previousEnd: syncState?.previousRun?.end ?? null,
  };
}

/** The instant a record is filed under: its start, or its single time. */
export function recordStartMs(record: HcRecord): number {
  return record.start ?? record.time ?? 0;
}

/** The instant a record ends: its end, or its single time. */
export function recordEndMs(record: HcRecord): number {
  return record.end ?? record.time ?? 0;
}
