/**
Failing streaks: which sync passes are failing right now, and for how long.

One row per (subject, check) that has failed since it last succeeded. A
failure upserts the row and counts; a success deletes it. So the table is the
list of what is broken at this moment and is empty when everything works, and
a streak is exact: it counts attempts that failed with no success between
them, not time since something last worked. A run that never happened (a
rate-limit backoff, a platform outage) is not an attempt and is not counted.

`subject` is an `alerts.subject`; see `alerts.ts` beside this file for the
builders. `worker/src/sync/alerts.ts` is the only thing that decides what a
streak means.

Codes and counts only: nothing here can hold a message or a response.
*/

import { all, one, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type { SyncFailureRow } from "../rows.ts";

export function makeSyncFailuresRepo(ctx: Ctx) {
  return {
    /**
    Count one failed attempt, and return the streak as it now stands.

    One statement, so two runs failing at once both count. `first_failed_at`
    is only written by the insert: it is when the streak began.
    */
    async fail(
      subject: string,
      check: SyncFailureRow["check_name"],
      errorCode: string,
    ): Promise<SyncFailureRow> {
      const now = ctx.now();
      const row = await one<SyncFailureRow>(
        ctx.db
          .prepare(
            `INSERT INTO sync_failures
               (subject, check_name, failures, first_failed_at, last_failed_at, last_error_code)
             VALUES (?, ?, 1, ?, ?, ?)
             ON CONFLICT (subject, check_name) DO UPDATE SET
               failures = failures + 1,
               last_failed_at = excluded.last_failed_at,
               last_error_code = excluded.last_error_code
             RETURNING *`,
          )
          .bind(subject, check, now, now, errorCode),
      );
      if (row === null) throw new Error("sync_failures row missing after upsert");
      return row;
    },

    /** The check worked: end its streak. True when there was one. */
    async clear(subject: string, check: SyncFailureRow["check_name"]): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare("DELETE FROM sync_failures WHERE subject = ? AND check_name = ?")
          .bind(subject, check),
      );
      return changes > 0;
    },

    /** Every streak a subject has running. */
    async listForSubject(subject: string): Promise<SyncFailureRow[]> {
      return all<SyncFailureRow>(
        ctx.db
          .prepare("SELECT * FROM sync_failures WHERE subject = ? ORDER BY check_name")
          .bind(subject),
      );
    },

    /** Forget a subject altogether: it was removed, or is no longer synced. */
    async clearSubject(subject: string): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM sync_failures WHERE subject = ?").bind(subject),
      );
      return changes;
    },
  };
}
