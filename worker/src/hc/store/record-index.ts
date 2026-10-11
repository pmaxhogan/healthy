/**
 * `hc_record_index`: blinded record id -> the chunk that holds the record.
 *
 * Health Connect reports a deletion as an id and nothing else, and an edit can
 * move a record to another hour (or, in principle, another type or origin).
 * Both need to find a record without opening every chunk; this table is how.
 *
 * A deleted id keeps its row as a tombstone. Health Connect never reuses an
 * id, so an upsert that arrives for a tombstoned one is late, and is dropped.
 * A delete for an id this store has never seen is tombstoned too: a batch
 * carries its deletes and its upserts unordered, and a record created and
 * deleted between two syncs must end up deleted, whichever is applied first.
 *
 * Every statement takes its ids as one JSON array and reads it with
 * `json_each`: D1 allows a hundred bound parameters a statement, and a chunk
 * can hold more records than that.
 */

import { all, chunk as pages } from "../../db/client.ts";

import type { Meter } from "./budget.ts";
import type { ChunkKey } from "./keys.ts";
import type { Ctx } from "../../db/client.ts";

export interface IndexEntry {
  key: ChunkKey;
  /** True for a tombstone. `key` then says where the record was, if anywhere. */
  deleted: boolean;
}

interface IndexRow {
  record_id_blind: string;
  record_type: string;
  origin_hash: string;
  hour_utc: number;
  deleted_at: number | null;
}

/**
 * The statement `lookupIndex` runs. Bound: the ids as a JSON array, the device.
 *
 * `+device_id`: the unary plus keeps the planner from using the device index,
 * which would walk every index row the device has and test each against the
 * list. The ids are the primary key; the device is only a check on the result.
 */
export const LOOKUP_INDEX_SQL = `SELECT record_id_blind, record_type, origin_hash, hour_utc, deleted_at
   FROM hc_record_index
  WHERE record_id_blind IN (SELECT value FROM json_each(?)) AND +device_id = ?`;

/** The statement `tombstoneStatement` runs. The same `+device_id`, for the same reason. */
export const TOMBSTONE_SQL = `UPDATE hc_record_index SET deleted_at = ?
  WHERE record_id_blind IN (SELECT value FROM json_each(?))
    AND +device_id = ? AND deleted_at IS NULL`;

/** Ids looked up per query. One bound string of a few hundred kilobytes at most. */
const LOOKUP_PAGE = 5000;

/** The index rows that exist for the given blinded ids. */
export async function lookupIndex(
  ctx: Ctx,
  deviceId: string,
  blinds: readonly string[],
  meter?: Meter,
): Promise<Map<string, IndexEntry>> {
  const found = new Map<string, IndexEntry>();
  for (const page of pages(blinds, LOOKUP_PAGE)) {
    meter?.spend();
    const rows = await all<IndexRow>(
      ctx.db.prepare(LOOKUP_INDEX_SQL).bind(JSON.stringify(page), deviceId),
    );
    for (const row of rows) {
      found.set(row.record_id_blind, {
        key: { type: row.record_type, originHash: row.origin_hash, hourUtc: row.hour_utc },
        deleted: row.deleted_at !== null,
      });
    }
  }
  return found;
}

/** Point the given ids at `key`. A tombstone is never brought back to life. */
export function indexUpsertStatement(
  ctx: Ctx,
  deviceId: string,
  key: ChunkKey,
  blinds: readonly string[],
): D1PreparedStatement {
  // `WHERE true`: without it SQLite reads `ON CONFLICT` as a join constraint
  // of the SELECT and refuses the statement.
  return ctx.db
    .prepare(
      `INSERT INTO hc_record_index
         (record_id_blind, device_id, record_type, origin_hash, hour_utc, deleted_at)
       SELECT value, ?, ?, ?, ?, NULL FROM json_each(?) WHERE true
       ON CONFLICT (record_id_blind) DO UPDATE SET
         record_type = excluded.record_type,
         origin_hash = excluded.origin_hash,
         hour_utc = excluded.hour_utc
       WHERE hc_record_index.deleted_at IS NULL`,
    )
    .bind(deviceId, key.type, key.originHash, key.hourUtc, JSON.stringify(blinds));
}

/** Tombstone ids the index knows. */
export function tombstoneStatement(
  ctx: Ctx,
  deviceId: string,
  blinds: readonly string[],
): D1PreparedStatement {
  return ctx.db.prepare(TOMBSTONE_SQL).bind(ctx.now(), JSON.stringify(blinds), deviceId);
}

/**
 * Tombstone ids the index has never seen. The row says nothing about where
 * the record was, because it never was anywhere: an empty type and origin.
 */
export function unknownTombstoneStatement(
  ctx: Ctx,
  deviceId: string,
  blinds: readonly string[],
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO hc_record_index
         (record_id_blind, device_id, record_type, origin_hash, hour_utc, deleted_at)
       SELECT value, ?, '', '', 0, ? FROM json_each(?) WHERE true
       ON CONFLICT (record_id_blind) DO NOTHING`,
    )
    .bind(deviceId, ctx.now(), JSON.stringify(blinds));
}
