-- Healthy: record the optional `jq` program on each MCP audit row.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- A fingerprint, never the program: a jq filter can carry clinical content as a
-- literal (`select(.code | test("..."))`), and this table's invariant is that it
-- has nowhere to put content. So the row keeps the program's SHA-256 and length,
-- and how many items went into it and came out. All four are NULL on a call that
-- passed no `jq`; the counts are also NULL when the program failed or never ran.

ALTER TABLE mcp_audit ADD COLUMN jq_sha256 TEXT;
ALTER TABLE mcp_audit ADD COLUMN jq_length INTEGER;
ALTER TABLE mcp_audit ADD COLUMN jq_input_count INTEGER;
ALTER TABLE mcp_audit ADD COLUMN jq_output_count INTEGER;
