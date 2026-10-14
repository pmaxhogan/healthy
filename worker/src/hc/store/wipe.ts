/**
Wiping a device: every Health Connect row it has, then the device row.

Every table hangs off `devices` with `ON DELETE CASCADE`, so deleting the
device row alone would be correct -- and, for a phone with a year of
history, one statement deleting millions of rows, which D1 will not finish.
So the tables are emptied in bounded slices first and the device row goes
last, when there is nothing left for the cascade to do.

`wipeDevice` does one bounded pass and says whether it finished; the caller
calls it again until it has. It is safe to call at any point and any number
of times, including for a device that is already gone.

The device is revoked first, so no upload can refill the queue between
passes, and the queue is emptied first, so the ingest runner finds nothing
to apply. A runner slice that was already under way can still write a few
rows after their table was emptied; the cascade takes those, and once the
device row is gone its foreign key refuses any more. The runner's own stored
job and alarm are cleared last of all.

The tables are WITHOUT ROWID, and SQLite has no `DELETE ... LIMIT` here, so
a slice is "the rows whose primary key is among the first N".
*/

import { run } from "../../db/client.ts";
import { makeDevicesRepo } from "../../db/repos/devices.ts";
import { errorFields } from "../../lib/log.ts";
import { resolveParkedAlert } from "../../sync/alerts.ts";

import type { Ctx } from "../../db/client.ts";
import type { SyncDeps } from "../../sync/deps.ts";

interface WipeTable {
  table: string;
  /** Primary-key columns after `device_id`, or the rowid for a rowid table. */
  key: readonly string[];
  /** Rows per statement: fewer where each row carries a payload. */
  slice: number;
}

/** Queue first, device-facing bookkeeping last: see the module comment. */
const WIPE_TABLES: readonly WipeTable[] = [
  { table: "hc_ingest_queue", key: ["seq"], slice: 20 },
  { table: "hc_dirty", key: ["kind", "key"], slice: 5000 },
  { table: "hc_chunks", key: ["record_type", "origin_hash", "hour_utc", "part"], slice: 300 },
  { table: "hc_rollup_hour", key: ["record_type", "origin_hash", "hour_utc"], slice: 2000 },
  { table: "hc_rollup_day", key: ["record_type", "origin_hash", "day"], slice: 2000 },
  { table: "hc_hr_minute", key: ["origin_hash", "hour_utc"], slice: 1000 },
  { table: "hc_sleep_night", key: ["record_id_blind"], slice: 1000 },
  { table: "hc_exercise_session", key: ["record_id_blind"], slice: 1000 },
  { table: "hc_record_index", key: ["record_id_blind"], slice: 5000 },
  { table: "hc_platform_stale", key: ["record_type", "hour_utc"], slice: 5000 },
  // One row a device: any column of it will do as the key.
  { table: "hc_platform_scan", key: ["record_type"], slice: 5000 },
  { table: "hc_sync_state", key: ["record_type"], slice: 5000 },
  { table: "hc_ingest_log", key: ["batch_id"], slice: 5000 },
];

/** Delete statements one pass may issue, and how long it may take. */
const MAX_STATEMENTS = 40;
const MAX_MS = 10_000;

export interface WipeOptions {
  /** Overrides how many deleting statements one pass may issue. */
  maxStatements?: number;
  /** The alert channel's test seam: its Trello transport and origin. */
  deps?: SyncDeps;
}

/** What one pass may spend, and has spent so far. */
interface WipePass {
  maxStatements: number;
  statements: number;
  startedAt: number;
}

/** Empty one table, a slice at a time. False when the pass ran out first. */
async function emptyTable(
  ctx: Ctx,
  deviceId: string,
  { table, key, slice }: WipeTable,
  pass: WipePass,
): Promise<boolean> {
  const columns = key.join(", ");
  for (;;) {
    if (pass.statements >= pass.maxStatements || Date.now() - pass.startedAt >= MAX_MS) {
      return false;
    }
    const { changes } = await run(
      ctx.db
        .prepare(
          `DELETE FROM ${table} WHERE device_id = ?1 AND (${columns}) IN
             (SELECT ${columns} FROM ${table} WHERE device_id = ?1 LIMIT ?2)`,
        )
        .bind(deviceId, slice),
    );
    // Only a statement that deleted something counts against the pass, so a
    // pass always gets beyond the tables that are already empty.
    if (changes > 0) pass.statements += 1;
    if (changes < slice) return true;
  }
}

/**
One bounded pass of a device wipe. `done: false` means rows remain and the
caller should call again.
*/
export async function wipeDevice(
  ctx: Ctx,
  deviceId: string,
  options: WipeOptions = {},
): Promise<{ done: boolean }> {
  const devices = makeDevicesRepo(ctx);
  await devices.revoke(deviceId);

  const pass: WipePass = {
    maxStatements: options.maxStatements ?? MAX_STATEMENTS,
    statements: 0,
    startedAt: Date.now(),
  };
  for (const table of WIPE_TABLES) {
    if (!(await emptyTable(ctx, deviceId, table, pass))) return { done: false };
  }
  await devices.delete(deviceId);
  // Last: the device's runner forgets its job and its alarm, so nothing wakes
  // later to work for a device that is gone. A failure here loses nothing --
  // an alarm that does fire finds an empty queue, and the device row's
  // foreign key refuses any write -- so it is logged, not thrown.
  try {
    await ctx.env.HC_INGEST.getByName(deviceId).reset();
  } catch (error) {
    ctx.log.warn("hc.runner_reset_failed", { deviceId, ...errorFields(error) });
  }
  // Its parked batches went with everything else, so the alert about them is
  // over. Never throws.
  await resolveParkedAlert(ctx, deviceId, options.deps);
  ctx.log.info("hc.device_wiped", { deviceId });
  return { done: true };
}
