-- Healthy: the cooldown an MCP client's sync requests are held to.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: one new table, nothing existing is rewritten.
--
-- The MCP tool `sync_health_systems` lets an assistant ask for a sync of a
-- health system. That causes outbound requests, so each (health system, kind
-- of sync) pair may be asked for only so often. The limit has to hold across
-- MCP sessions, Durable Object evictions and deploys, so it is a row here and
-- not a variable: one row per pair, written by a single statement that either
-- claims the slot or changes nothing (worker/src/db/repos/mcp-sync-requests.ts).
--
-- Nothing in it is personal: this app's own health system id, one of three
-- fixed words, instants and a counter. `client_id` is the OAuth client id of
-- the MCP client that last asked (or `admin-console`), the same value
-- `mcp_audit.client_id` already holds in the clear.

CREATE TABLE mcp_sync_requests (
  health_system_id TEXT NOT NULL REFERENCES health_systems(id) ON DELETE CASCADE,
  -- 'ordinary' | 'full' | 'portal'.
  kind TEXT NOT NULL CHECK (kind IN ('ordinary', 'full', 'portal')),
  -- Unix seconds of the last request that was let through.
  requested_at INTEGER NOT NULL,
  -- Whole UTC days since the epoch that `day_count` belongs to, and how many
  -- requests were let through on that day. The same shape as
  -- `portal_accounts.login_attempts_day`: the counter resets by comparison, so
  -- nothing has to clear it.
  day INTEGER NOT NULL,
  day_count INTEGER NOT NULL,
  client_id TEXT,
  PRIMARY KEY (health_system_id, kind)
);
