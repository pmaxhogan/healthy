/**
 * `hc_sync_state`: per (device, record type), what has arrived and what the
 * phone says about its own access to that type. It is what lets an MCP answer
 * tell "not permitted", "permitted, no data" and "stale" from an empty list.
 *
 * Two writers, both at the end of a batch:
 *
 *   - `recountStatement` -- what the store holds. Recomputed from `hc_chunks`
 *     rather than incremented, so it is exact whatever was replayed on the way:
 *     the count, the earliest record start and the latest record end.
 *   - `reportStatement`  -- what the phone reported in the batch's `syncState`:
 *     permission, changes-token age, backlog, backfill progress. Latest wins,
 *     by the batch's arrival time.
 *
 * `last_upload_at` is the arrival (unix seconds) of the last batch that covered
 * the type: one that carried records of it or changed some, or whose
 * `syncState` listed it. A granted type the phone keeps reporting on is
 * therefore not stale merely because nothing new was recorded.
 */

import { HC_RECORD_TYPES } from "../record-types.ts";

import type { Ctx } from "../../db/client.ts";
import type { HcSyncState } from "../wire.ts";

/**
 * The statement `recountStatement` runs. Bound: device, the types as a JSON
 * array, the upload time. Everything it reads of `hc_chunks` is in the index
 * `hc_chunks_counts`, so no chunk row -- and no payload -- is touched.
 */
export const RECOUNT_SQL = `INSERT INTO hc_sync_state (device_id, record_type, record_count, first_ms, last_ms, last_upload_at)
       SELECT ?1, t.value, coalesce(a.n, 0), a.first_ms, a.last_ms, ?3
         FROM json_each(?2) AS t
         LEFT JOIN (
           SELECT record_type, sum(record_count) AS n,
                  min(min_start_ms) AS first_ms, max(max_end_ms) AS last_ms
             FROM hc_chunks
            WHERE device_id = ?1 AND record_type IN (SELECT value FROM json_each(?2))
            GROUP BY record_type
         ) AS a ON a.record_type = t.value
        WHERE true
       ON CONFLICT (device_id, record_type) DO UPDATE SET
         record_count = excluded.record_count,
         first_ms = excluded.first_ms,
         last_ms = excluded.last_ms,
         last_upload_at = max(coalesce(hc_sync_state.last_upload_at, 0), excluded.last_upload_at)`;

/** Recompute count, first and last for the given types of one device. */
export function recountStatement(
  ctx: Ctx,
  deviceId: string,
  types: readonly string[],
  uploadAt: number,
): D1PreparedStatement {
  return ctx.db.prepare(RECOUNT_SQL).bind(deviceId, JSON.stringify([...new Set(types)]), uploadAt);
}

/** The pseudo-type older builds report for exercise-route permission. */
const NOT_A_RECORD_TYPE = "ExerciseRoute";

const KNOWN_TYPES: ReadonlySet<string> = new Set(HC_RECORD_TYPES);

/** Store the phone's own report. Null when the batch carried none. */
export function reportStatement(
  ctx: Ctx,
  deviceId: string,
  syncState: HcSyncState | undefined,
  reportedAt: number,
): D1PreparedStatement | null {
  if (syncState === undefined || syncState.types.length === 0) return null;
  // An older app build reports exercise-route permission as a fake record type.
  // It is not one: it never holds records, and has no place in coverage.
  const reported = syncState.types.filter((entry) => entry.type !== NOT_A_RECORD_TYPE);
  if (reported.length === 0) return null;
  const rows = reported.map((entry) => ({
    type: entry.type,
    known: KNOWN_TYPES.has(entry.type) ? 1 : 0,
    permission: entry.permission,
    tokenAgeS: entry.tokenAgeS ?? null,
    backlog: entry.backlog ?? null,
    complete: entry.backfill?.complete === true ? 1 : 0,
    oldestDoneMs: entry.backfill?.oldestDoneMs ?? null,
  }));
  return ctx.db
    .prepare(
      `INSERT INTO hc_sync_state
         (device_id, record_type, permission_state, token_age_s, backlog,
          backfill_complete, backfill_oldest_ms, reported_at, last_upload_at)
       SELECT ?1, json_extract(value, '$.type'), json_extract(value, '$.permission'),
              json_extract(value, '$.tokenAgeS'), json_extract(value, '$.backlog'),
              json_extract(value, '$.complete'), json_extract(value, '$.oldestDoneMs'), ?2, ?2
         FROM json_each(?3)
        -- Only a type this Worker knows, or one that already has stored data: a
        -- future type that really has records must still be listed, and a
        -- made-up one must not be.
        WHERE json_extract(value, '$.known') = 1
           OR EXISTS (SELECT 1 FROM hc_chunks
                       WHERE device_id = ?1 AND record_type = json_extract(value, '$.type'))
       ON CONFLICT (device_id, record_type) DO UPDATE SET
         permission_state = excluded.permission_state,
         token_age_s = excluded.token_age_s,
         backlog = excluded.backlog,
         backfill_complete = excluded.backfill_complete,
         backfill_oldest_ms = excluded.backfill_oldest_ms,
         reported_at = excluded.reported_at,
         last_upload_at = max(coalesce(hc_sync_state.last_upload_at, 0), excluded.last_upload_at)
       WHERE excluded.reported_at >= coalesce(hc_sync_state.reported_at, 0)`,
    )
    .bind(deviceId, reportedAt, JSON.stringify(rows));
}
