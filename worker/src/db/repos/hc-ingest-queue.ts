/**
Batches the ingest route has accepted and the runner has not yet applied:
`hc_ingest_queue` and `hc_ingest_log` (worker/migrations/0016_health_connect.sql).

The route's side is `enqueue`: seal the gzip body exactly as it arrived and
write it with its log row in one transaction, so "acknowledged" always means
"durably queued". The runner's side is `head` / `remove` / `park`: take the
oldest batch of a device, apply it, delete it -- or, when it cannot be
applied, set it aside. A parked batch is never deleted by the runner: the
phone has already moved past it, so its body is the only copy of its records.
It no longer blocks the queue, and `unpark` puts it back.

A body is stored compressed, as the phone sent it, split across rows when it
is larger than one row may hold. Each part is sealed with an AAD naming the
device, the batch and the part, so parts cannot be reordered or moved
between batches without failing to open.
*/

import { blinderFor } from "../blind.ts";
import { all, batch, one, run } from "../client.ts";
import { aadFor, openBytes, sealBytes } from "../crypto.ts";

import type { BatchRunStamp } from "../../hc/wire.ts";
import type { Ctx } from "../client.ts";

/**
Compressed bytes per queue row. D1 caps a value at 2 MB and the envelope is
base64 (four characters per three bytes), so this leaves comfortable room.
*/
const PART_BYTES = 1_200_000;

export interface EnqueueInput {
  deviceId: string;
  batchId: string;
  /** The gzip body, exactly as received. */
  body: Uint8Array<ArrayBuffer>;
  /** Decompressed size, for the log. */
  rawBytes: number;
  upserts: number;
  deletes: number;
  rejected: number;
  /** The phone's clock when it built the batch, epoch ms, as it claimed. */
  phoneTime: number | null;
  /**
  The sync run the batch says it belongs to, and how the one before it
  ended. Omitted, like a batch that says neither: every column NULL.
  */
  run?: BatchRunStamp | undefined;
}

export interface EnqueueResult {
  /** True when this exact batch had been accepted before: nothing was written. */
  duplicate: boolean;
  /**
  True when this batch id had been accepted before with a DIFFERENT body:
  nothing was written, and the caller must not acknowledge it.
  */
  conflict: boolean;
}

export interface QueuedBatch {
  deviceId: string;
  batchId: string;
  /** The first part's sequence number: the batch's place in the device's order. */
  seq: number;
  receivedAt: number;
  /** The gzip body, reassembled. */
  body: Uint8Array<ArrayBuffer>;
}

export interface QueueDepth {
  /** Batches waiting to be applied. Parked batches are not waiting. */
  batches: number;
  bytes: number;
}

export interface ParkedDepth {
  /** Batches set aside because they could not be applied. */
  batches: number;
  bytes: number;
}

type IngestStatus = "queued" | "applying" | "applied" | "failed";

export interface IngestOutcome {
  status: IngestStatus;
  errorCode?: string | null;
  applied?: number;
  superseded?: number;
  removed?: number;
  applyMs?: number;
}

interface QueueRow {
  seq: number;
  device_id: string;
  batch_id: string;
  part: number;
  parts: number;
  body_enc: string;
  received_at: number;
}

const bodyAad = (deviceId: string, batchId: string, part: number): string =>
  aadFor("hc_ingest_queue", "body_enc", `${deviceId}:${batchId}:${String(part)}`);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/iu.test(error.message);
}

/** What a batch id seen before means: the same batch again, or another one wearing its id. */
function replay(stored: string, digest: string): EnqueueResult {
  return stored === digest
    ? { duplicate: true, conflict: false }
    : { duplicate: false, conflict: true };
}

/**
The statement `head` runs: every row of the oldest batch a device has
waiting, in part order. Bound: the device, twice. Exported so its plan can
be asserted.
*/
export const HEAD_SQL = `SELECT * FROM hc_ingest_queue
  WHERE device_id = ?
    AND batch_id = (SELECT batch_id FROM hc_ingest_queue
                     WHERE device_id = ? AND parked_at IS NULL ORDER BY seq LIMIT 1)
  ORDER BY part`;

export function makeHcIngestQueueRepo(ctx: Ctx) {
  const outcomeStatement = (
    deviceId: string,
    batchId: string,
    outcome: IngestOutcome,
  ): D1PreparedStatement => {
    const finished = outcome.status === "applied" || outcome.status === "failed";
    return ctx.db
      .prepare(
        `UPDATE hc_ingest_log SET
           status = ?,
           error_code = ?,
           applied = coalesce(?, applied),
           superseded = coalesce(?, superseded),
           removed = coalesce(?, removed),
           apply_ms = coalesce(?, apply_ms),
           applied_at = CASE WHEN ? THEN ? ELSE applied_at END
         WHERE device_id = ? AND batch_id = ?`,
      )
      .bind(
        outcome.status,
        outcome.errorCode ?? null,
        outcome.applied ?? null,
        outcome.superseded ?? null,
        outcome.removed ?? null,
        outcome.applyMs ?? null,
        finished ? 1 : 0,
        ctx.now(),
        deviceId,
        batchId,
      );
  };

  /** The digest stored for a batch id this device has sent before, or null. */
  const seenDigest = async (deviceId: string, batchId: string): Promise<string | null> => {
    const row = await one<{ body_digest: string }>(
      ctx.db
        .prepare("SELECT body_digest FROM hc_ingest_log WHERE device_id = ? AND batch_id = ?")
        .bind(deviceId, batchId),
    );
    return row?.body_digest ?? null;
  };

  /**
  A keyed digest of a body: SHA-256 of the bytes, then the blinding HMAC, so
  the column says "same batch or not" and nothing about the content.
  */
  const digestOf = async (deviceId: string, body: Uint8Array<ArrayBuffer>): Promise<string> => {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const hex = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return blinderFor(ctx.env).digest("hc.batch_body", `${deviceId}\u{0}${hex}`);
  };

  return {
    /**
    Queue one batch, once. A batch id this device has sent before is reported
    as a duplicate and not written again: the phone retries until it hears a
    200, and the retry of a batch that did land must not apply twice.
    */
    async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
      const digest = await digestOf(input.deviceId, input.body);
      const stored = await seenDigest(input.deviceId, input.batchId);
      if (stored !== null) return replay(stored, digest);

      const at = ctx.now();
      const parts = Math.max(1, Math.ceil(input.body.length / PART_BYTES));
      const statements: D1PreparedStatement[] = [
        ctx.db
          .prepare(
            `INSERT INTO hc_ingest_log
               (device_id, batch_id, body_digest, received_at, status, upserts, deletes, rejected, body_bytes, raw_bytes, phone_time,
                run_trigger, run_started_ms, prev_run_started_ms, prev_run_end)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.deviceId,
            input.batchId,
            digest,
            at,
            input.upserts,
            input.deletes,
            input.rejected,
            input.body.length,
            input.rawBytes,
            input.phoneTime,
            input.run?.trigger ?? null,
            input.run?.startedMs ?? null,
            input.run?.previousStartedMs ?? null,
            input.run?.previousEnd ?? null,
          ),
      ];
      for (let part = 0; part < parts; part++) {
        const slice = input.body.slice(part * PART_BYTES, (part + 1) * PART_BYTES);
        const aad = bodyAad(input.deviceId, input.batchId, part);
        const bodyEnc = await sealBytes(ctx.env, slice, aad);
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO hc_ingest_queue (device_id, batch_id, part, parts, body_enc, body_bytes, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(input.deviceId, input.batchId, part, parts, bodyEnc, slice.length, at),
        );
      }
      try {
        // One D1 batch is one transaction: the log row and every part, or none.
        await batch(ctx.db, statements);
      } catch (error) {
        // Two deliveries of one batch racing: the loser's log insert collides.
        const winner = isUniqueViolation(error)
          ? await seenDigest(input.deviceId, input.batchId)
          : null;
        if (winner !== null) return replay(winner, digest);
        throw error;
      }
      return { duplicate: false, conflict: false };
    },

    /** How much one device has waiting. What the route's backpressure reads. */
    async depth(deviceId: string): Promise<QueueDepth> {
      const row = await one<{ batches: number; bytes: number | null }>(
        ctx.db
          .prepare(
            `SELECT count(DISTINCT batch_id) AS batches, sum(body_bytes) AS bytes
             FROM hc_ingest_queue WHERE device_id = ? AND parked_at IS NULL`,
          )
          .bind(deviceId),
      );
      return { batches: row?.batches ?? 0, bytes: row?.bytes ?? 0 };
    },

    /** How much one device has set aside. What the Phone page shows beside "Retry". */
    async parked(deviceId: string): Promise<ParkedDepth> {
      const row = await one<{ batches: number; bytes: number | null }>(
        ctx.db
          .prepare(
            `SELECT count(DISTINCT batch_id) AS batches, sum(body_bytes) AS bytes
             FROM hc_ingest_queue WHERE device_id = ? AND parked_at IS NOT NULL`,
          )
          .bind(deviceId),
      );
      return { batches: row?.batches ?? 0, bytes: row?.bytes ?? 0 };
    },

    /** Every device with at least one batch waiting, oldest work first. */
    async devicesWithWork(): Promise<string[]> {
      const rows = await all<{ device_id: string }>(
        ctx.db.prepare(
          "SELECT device_id FROM hc_ingest_queue WHERE parked_at IS NULL GROUP BY device_id ORDER BY min(seq)",
        ),
      );
      return rows.map((row) => row.device_id);
    },

    /**
    The oldest batch a device has waiting, reassembled, or null. Strictly in
    arrival order: a delete that follows an upsert must be applied after it.
    */
    async head(deviceId: string): Promise<QueuedBatch | null> {
      // One statement, so one round trip: which batch is oldest, and its rows.
      const rows = await all<QueueRow>(ctx.db.prepare(HEAD_SQL).bind(deviceId, deviceId));
      const head = rows[0];
      if (head === undefined) return null;
      if (rows.length !== head.parts) throw new Error("queued batch is missing parts");
      const opened = await Promise.all(
        rows.map((row) =>
          openBytes(ctx.env, row.body_enc, bodyAad(deviceId, row.batch_id, row.part)),
        ),
      );
      const body = new Uint8Array(opened.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of opened) {
        body.set(part, offset);
        offset += part.length;
      }
      return {
        deviceId,
        batchId: head.batch_id,
        seq: Math.min(...rows.map((row) => row.seq)),
        receivedAt: head.received_at,
        body,
      };
    },

    /**
    The statement that drops a batch from the queue once it is applied. A
    batch that failed is parked, never dropped.

    A statement and not a call, because of where it has to run: in the same
    `db.batch` -- the same transaction -- as the statement that records the
    batch as applied (`outcomeStatement`). The queued body is the only copy
    of what the phone sent, so it goes at the moment the log says its records
    are in the store, and not a round trip before or after.
    */
    removeStatement(deviceId: string, batchId: string): D1PreparedStatement {
      return ctx.db
        .prepare("DELETE FROM hc_ingest_queue WHERE device_id = ? AND batch_id = ?")
        .bind(deviceId, batchId);
    },

    /**
    Set a batch aside: it could not be applied, and must neither be lost nor
    hold up the batches behind it. Its log row says why (`recordOutcome`).
    */
    async park(deviceId: string, batchId: string): Promise<void> {
      await run(
        ctx.db
          .prepare(
            `UPDATE hc_ingest_queue SET parked_at = coalesce(parked_at, ?)
             WHERE device_id = ? AND batch_id = ?`,
          )
          .bind(ctx.now(), deviceId, batchId),
      );
    },

    /**
    Put every parked batch of a device back in the queue, in its original
    order, and mark its log row queued again. Returns how many batches.

    Applying an old batch after newer ones is safe by construction: an upsert
    only replaces a stored record with a greater `lastModified`, and an
    upsert for an id deleted since is dropped by its tombstone.
    */
    async unpark(deviceId: string): Promise<number> {
      const rows = await all<{ batch_id: string }>(
        ctx.db
          .prepare(
            `SELECT DISTINCT batch_id FROM hc_ingest_queue
             WHERE device_id = ? AND parked_at IS NOT NULL`,
          )
          .bind(deviceId),
      );
      if (rows.length === 0) return 0;
      await batch(ctx.db, [
        ctx.db
          .prepare(
            `UPDATE hc_ingest_log SET status = 'queued', error_code = NULL, applied_at = NULL
             WHERE device_id = ? AND batch_id IN (
               SELECT batch_id FROM hc_ingest_queue WHERE device_id = ? AND parked_at IS NOT NULL
             )`,
          )
          .bind(deviceId, deviceId),
        ctx.db
          .prepare("UPDATE hc_ingest_queue SET parked_at = NULL WHERE device_id = ?")
          .bind(deviceId),
      ]);
      return rows.length;
    },

    /**
    The statement that records what became of a batch, for a caller that
    commits it with other statements. Counts, a duration and a stable error
    code only.
    */
    outcomeStatement,

    /** Record what became of a batch, by itself. */
    async recordOutcome(deviceId: string, batchId: string, outcome: IngestOutcome): Promise<void> {
      await run(outcomeStatement(deviceId, batchId, outcome));
    },
  };
}
