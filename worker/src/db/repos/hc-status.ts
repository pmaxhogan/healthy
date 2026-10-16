/**
Read-only views of a phone's bookkeeping for the Phone page: `hc_sync_state`
(per record type) and `hc_ingest_log` (per batch).

Everything here is in the clear by design -- permission states, instants,
counts, stable error codes -- so nothing is opened and nothing is written. The
writers are the ingest route and the runner.
*/

import { newestRuns } from "../../hc/upload-runs.ts";
import { all } from "../client.ts";

import type {
  DeviceTotals,
  IngestLogRow,
  IngestSummary,
  PermissionState,
  SyncStateRow,
} from "../../hc/device.ts";
import type { RunLogRow, UploadRun } from "../../hc/upload-runs.ts";
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
  run_trigger: string | null;
  run_started_ms: number | null;
  prev_run_started_ms: number | null;
  prev_run_end: string | null;
}

interface RunLogDbRow {
  rowid: number;
  received_at: number;
  upserts: number;
  deletes: number;
  rejected: number;
  run_trigger: string | null;
  run_started_ms: number | null;
  prev_run_started_ms: number | null;
  prev_run_end: string | null;
}

const RUN_LOG_COLUMNS = `rowid, received_at, upserts, deletes, rejected,
       run_trigger, run_started_ms, prev_run_started_ms, prev_run_end`;

/**
The statements `recentRuns` reads the log with: a device's batches, newest
first, a page at a time -- the first page, and the page after a row. Both
walk `hc_ingest_log_received` (device, then arrival; the rowid breaks a tie
and is the last column of every index), so a page costs its own rows and no
more, however long the log is. Exported so the plan can be asserted.

Bound: the device and the page size; `RUN_LOG_NEXT_SQL` takes, between
them, the `received_at` and the rowid of the last row already read.
*/
export const RUN_LOG_FIRST_SQL = `SELECT ${RUN_LOG_COLUMNS}
  FROM hc_ingest_log WHERE device_id = ?
 ORDER BY received_at DESC, rowid DESC LIMIT ?`;
export const RUN_LOG_NEXT_SQL = `SELECT ${RUN_LOG_COLUMNS}
  FROM hc_ingest_log WHERE device_id = ? AND (received_at, rowid) < (?, ?)
 ORDER BY received_at DESC, rowid DESC LIMIT ?`;

/** Log rows the first page of `recentRuns` reads, at least; each later page is twice the last. */
const RUN_PAGE_ROWS = 100;

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
    Record count and permission tallies for every device that has reported, by
    device id. `backfilled` counts granted types only, so it is a part of
    `granted`: a type the phone may not read has no backfill to finish. The
    exercise-route pseudo-type older app builds reported is not a record type
    (`syncRows` leaves it out too) and would never finish one either.
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
    The newest batches first. Counts, sizes and a stable code: no record, id or
    origin. `statuses` narrows it to batches in one of those states, so the page
    can show what was applied while everything newer is still waiting.
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
                    applied, superseded, removed, body_bytes, raw_bytes, apply_ms,
                    run_trigger, run_started_ms, prev_run_started_ms, prev_run_end
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
        runTrigger: row.run_trigger,
        runStartedMs: row.run_started_ms,
        prevRunStartedMs: row.prev_run_started_ms,
        prevRunEnd: row.prev_run_end,
      }));
    },

    /**
    The newest `limit` sync runs a device has uploaded in, newest first: its
    log rows grouped by the run they say they belong to
    (worker/src/hc/upload-runs.ts). Counts, instants and stable codes.

    Nothing in the log is indexed by run, and reading all of it to group it
    would cost more with every day the phone syncs. So the log is read from
    its newest row backwards, a page at a time, only until the runs asked
    for are known to be whole: a run is whole once a row of an OLDER run has
    been read behind it (one more run than was asked for), or the log has
    ended. A row limit alone would cut the oldest run it reached in two and
    report the half; this reads past the cut instead. Pages double, so a
    run of thousands of batches (a backfill) is a handful of round trips.

    What that rests on: a phone runs one sync at a time, so the batches of a
    run arrive together, and none of them lies further back in the log than
    the first row read of the run before it.
    */
    async recentRuns(deviceId: string, limit: number): Promise<UploadRun[]> {
      const rows: RunLogRow[] = [];
      let size = Math.max(RUN_PAGE_ROWS, 4 * limit);
      let last: RunLogDbRow | undefined;
      for (;;) {
        const statement: D1PreparedStatement =
          last === undefined
            ? ctx.db.prepare(RUN_LOG_FIRST_SQL).bind(deviceId, size)
            : ctx.db.prepare(RUN_LOG_NEXT_SQL).bind(deviceId, last.received_at, last.rowid, size);
        const page = await all<RunLogDbRow>(statement);
        for (const row of page) {
          rows.push({
            receivedAt: row.received_at,
            upserts: row.upserts,
            deletes: row.deletes,
            rejected: row.rejected,
            runTrigger: row.run_trigger,
            runStartedMs: row.run_started_ms,
            prevRunStartedMs: row.prev_run_started_ms,
            prevRunEnd: row.prev_run_end,
          });
        }
        const found = newestRuns(rows, limit);
        last = page.at(-1);
        if (last === undefined || page.length < size || found.whole) return found.runs;
        size *= 2;
      }
    },

    /**
    What became of a device's batches, as counts: how many are in each state,
    how many were applied since `recentSince` (Unix seconds), when the last one
    was, and the median apply time of the newest `sample` applied batches.

    Two queries, both inside the device's own range of the log (one small row
    per batch, no payload): a pass that counts, and a walk back from the newest
    batch that stops at `sample` applied ones. Neither touches the store.
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
