-- Healthy: a connected organisation is a "health system", not a "provider".
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- In a medical app "provider" reads as a clinician; this schema's providers were
-- always organisations. Names only: no value changes meaning.
--
-- `ALTER TABLE ... RENAME TO` rewrites the REFERENCES clauses of every table that
-- points at the renamed one, and `RENAME COLUMN` rewrites the indexes, CHECK
-- constraints and foreign keys that name the column, so the foreign keys follow
-- without a rebuild. An index's own name cannot be changed in place, so the two
-- whose names say "provider" are dropped and recreated.
--
-- What does NOT change: the AAD strings sealed values were bound to
-- (`providers.client_secret_enc.<id>`, `providers.display_name.<id>`, ...). An AAD
-- is part of each ciphertext's authentication tag; renaming it would make every
-- sealed health-system column fail to open. The repos keep those strings frozen.

ALTER TABLE providers RENAME TO health_systems;

ALTER TABLE connections RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE oauth_states RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE fhir_cache RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE fhir_sync_state RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE calendar_events RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE portal_accounts RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE portal_visits RENAME COLUMN provider_id TO health_system_id;
ALTER TABLE mcp_audit RENAME COLUMN providers_json TO health_systems_json;

DROP INDEX providers_live;
CREATE INDEX health_systems_live ON health_systems (deleted_at, vendor);
DROP INDEX calendar_events_provider;
CREATE INDEX calendar_events_health_system ON calendar_events (health_system_id, state);

-- An alert's subject names what it is about: 'provider:<id>' becomes
-- 'health_system:<id>'. ('portal:<id>' and 'google' are unchanged.)
UPDATE alerts SET subject = 'health_system:' || substr(subject, length('provider:') + 1)
 WHERE subject LIKE 'provider:%';

-- A stored run summary counted "providers"; the code now reads "healthSystems".
UPDATE run_log
   SET summary_json = json_remove(
         json_set(summary_json, '$.healthSystems', json_extract(summary_json, '$.providers')),
         '$.providers')
 WHERE json_type(summary_json, '$.providers') IS NOT NULL;

-- The exposure rule type. SQLite cannot alter a CHECK, so the table is rebuilt:
-- nothing references mcp_policy, and its one index is recreated below.
CREATE TABLE mcp_policy_new (
  id         TEXT PRIMARY KEY,
  rule_type  TEXT NOT NULL,
  target     TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  CHECK (rule_type IN ('tool', 'resource', 'field', 'health_system'))
);
INSERT INTO mcp_policy_new (id, rule_type, target, note, created_at)
SELECT id, CASE rule_type WHEN 'provider' THEN 'health_system' ELSE rule_type END,
       -- A tool rule names a tool, and one tool was renamed with everything else.
       CASE WHEN rule_type = 'tool' AND target = 'list_providers'
            THEN 'list_health_systems' ELSE target END,
       note, created_at
  FROM mcp_policy;
DROP TABLE mcp_policy;
ALTER TABLE mcp_policy_new RENAME TO mcp_policy;
CREATE UNIQUE INDEX mcp_policy_rule ON mcp_policy (rule_type, target);
