/**
The token bucket an MCP client's message refreshes are held to
(`mcp_message_refreshes`).

One row per health system: how many tokens were left, and when that was
worked out. The refill is continuous -- `tokens` is a REAL -- and is applied
lazily, by whichever statement next reads the row. It is in D1 for the same
reason `mcp_sync_requests` is: the limit has to hold across MCP sessions,
Durable Object evictions and deploys.

`take` is a single statement, so two calls arriving together cannot both
spend the last token: SQLite runs the upsert atomically, its `WHERE` decides,
and `changes` says who got it. The numbers are the caller's
(`worker/src/mcp/message-refresh.ts`), not this module's.
*/

import { all, run } from "../client.ts";

import type { Ctx } from "../client.ts";
import type {
  McpMessageRefreshEntry,
  McpMessageRefreshLimits,
  McpMessageRefreshRow,
} from "../rows.ts";

/**
The bucket's level at `excluded.updated_at`: the stored tokens plus what has
refilled since, never above capacity. A clock that went backwards earns
nothing rather than a negative refill. Placeholders: capacity, refillSeconds.
*/
const LEVEL = `MIN(?, mcp_message_refreshes.tokens
  + MAX(0, excluded.updated_at - mcp_message_refreshes.updated_at) * 1.0 / ?)`;

export function makeMcpMessageRefreshesRepo(ctx: Ctx) {
  return {
    /** One health system's bucket as last stored, or null when it was never used. */
    async get(healthSystemId: string): Promise<McpMessageRefreshEntry | null> {
      const rows = await all<McpMessageRefreshRow>(
        ctx.db
          .prepare("SELECT * FROM mcp_message_refreshes WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      const row = rows[0];
      return row === undefined ? null : { tokens: row.tokens, updatedAt: row.updated_at };
    },

    /**
    Spend one token, or change nothing.

    True means this caller may refresh, and the row now says one fewer token.
    False means the bucket is empty: nothing was written, and the caller reads
    the row to say when the next token arrives.
    */
    async take(
      healthSystemId: string,
      limits: McpMessageRefreshLimits,
      clientId: string | null,
    ): Promise<boolean> {
      const at = ctx.now();
      const { capacity, refillSeconds } = limits;
      const { changes } = await run(
        ctx.db
          .prepare(
            `INSERT INTO mcp_message_refreshes (health_system_id, tokens, updated_at, client_id)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (health_system_id) DO UPDATE SET
               tokens = ${LEVEL} - 1,
               updated_at = excluded.updated_at,
               client_id = excluded.client_id
             WHERE ${LEVEL} >= 1`,
          )
          .bind(
            healthSystemId,
            capacity - 1,
            at,
            clientId,
            capacity,
            refillSeconds,
            capacity,
            refillSeconds,
          ),
      );
      return changes > 0;
    },

    /**
    Give back a token that bought nothing: the refresh never reached the
    portal (another one held the gate, or there was nothing to read). Never
    above `capacity`.
    */
    async refund(healthSystemId: string, limits: McpMessageRefreshLimits): Promise<void> {
      await run(
        ctx.db
          .prepare(
            `UPDATE mcp_message_refreshes SET tokens = MIN(?, tokens + 1)
             WHERE health_system_id = ?`,
          )
          .bind(limits.capacity, healthSystemId),
      );
    },
  };
}
