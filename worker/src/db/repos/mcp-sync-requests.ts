/**
 * The cooldown an MCP client's sync requests are held to (`mcp_sync_requests`).
 *
 * One row per (health system, kind of sync), holding when a request was last
 * let through and how many were let through that UTC day. It is in D1 because
 * the limit has to hold across MCP sessions, Durable Object evictions and
 * deploys: a counter in memory would reset whenever a client reconnected, which
 * is exactly when a looping client would benefit.
 *
 * `claim` is a single statement, so two calls arriving together cannot both
 * read "nothing recent" and both go ahead: SQLite runs the upsert atomically,
 * its `WHERE` decides, and `changes` says which caller got the slot. The
 * numbers are the caller's (`worker/src/mcp/sync-request.ts`), not this
 * module's.
 */

import { utcDayNumber } from "../../lib/time.ts";
import { all, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type {
  McpSyncKind,
  McpSyncRequestEntry,
  McpSyncRequestLimits,
  McpSyncRequestRow,
} from "../rows.ts";

export function makeMcpSyncRequestsRepo(ctx: Ctx) {
  return {
    /** Every pair's history for one kind of sync. A handful of rows. */
    async list(kind: McpSyncKind): Promise<McpSyncRequestEntry[]> {
      const rows = await all<McpSyncRequestRow>(
        ctx.db.prepare("SELECT * FROM mcp_sync_requests WHERE kind = ?").bind(kind),
      );
      return rows.map((row) => ({
        healthSystemId: row.health_system_id,
        kind: row.kind,
        requestedAt: row.requested_at,
        day: row.day,
        dayCount: row.day_count,
      }));
    },

    /**
     * Take the slot for one request, or change nothing.
     *
     * True means this caller may start the sync, and the row now says so. False
     * means the pair is inside its cooldown or has spent its day: nothing was
     * written, and the caller reads the row to say when it may ask again.
     */
    async claim(
      healthSystemId: string,
      kind: McpSyncKind,
      limits: McpSyncRequestLimits,
      clientId: string | null,
    ): Promise<boolean> {
      const at = ctx.now();
      const day = utcDayNumber(at);
      const { changes } = await run(
        ctx.db
          .prepare(
            `INSERT INTO mcp_sync_requests
               (health_system_id, kind, requested_at, day, day_count, client_id)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT (health_system_id, kind) DO UPDATE SET
               requested_at = excluded.requested_at,
               day_count = CASE WHEN mcp_sync_requests.day = excluded.day
                                THEN mcp_sync_requests.day_count + 1 ELSE 1 END,
               day = excluded.day,
               client_id = excluded.client_id
             WHERE mcp_sync_requests.requested_at + ? <= excluded.requested_at
               AND (mcp_sync_requests.day <> excluded.day OR mcp_sync_requests.day_count < ?)`,
          )
          .bind(healthSystemId, kind, at, day, clientId, limits.cooldownSeconds, limits.dailyLimit),
      );
      return changes > 0;
    },
  };
}
