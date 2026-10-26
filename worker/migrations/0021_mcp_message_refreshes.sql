-- Healthy: the token bucket an MCP client's message refreshes are held to.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: one new table, nothing existing is rewritten.
--
-- The MCP tool `refresh_messages` re-reads one health system's patient-portal
-- secure messages on demand, which is what an assistant wants straight after
-- the owner sends or expects a message. A conversation asks for that a few
-- times in quick succession and then not for a while, so the limit is a token
-- bucket rather than a cooldown: a handful of refreshes at once, refilled at
-- a steady rate (worker/src/mcp/message-refresh.ts holds the numbers). One row
-- per health system, written by a single statement that either takes a token
-- or changes nothing (worker/src/db/repos/mcp-message-refreshes.ts), so it
-- holds across MCP sessions, Durable Object evictions and deploys.
--
-- Nothing in it is personal: this app's own health system id, a token count,
-- an instant, and the OAuth client id of the MCP client that last took a
-- token, the same value `mcp_audit.client_id` already holds in the clear.

CREATE TABLE mcp_message_refreshes (
  health_system_id TEXT PRIMARY KEY REFERENCES health_systems(id) ON DELETE CASCADE,
  -- Tokens left as of `updated_at`, fractional: the refill is continuous.
  tokens REAL NOT NULL,
  -- Unix seconds `tokens` was last worked out at.
  updated_at INTEGER NOT NULL,
  client_id TEXT
);
