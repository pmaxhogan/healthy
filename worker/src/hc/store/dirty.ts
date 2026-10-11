/**
 * `hc_dirty`: what the rebuild phase still has to recompute.
 *
 * Applying a batch only marks; the runner rebuilds once the queue is empty
 * (worker/src/hc/store/rebuild.ts), so a month of backfill rebuilds each day
 * once and not once per batch. A mark is written in the same `db.batch` as the
 * change that caused it and deleted in the same `db.batch` as the row it asked
 * for, so neither a lost mark nor a rebuilt-but-still-marked row can happen.
 *
 * Kinds, and what `key` is for each:
 *
 *   hr        `<originHash>|<hourUtc>`  a per-minute heart-rate row
 *   day       `<hourUtc>|<type>`        the day rollups of the local day(s) that
 *                                       UTC hour falls on, every origin (the
 *                                       hour zero-padded: key order is time order)
 *   sleep     blinded record id         one sleep night summary
 *   exercise  blinded record id         one exercise session summary
 *
 * A `day` mark names a UTC hour, not a day: which calendar day an hour belongs
 * to depends on the configured zone, and the zone that counts is the one in
 * force when the day is rebuilt, not when the record arrived.
 *
 * ### Parked marks
 *
 * A mark whose row cannot be rebuilt -- the chunk it has to be built from will
 * not open -- is moved to the kind `parked:<kind>`: kept, skipped by the
 * rebuild, and counted apart (`storeBacklog`). One bad row must not be retried
 * for ever at the head of the list while every other mark waits behind it.
 * `unparkMarks` puts them back.
 */

import { all, run } from "../../db/client.ts";

import { HOUR_MS } from "./keys.ts";

import type { Ctx } from "../../db/client.ts";

type DirtyKind = "hr" | "day" | "sleep" | "exercise";
export type DirtyMark = readonly [kind: DirtyKind, key: string];

export interface DirtyRow {
  kind: string;
  key: string;
}

/**
 * The order marks are rebuilt in. Heart-rate minutes first, because a night
 * and a session read them and there are few of them (only a series that runs
 * past its hour leaves one). Then nights and sessions, then days: the rebuild
 * also runs in a small share of each slice while a backfill is still arriving,
 * and what the owner looks at first should exist first.
 */
const REBUILD_ORDER: readonly DirtyKind[] = ["hr", "sleep", "exercise", "day"];

/** What a parked mark's kind starts with. See the module comment. */
export const PARKED_PREFIX = "parked:";

/** Marks written per statement: one bound string of a few hundred kilobytes at most. */
const MARK_PAGE = 5000;

/**
 * The longest a stored session is taken to run when looking for the sessions
 * a change could affect. It bounds two things that nothing else bounds: how
 * far back `markSessionsStatement` looks for a session still running at an
 * instant, and how much of a session claiming an absurd span the rebuild reads
 * context for. A real night or workout is a fraction of this.
 */
export const MAX_SESSION_SPAN_MS = 48 * HOUR_MS;

function markStatement(
  ctx: Ctx,
  deviceId: string,
  marks: readonly DirtyMark[],
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO hc_dirty (device_id, kind, key, marked_at)
       SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?
         FROM json_each(?) WHERE true
       ON CONFLICT (device_id, kind, key) DO UPDATE SET marked_at = excluded.marked_at`,
    )
    .bind(deviceId, ctx.now(), JSON.stringify(marks));
}

/**
 * The statements that mark everything in `marks`, a page of them each: a list
 * is as long as what one record touched, which nothing bounds.
 */
export function markStatements(
  ctx: Ctx,
  deviceId: string,
  marks: readonly DirtyMark[],
  pageSize = MARK_PAGE,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let from = 0; from < marks.length; from += pageSize) {
    statements.push(markStatement(ctx, deviceId, marks.slice(from, from + pageSize)));
  }
  return statements;
}

export function clearStatement(ctx: Ctx, deviceId: string, mark: DirtyRow): D1PreparedStatement {
  return ctx.db
    .prepare("DELETE FROM hc_dirty WHERE device_id = ? AND kind = ? AND key = ?")
    .bind(deviceId, mark.kind, mark.key);
}

/** Clear several marks of one kind at once. A lookup by primary key per key. */
export function clearKeysStatement(
  ctx: Ctx,
  deviceId: string,
  kind: DirtyKind,
  keys: readonly string[],
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `DELETE FROM hc_dirty
        WHERE device_id = ? AND kind = ? AND key IN (SELECT value FROM json_each(?))`,
    )
    .bind(deviceId, kind, JSON.stringify(keys));
}

/** The statement `markSessionsStatement` runs, exported so its plan can be asserted. */
export function markSessionsSql(kind: "sleep" | "exercise"): string {
  const table = kind === "sleep" ? "hc_sleep_night" : "hc_exercise_session";
  return `INSERT INTO hc_dirty (device_id, kind, key, marked_at)
       SELECT device_id, ?, record_id_blind, ? FROM ${table}
        WHERE device_id = ? AND start_ms >= ? AND start_ms <= ? AND end_ms >= ?
       ON CONFLICT (device_id, kind, key) DO UPDATE SET marked_at = excluded.marked_at`;
}

/**
 * Mark every stored sleep night or exercise session that overlaps
 * `[startMs, endMs]`. What makes a summary follow data that arrives after its
 * session did: a night's heart rate uploaded in a later batch, a second
 * session that turns out to overlap the first.
 *
 * A session overlapping the window started before the window ends, and -- no
 * session being longer than `MAX_SESSION_SPAN_MS` for this purpose -- no
 * earlier than that long before it begins. Both bounds are on `start_ms`,
 * which is indexed, so this reads the sessions around the window and not every
 * session there has ever been.
 */
export function markSessionsStatement(
  ctx: Ctx,
  deviceId: string,
  kind: "sleep" | "exercise",
  startMs: number,
  endMs: number,
): D1PreparedStatement {
  return ctx.db
    .prepare(markSessionsSql(kind))
    .bind(kind, ctx.now(), deviceId, startMs - MAX_SESSION_SPAN_MS, endMs, startMs);
}

/**
 * The statement `nextDirty` runs for one kind, exported so its plan can be
 * asserted. Day marks are read backwards: their key begins with the hour, so
 * that is newest first -- yesterday before last year, during a backfill.
 */
export function nextDirtySql(kind: string): string {
  const order = kind === "day" ? "key DESC" : "key";
  return `SELECT kind, key FROM hc_dirty WHERE device_id = ? AND kind = ? ORDER BY ${order} LIMIT ?`;
}

/**
 * The next marks to rebuild: a page of the first kind, in rebuild order, that
 * has any. One read along the primary key per kind -- never a sort of the
 * whole list, which after a backfill is long. Parked marks are not returned.
 */
export async function nextDirty(ctx: Ctx, deviceId: string, limit: number): Promise<DirtyRow[]> {
  for (const kind of REBUILD_ORDER) {
    const rows = await all<DirtyRow>(
      ctx.db.prepare(nextDirtySql(kind)).bind(deviceId, kind, limit),
    );
    if (rows.length > 0) return rows;
  }
  return [];
}

/** The statements that set a mark aside: kept under `parked:<kind>`, out of the rebuild's way. */
export function parkMarkStatements(
  ctx: Ctx,
  deviceId: string,
  mark: DirtyRow,
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `INSERT INTO hc_dirty (device_id, kind, key, marked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id, kind, key) DO UPDATE SET marked_at = excluded.marked_at`,
      )
      .bind(deviceId, `${PARKED_PREFIX}${mark.kind}`, mark.key, ctx.now()),
    clearStatement(ctx, deviceId, mark),
  ];
}

/**
 * Put every parked mark of a device back in the list, to be tried again.
 * Returns how many. For after whatever made its source unreadable is fixed.
 */
export async function unparkMarks(ctx: Ctx, deviceId: string): Promise<number> {
  const { changes } = await run(
    ctx.db
      .prepare(
        // OR REPLACE: the same row may have been marked again since it was parked.
        `UPDATE OR REPLACE hc_dirty SET kind = substr(kind, ${String(PARKED_PREFIX.length + 1)})
          WHERE device_id = ? AND kind >= ? AND kind < ?`,
      )
      .bind(deviceId, PARKED_PREFIX, `${PARKED_PREFIX}\u{FFFF}`),
  );
  return changes;
}
