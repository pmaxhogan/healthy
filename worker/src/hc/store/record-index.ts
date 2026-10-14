/**
`hc_record_index`: blinded record id -> the chunk that holds the record.

Health Connect reports a deletion as an id and nothing else, and an edit can
move a record to another hour (or, in principle, another type or origin).
Both need to find a record without opening every chunk; this table is how.

A deleted id keeps its row as a tombstone, stamped with WHICH BATCH DELETED
IT, by its place in the order batches arrived: `deleted_seq`, the batch's
queue sequence number (`hc_ingest_queue.seq` of its first part), and beside
it `deleted_at`, when that batch arrived (the queue row's `received_at`,
the server's clock) -- not when the delete was applied, and nothing the
phone said. A delete for an id this store has never seen is tombstoned too: a
batch carries its deletes and its upserts unordered, and a record created
and deleted between two syncs must end up deleted, whichever is applied
first.

A tombstone is not for ever, because an id is. Health Connect derives the
id of a record written with a client record id from the app, that id and
the type, so an app that deletes a record and writes it again gets the same
id back; and the companion app's own ids for the platform's hourly totals
name a metric and an hour, deleted while the hour is empty and upserted
when it has a total. So what a tombstone refuses is only an upsert that is
OLDER than the delete -- one from a batch that arrived before the deleting
batch did, applied late because it was set aside and queued again. An
upsert from a batch that arrived after it is the record written again, and
brings the id back to life (`revivesTombstone`, `indexUpsertStatement`'s
`revive`).

Arrival is the only order there is to go by. A record's `lastModified` is
the phone's clock and a delete carries no time at all; the time a delete
was applied says nothing either, since a batch can wait in the queue behind
others while the one that rewrites the record is already there too.

And the order of arrival is the queue's sequence number, exactly: it is
given out as a batch is queued, never given twice, and kept when a batch
that was set aside is queued again. An upsert brings a tombstoned id back
when its batch's number is HIGHER than the deleting batch's. The same
number is the same batch -- an upsert and a delete of one id in one batch
-- and stays deleted. `received_at` cannot say as much: it is in whole
seconds, and two batches can arrive in one.

A tombstone written before the sequence number was kept has none
(`deleted_seq` NULL), and for those the rule is the one `deleted_at`
allows: an upsert from a batch that arrived in a later second revives, one
from an earlier second does not, and two batches in the same second are
taken in the record's favour (the upsert is kept) unless the upserting
batch deletes the id itself. Older still, a tombstone may hold the time its
delete was applied instead, which is never earlier than the time that batch
arrived: for those the rule errs towards refusing, as it always did.

Every statement takes its ids as one JSON array and reads it with
`json_each`: D1 allows a hundred bound parameters a statement, and a chunk
can hold more records than that.
*/

import { all, chunk as pages } from "../../db/client.ts";

import type { Meter } from "./budget.ts";
import type { ChunkKey } from "./keys.ts";
import type { Ctx } from "../../db/client.ts";

export interface IndexEntry {
  key: ChunkKey;
  /** True for a tombstone. `key` then says where the record was, if anywhere. */
  deleted: boolean;
  /** For a tombstone: when the batch that deleted the id arrived, unix seconds. */
  deletedAt: number | null;
  /**
  For a tombstone: the queue sequence number of the batch that deleted the
  id. Null for a live row, and for a tombstone older than the column.
  */
  deletedSeq: number | null;
}

/** What a batch is, to a tombstone: where it stands in the order of arrival. */
export interface BatchArrival {
  /** The batch's queue sequence number: its first part's `hc_ingest_queue.seq`. */
  seq: number;
  /** When it arrived, unix seconds. Only what an old tombstone is compared with. */
  receivedAt: number;
  /** True for an id the batch itself deletes. */
  deletes: (id: string) => boolean;
}

/** The part of a batch's arrival a tombstone is stamped with. */
type Stamp = Pick<BatchArrival, "seq" | "receivedAt">;

/**
True when an upsert may bring a tombstoned id back: its batch arrived after
the batch that deleted the id. By sequence number where the tombstone has
one; by the second of arrival, with a tie going to the upsert unless its
batch deletes the id too, where it does not. See the module comment.
*/
export function revivesTombstone(entry: IndexEntry, batch: BatchArrival, id: string): boolean {
  if (!entry.deleted || entry.deletedAt === null) return false;
  if (entry.deletedSeq !== null) return batch.seq > entry.deletedSeq;
  return batch.receivedAt === entry.deletedAt
    ? !batch.deletes(id)
    : batch.receivedAt > entry.deletedAt;
}

interface IndexRow {
  record_id_blind: string;
  record_type: string;
  origin_hash: string;
  hour_utc: number;
  deleted_at: number | null;
  deleted_seq: number | null;
}

/**
The statement `lookupIndex` runs. Bound: the ids as a JSON array, the device.

`+device_id`: the unary plus keeps the planner from using the device index,
which would walk every index row the device has and test each against the
list. The ids are the primary key; the device is only a check on the result.
*/
export const LOOKUP_INDEX_SQL = `SELECT record_id_blind, record_type, origin_hash, hour_utc, deleted_at, deleted_seq
   FROM hc_record_index
  WHERE record_id_blind IN (SELECT value FROM json_each(?)) AND +device_id = ?`;

/**
The statement `tombstoneStatement` runs. Bound: when the deleting batch
arrived, its sequence number, the ids, the device. The same `+device_id`,
for the same reason.
*/
export const TOMBSTONE_SQL = `UPDATE hc_record_index SET deleted_at = ?, deleted_seq = ?
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
        deletedAt: row.deleted_at,
        deletedSeq: row.deleted_seq,
      });
    }
  }
  return found;
}

/**
Point the given ids at `key`. A tombstone among them is left as it is,
unless `revive` says these ids are records written again after their
delete (`revivesTombstone`): then it is brought back to life.
*/
export function indexUpsertStatement(
  ctx: Ctx,
  deviceId: string,
  key: ChunkKey,
  blinds: readonly string[],
  revive = false,
): D1PreparedStatement {
  // `WHERE true`: without it SQLite reads `ON CONFLICT` as a join constraint
  // of the SELECT and refuses the statement.
  const live = revive ? "" : " WHERE hc_record_index.deleted_at IS NULL";
  return ctx.db
    .prepare(
      `INSERT INTO hc_record_index
         (record_id_blind, device_id, record_type, origin_hash, hour_utc, deleted_at, deleted_seq)
       SELECT value, ?, ?, ?, ?, NULL, NULL FROM json_each(?) WHERE true
       ON CONFLICT (record_id_blind) DO UPDATE SET
         record_type = excluded.record_type,
         origin_hash = excluded.origin_hash,
         hour_utc = excluded.hour_utc,
         deleted_at = NULL,
         deleted_seq = NULL${live}`,
    )
    .bind(deviceId, key.type, key.originHash, key.hourUtc, JSON.stringify(blinds));
}

/** Tombstone ids the index knows, stamped with the batch that deletes them: `by`. */
export function tombstoneStatement(
  ctx: Ctx,
  deviceId: string,
  blinds: readonly string[],
  by: Stamp,
): D1PreparedStatement {
  return ctx.db
    .prepare(TOMBSTONE_SQL)
    .bind(by.receivedAt, by.seq, JSON.stringify(blinds), deviceId);
}

/**
True when a batch that deletes an id already tombstoned is the later of the
two deletes, so that the tombstone takes its stamp. What `restampStatement`
asks of each row, asked here of a row already read, to know whether there
is anything to send: the two must stay the same test.
*/
export function restamps(entry: IndexEntry, by: Stamp): boolean {
  if (!entry.deleted) return false;
  return entry.deletedSeq === null
    ? (entry.deletedAt ?? by.receivedAt) < by.receivedAt
    : entry.deletedSeq < by.seq;
}

/**
Move the stamp of ids that are already tombstoned forward to the batch
`by`: a later batch has deleted them again, and it is the latest delete
that an upsert has to have arrived after. Forward is by sequence number
where the tombstone has one, and by the second of arrival where it is older
than that; either way the row leaves with both. Never moved back -- a batch
applied late leaves a newer stamp alone, and so does a replay.
*/
export function restampStatement(
  ctx: Ctx,
  deviceId: string,
  blinds: readonly string[],
  by: Stamp,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `UPDATE hc_record_index SET deleted_at = ?1, deleted_seq = ?4
        WHERE record_id_blind IN (SELECT value FROM json_each(?2))
          AND +device_id = ?3 AND deleted_at IS NOT NULL
          AND CASE WHEN deleted_seq IS NULL THEN deleted_at < ?1 ELSE deleted_seq < ?4 END`,
    )
    .bind(by.receivedAt, JSON.stringify(blinds), deviceId, by.seq);
}

/**
Tombstone ids the index has never seen. The row says nothing about where
the record was, because it never was anywhere: an empty type and origin.
*/
export function unknownTombstoneStatement(
  ctx: Ctx,
  deviceId: string,
  blinds: readonly string[],
  by: Stamp,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO hc_record_index
         (record_id_blind, device_id, record_type, origin_hash, hour_utc, deleted_at, deleted_seq)
       SELECT value, ?, '', '', 0, ?, ? FROM json_each(?) WHERE true
       ON CONFLICT (record_id_blind) DO NOTHING`,
    )
    .bind(deviceId, by.receivedAt, by.seq, JSON.stringify(blinds));
}
