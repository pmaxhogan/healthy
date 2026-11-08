/**
The Google Health store: one sealed row per metric per day, and each metric's
sync bookkeeping (migration 0022).

`data_type` and `day` are clear, as a Health Connect rollup's keys are; every
value is in `payload_enc`, a padded `v2:` envelope bound to
`google_health_daily.payload_enc.<data_type>:<day>`, so a row cannot be moved
to another metric or another day and still open.

A read of a window replaces that window: `replaceWindow` upserts every day
Google returned, stamped with the run's second, and then deletes the window's
rows that run did not touch -- a day Google no longer has is not kept as if it
did. The upserts are chunked into batches (`BATCH_CHUNK`); a run that dies
between them leaves the window's older rows in place, never a hole, and the
next run writes it again.
*/

import { BATCH_CHUNK, all, batch, chunk, one, run } from "../client.ts";
import { aadFor, open, sealShort } from "../crypto.ts";

import type { GhDay, GhValues } from "../../google/health.ts";
import type { Ctx } from "../client.ts";
import type { GoogleHealthDay, GoogleHealthExtent, GoogleHealthSyncRow } from "../rows.ts";

const TABLE = "google_health_daily";

const aad = (dataType: string, day: string): string =>
  aadFor(TABLE, "payload_enc", `${dataType}:${day}`);

interface DayRow {
  data_type: string;
  day: string;
  fetched_at: number;
  payload_enc: string;
}

function parseValues(text: string): GhValues {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as GhValues)
    : {};
}

export function makeGoogleHealthRepo(ctx: Ctx) {
  return {
    /**
    Store what one read of [start, endExclusive) returned and drop the rest of
    that window. `start: null` means the whole history before `endExclusive`.
    Returns how many days were written and how many removed.
    */
    async replaceWindow(
      dataType: string,
      days: readonly GhDay[],
      window: { start: string | null; endExclusive: string },
    ): Promise<{ written: number; removed: number }> {
      const stamp = ctx.now();
      for (const part of chunk(days, BATCH_CHUNK)) {
        const statements = await Promise.all(
          part.map(async (day) =>
            ctx.db
              .prepare(
                `INSERT INTO ${TABLE} (data_type, day, fetched_at, payload_enc) VALUES (?, ?, ?, ?)
                 ON CONFLICT (data_type, day) DO UPDATE
                   SET fetched_at = excluded.fetched_at, payload_enc = excluded.payload_enc`,
              )
              .bind(
                dataType,
                day.date,
                stamp,
                await sealShort(ctx.env, JSON.stringify(day.values), aad(dataType, day.date)),
              ),
          ),
        );
        await batch(ctx.db, statements);
      }
      const { changes } = await run(
        ctx.db
          .prepare(
            `DELETE FROM ${TABLE}
              WHERE data_type = ? AND day >= ? AND day < ? AND fetched_at < ?`,
          )
          .bind(dataType, window.start ?? "", window.endExclusive, stamp),
      );
      return { written: days.length, removed: changes };
    },

    /** The stored days of `dataTypes` from `from` to `to`, both inclusive, oldest first. */
    async days(dataTypes: readonly string[], from: string, to: string): Promise<GoogleHealthDay[]> {
      const out: GoogleHealthDay[] = [];
      for (const dataType of dataTypes) {
        const rows = await all<DayRow>(
          ctx.db
            .prepare(
              `SELECT data_type, day, fetched_at, payload_enc FROM ${TABLE}
                WHERE data_type = ? AND day >= ? AND day <= ? ORDER BY day`,
            )
            .bind(dataType, from, to),
        );
        for (const row of rows) {
          const text = await open(ctx.env, row.payload_enc, aad(row.data_type, row.day));
          out.push({
            dataType: row.data_type,
            date: row.day,
            fetchedAt: row.fetched_at,
            values: parseValues(text),
          });
        }
      }
      return out;
    },

    /** Per metric: how many days are stored and their first and last date. */
    async extents(): Promise<GoogleHealthExtent[]> {
      const rows = await all<{ data_type: string; days: number; first: string; last: string }>(
        ctx.db.prepare(
          `SELECT data_type, COUNT(*) AS days, MIN(day) AS first, MAX(day) AS last
             FROM ${TABLE} GROUP BY data_type`,
        ),
      );
      return rows.map((row) => ({
        dataType: row.data_type,
        days: row.days,
        firstDate: row.first,
        lastDate: row.last,
      }));
    },

    /** The oldest day stored of any metric, or null when nothing is. */
    async oldestDay(): Promise<string | null> {
      const row = await one<{ first: string | null }>(
        ctx.db.prepare(`SELECT MIN(day) AS first FROM ${TABLE}`),
      );
      return row?.first ?? null;
    },

    async syncRows(): Promise<GoogleHealthSyncRow[]> {
      return all<GoogleHealthSyncRow>(
        ctx.db.prepare("SELECT * FROM google_health_sync ORDER BY data_type"),
      );
    },

    /** Record one metric's read: a success (and whether it read the whole history), or a code. */
    async recordAttempt(
      dataType: string,
      outcome: { ok: true; backfilled: boolean } | { ok: false; code: string },
    ): Promise<void> {
      const at = ctx.now();
      if (!outcome.ok) {
        await run(
          ctx.db
            .prepare(
              `INSERT INTO google_health_sync (data_type, last_attempt_at, last_error_code, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (data_type) DO UPDATE
                 SET last_attempt_at = excluded.last_attempt_at,
                     last_error_code = excluded.last_error_code,
                     updated_at = excluded.updated_at`,
            )
            .bind(dataType, at, outcome.code, at),
        );
        return;
      }
      const backfilledAt = outcome.backfilled ? at : null;
      await run(
        ctx.db
          .prepare(
            `INSERT INTO google_health_sync
               (data_type, last_attempt_at, last_ok_at, last_error_code, backfilled_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?)
             ON CONFLICT (data_type) DO UPDATE
               SET last_attempt_at = excluded.last_attempt_at,
                   last_ok_at = excluded.last_ok_at,
                   last_error_code = NULL,
                   backfilled_at = COALESCE(excluded.backfilled_at, google_health_sync.backfilled_at),
                   updated_at = excluded.updated_at`,
          )
          .bind(dataType, at, at, backfilledAt, at),
      );
    },
  };
}
