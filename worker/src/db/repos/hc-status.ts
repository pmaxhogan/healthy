/**
 * Read-only views of a phone's bookkeeping for the Phone page: `hc_sync_state`
 * (per record type) and `hc_ingest_log` (per batch).
 *
 * Everything here is in the clear by design -- permission states, instants,
 * counts, stable error codes -- so nothing is opened and nothing is written. The
 * writers are the ingest route and the runner.
 */

import { all } from "../client.ts";

import type {
  DeviceTotals,
  IngestLogRow,
  IngestSummary,
  PermissionState,
  SyncStateRow,
} from "../../hc/device.ts";
import type { Ctx } from "../client.ts";

interface SyncStateDbRow {
  record_type: string;
  permission_state: PermissionState;
  first_ms: number | null;
  last_ms: number | null;
  record_count: number;
  last_upload_at: number | null;
  token_age_s: number | null;
  backlog: number | null;
  backfill_complete: number;
  backfill_oldest_ms: number | null;
}

interface IngestLogDbRow {
  received_at: number;
  applied_at: number | null;
  status: IngestLogRow["status"];
  error_code: string | null;
  upserts: number;
  deletes: number;
  rejected: number;
  applied: number;
  superseded: number;
  removed: number;
  body_bytes: number;
  raw_bytes: number;
  apply_ms: number | null;
}

interface TotalsDbRow {
  device_id: string;
  records: number | null;
  granted: number | null;
  denied: number | null;
  backfilled: number | null;
}

interface StatusCountDbRow {
  status: IngestLogRow["status"];
  n: number;
  recent: number | null;
  last_applied_at: number | null;
}

/** The middle value of a list, or the mean of the middle two. Null for none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values];
  sorted.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted.at(mid) ?? 0;
  return sorted.length % 2 === 1 ? upper : Math.round(((sorted.at(mid - 1) ?? upper) + upper) / 2);
}

export function makeHcStatusRepo(ctx: Ctx) {
  return {
    /** Every record type a device has reported, by type. */
    async syncRows(deviceId: string): Promise<SyncStateRow[]> {
      const rows = await all<SyncStateDbRow>(
        ctx.db
          .prepare(
            "SELECT * FROM hc_sync_state WHERE device_id = ? AND record_type != 'ExerciseRoute' ORDER BY record_type",
          )
          .bind(deviceId),
      );
      return rows.map((row) => ({
        recordType: row.record_type,
        permissionState: row.permission_state,
        firstMs: row.first_ms,
        lastMs: row.last_ms,
        recordCount: row.record_count,
        lastUploadAt: row.last_upload_at,
        tokenAgeS: row.token_age_s,
        backlog: row.backlog,
        backfillComplete: row.backfill_complete === 1,
        backfillOldestMs: row.backfill_oldest_ms,
      }));
    },

    /**
     * Record count and permission tallies for every device that has reported, by
     * device id. `backfilled` counts granted types only, so it is a part of
     * `granted`: a type the phone may not read has no backfill to finish. The
     * exercise-route pseudo-type older app builds reported is not a record type
     * (`syncRows` leaves it out too) and would never finish one either.
     */
    async totalsByDevice(): Promise<Map<string, DeviceTotals>> {
      const rows = await all<TotalsDbRow>(
        ctx.db.prepare(
          `SELECT device_id,
                  sum(record_count) AS records,
                  sum(permission_state = 'granted') AS granted,
                  sum(permission_state = 'denied') AS denied,
                  sum(permission_state = 'granted' AND backfill_complete = 1) AS backfilled
           FROM hc_sync_state WHERE record_type != 'ExerciseRoute' GROUP BY device_id`,
        ),
      );
      return new Map(
        rows.map((row) => [
          row.device_id,
          {
            recordCount: row.records ?? 0,
            typesGranted: row.granted ?? 0,
            typesDenied: row.denied ?? 0,
            typesBackfilled: row.backfilled ?? 0,
          },
        ]),
      );
    },

    /** Distinct error codes of the device's failed batches. Codes only. */
    async failedCodes(deviceId: string): Promise<string[]> {
      const rows = await all<{ error_code: string }>(
        ctx.db
          .prepare(
            `SELECT DISTINCT error_code FROM hc_ingest_log
             WHERE device_id = ? AND status = 'failed' AND error_code IS NOT NULL
             ORDER BY error_code`,
          )
          .bind(deviceId),
      );
      return rows.map((row) => row.error_code);
    },

    /**
     * The newest batches first. Counts, sizes and a stable code: no record, id or
     * origin. `statuses` narrows it to batches in one of those states, so the page
     * can show what was applied while everything newer is still waiting.
     */
    async ingestLog(
      deviceId: string,
      limit: number,
      statuses?: readonly IngestLogRow["status"][],
    ): Promise<IngestLogRow[]> {
      const only =
        statuses === undefined ? "" : `AND status IN (${statuses.map(() => "?").join(", ")})`;
      const rows = await all<IngestLogDbRow>(
        ctx.db
          .prepare(
            `SELECT received_at, applied_at, status, error_code, upserts, deletes, rejected,
                    applied, superseded, removed, body_bytes, raw_bytes, apply_ms
             FROM hc_ingest_log WHERE device_id = ? ${only}
             ORDER BY received_at DESC, rowid DESC LIMIT ?`,
          )
          .bind(deviceId, ...(statuses ?? []), limit),
      );
      return rows.map((row) => ({
        receivedAt: row.received_at,
        appliedAt: row.applied_at,
        status: row.status,
        errorCode: row.error_code,
        upserts: row.upserts,
        deletes: row.deletes,
        rejected: row.rejected,
        applied: row.applied,
        superseded: row.superseded,
        removed: row.removed,
        bodyBytes: row.body_bytes,
        rawBytes: row.raw_bytes,
        applyMs: row.apply_ms,
      }));
    },

    /**
     * What became of a device's batches, as counts: how many are in each state,
     * how many were applied since `recentSince` (Unix seconds), when the last one
     * was, and the median apply time of the newest `sample` applied batches.
     *
     * Two queries, both inside the device's own range of the log (one small row
     * per batch, no payload): a pass that counts, and a walk back from the newest
     * batch that stops at `sample` applied ones. Neither touches the store.
     */
    async ingestSummary(
      deviceId: string,
      recentSince: number,
      sample: number,
    ): Promise<IngestSummary> {
      const counts = await all<StatusCountDbRow>(
        ctx.db
          .prepare(
            `SELECT status, count(*) AS n, sum(applied_at >= ?) AS recent,
                    max(applied_at) AS last_applied_at
             FROM hc_ingest_log WHERE device_id = ? GROUP BY status`,
          )
          .bind(recentSince, deviceId),
      );
      const timings = await all<{ apply_ms: number }>(
        ctx.db
          .prepare(
            `SELECT apply_ms FROM hc_ingest_log
             WHERE device_id = ? AND status = 'applied' AND apply_ms IS NOT NULL
             ORDER BY received_at DESC, rowid DESC LIMIT ?`,
          )
          .bind(deviceId, sample),
      );
      const by = new Map(counts.map((row) => [row.status, row]));
      const applied = by.get("applied");
      return {
        queued: by.get("queued")?.n ?? 0,
        applying: by.get("applying")?.n ?? 0,
        applied: applied?.n ?? 0,
        failed: by.get("failed")?.n ?? 0,
        appliedRecently: applied?.recent ?? 0,
        lastAppliedAt: applied?.last_applied_at ?? null,
        applyMsMedian: median(timings.map((row) => row.apply_ms)),
        applySample: timings.length,
      };
    },
  };
}
