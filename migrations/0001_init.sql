-- Healthy: initial schema.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it. Workers Builds runs
-- `npm run migrate:remote && wrangler deploy`, in that order, for the same
-- reason: `wrangler deploy` on its own never applies migrations.
--
-- Conventions used throughout:
--   * Timestamps are INTEGER unix seconds (UTC). The display timezone is a
--     user setting in `settings`, never a column and never in code.
--   * A `_enc` suffix means the column holds an app-layer AES-GCM-256
--     ciphertext produced by seal()/open(): "v1:" + base64url(iv || ct), with
--     the AAD bound to `<table>.<column>.<rowId>`. D1 encryption at rest is
--     not sufficient on its own for tokens, patient identifiers, or cached
--     clinical payloads, and the AAD binding stops a ciphertext being moved
--     between rows or columns.
--   * Nothing in this file names a provider, an organisation, a person, or an
--     endpoint. All of that arrives at runtime.

-- ---------------------------------------------------------------------------
-- Global configuration, editable from the admin UI.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Connected health systems. One row per org the owner has linked.
-- ---------------------------------------------------------------------------
CREATE TABLE providers (
  id                TEXT PRIMARY KEY,
  vendor            TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  -- Key into the slimmed open.epic brands index (data/epic-brands.json).
  brand_key         TEXT,
  fhir_base_url     TEXT NOT NULL,
  portal_url        TEXT,
  environment       TEXT NOT NULL DEFAULT 'prod',
  -- Per-org confidential-client secret. Sealed: never readable from a D1 dump.
  client_secret_enc TEXT,
  -- Per-provider overrides: title_template, color_id, arrival_offset_min,
  -- arrival_offsets_by_visit_type, org_short, enabled.
  config_json       TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- Soft delete: sync stops, but calendar_events history stays joinable.
  deleted_at        INTEGER,
  CHECK (environment IN ('prod', 'sandbox'))
);
CREATE INDEX providers_live ON providers (deleted_at, vendor);

-- ---------------------------------------------------------------------------
-- OAuth state per provider. At most one connection per provider.
-- ---------------------------------------------------------------------------
CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL UNIQUE REFERENCES providers (id) ON DELETE CASCADE,
  patient_fhir_id_enc TEXT,
  access_token_enc    TEXT,
  access_expires_at   INTEGER,
  refresh_token_enc   TEXT,
  scope               TEXT,
  status              TEXT NOT NULL DEFAULT 'disconnected',
  last_refresh_at     INTEGER,
  last_sync_at        INTEGER,
  last_full_refresh_at INTEGER,
  -- An error *code*, never a message: messages can carry upstream detail.
  last_error_code     TEXT,
  needs_reauth_since  INTEGER,
  refresh_failures    INTEGER NOT NULL DEFAULT 0,
  -- Single-flight token refresh. A caller wins the lease by CAS on
  -- lease_expires_at; everyone else waits and re-reads.
  lease_owner         TEXT,
  lease_expires_at    INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (status IN ('connected', 'needs_reauth', 'error', 'disconnected')),
  CHECK (refresh_failures >= 0)
);
CREATE INDEX connections_status ON connections (status);

-- ---------------------------------------------------------------------------
-- The single Google account events are written to. Exactly one row, id = 1.
-- ---------------------------------------------------------------------------
CREATE TABLE google_account (
  id                 INTEGER PRIMARY KEY,
  email_enc          TEXT,
  access_token_enc   TEXT,
  access_expires_at  INTEGER,
  refresh_token_enc  TEXT,
  scope              TEXT,
  status             TEXT NOT NULL DEFAULT 'disconnected',
  last_refresh_at    INTEGER,
  needs_reauth_since INTEGER,
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  connected_at       INTEGER,
  updated_at         INTEGER NOT NULL,
  CHECK (id = 1),
  CHECK (status IN ('connected', 'needs_reauth', 'error', 'disconnected'))
);

-- ---------------------------------------------------------------------------
-- In-flight authorization requests (CSRF state + PKCE verifier).
-- Short-lived; pruned on write and by the scheduled handler.
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_states (
  state             TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  provider_id       TEXT REFERENCES providers (id) ON DELETE CASCADE,
  code_verifier_enc TEXT NOT NULL,
  redirect_after    TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  CHECK (kind IN ('epic', 'google')),
  -- An Epic authorization is always against a specific provider; a Google one
  -- never is.
  CHECK ((kind = 'epic') = (provider_id IS NOT NULL))
);
CREATE INDEX oauth_states_expiry ON oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- Read cache of normalised-on-read FHIR resources. Feeds the MCP so a tool
-- call never has to reach an upstream org synchronously.
-- ---------------------------------------------------------------------------
CREATE TABLE fhir_cache (
  provider_id   TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  -- The whole resource, sealed. This is the PHI-bearing column.
  payload_enc   TEXT NOT NULL,
  -- sha256 of the plaintext, so an unchanged refresh is a cheap no-op.
  content_hash  TEXT NOT NULL,
  last_updated  INTEGER,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (provider_id, resource_type, resource_id)
);
CREATE INDEX fhir_cache_type ON fhir_cache (resource_type, provider_id);
CREATE INDEX fhir_cache_expiry ON fhir_cache (expires_at);

-- Per (provider, resource type) health of the daily full refresh.
CREATE TABLE fhir_sync_state (
  provider_id     TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL,
  last_full_at    INTEGER,
  last_ok         INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  -- OperationOutcome codes the org returned (4119, 4101, ...), counts only.
  warnings_json   TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (provider_id, resource_type),
  CHECK (last_ok IN (0, 1))
);

-- ---------------------------------------------------------------------------
-- Calendar projection. The sync's own bookkeeping of what it has written.
--
-- Invariant enforced in code and asserted in tests: sync only ever touches
-- Google events carrying extendedProperties.private.healthy = "1".
-- ---------------------------------------------------------------------------
CREATE TABLE calendar_events (
  -- '<providerId>:<encounterId>', also written to the Google event as
  -- extendedProperties.private.key so the two can be re-paired after a
  -- local data loss.
  event_key       TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  encounter_id    TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  -- sha256 of the mapped event fields; a change here is what triggers a patch.
  fingerprint     TEXT NOT NULL,
  -- 'ghost' = vanished upstream or cancelled. Ghosts are never deleted.
  state           TEXT NOT NULL DEFAULT 'active',
  start_at        INTEGER,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  ghosted_at      INTEGER,
  updated_at      INTEGER NOT NULL,
  CHECK (state IN ('active', 'ghost')),
  CHECK ((state = 'ghost') = (ghosted_at IS NOT NULL))
);
CREATE INDEX calendar_events_provider ON calendar_events (provider_id, state);
CREATE INDEX calendar_events_start ON calendar_events (start_at);
CREATE UNIQUE INDEX calendar_events_google ON calendar_events (calendar_id, google_event_id);

-- ---------------------------------------------------------------------------
-- Outbound re-auth alerts. One open row per subject at a time.
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  -- 'provider:<id>' or 'google'.
  subject        TEXT NOT NULL,
  trello_card_id TEXT,
  opened_at      INTEGER NOT NULL,
  resolved_at    INTEGER,
  CHECK (kind IN ('reconnect'))
);
-- The dedupe guarantee: at most one unresolved alert per subject. SQLite
-- treats NULLs as distinct in a plain unique index, so the partial index is
-- what actually enforces it.
CREATE UNIQUE INDEX alerts_open_subject ON alerts (subject) WHERE resolved_at IS NULL;
CREATE INDEX alerts_opened ON alerts (opened_at);

-- ---------------------------------------------------------------------------
-- MCP audit trail. Metadata only -- deliberately no room for content.
-- Pruned beyond 365 days by the scheduled handler.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_audit (
  id             TEXT PRIMARY KEY,
  ts             INTEGER NOT NULL,
  client_id      TEXT,
  grant_id       TEXT,
  tool           TEXT NOT NULL,
  providers_json TEXT NOT NULL DEFAULT '[]',
  result_count   INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER NOT NULL DEFAULT 1,
  error_code     TEXT,
  duration_ms    INTEGER,
  CHECK (ok IN (0, 1)),
  CHECK (result_count >= 0)
);
CREATE INDEX mcp_audit_ts ON mcp_audit (ts);
CREATE INDEX mcp_audit_tool ON mcp_audit (tool, ts);

-- Exposure deny-list. Absent a matching rule, data is exposed; a rule removes
-- it. Enforced at one server-side choke point before serialisation.
CREATE TABLE mcp_policy (
  id         TEXT PRIMARY KEY,
  rule_type  TEXT NOT NULL,
  target     TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  CHECK (rule_type IN ('tool', 'resource', 'field', 'provider'))
);
CREATE UNIQUE INDEX mcp_policy_rule ON mcp_policy (rule_type, target);

-- ---------------------------------------------------------------------------
-- Scheduled/manual run history. Counts and codes only, never PHI.
-- ---------------------------------------------------------------------------
CREATE TABLE run_log (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  ok           INTEGER,
  summary_json TEXT NOT NULL DEFAULT '{}',
  CHECK (kind IN ('calendar', 'full', 'refresh', 'manual')),
  CHECK (ok IS NULL OR ok IN (0, 1))
);
CREATE INDEX run_log_started ON run_log (started_at);
CREATE INDEX run_log_kind ON run_log (kind, started_at);

-- ---------------------------------------------------------------------------
-- Password-gate rate limiting. Keyed by a salted hash of the client IP: the
-- raw address is never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE login_attempts (
  ip_hash      TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  CHECK (count >= 0)
);

-- ---------------------------------------------------------------------------
-- Seed rows that must exist for the code to have something to update.
-- ---------------------------------------------------------------------------
INSERT INTO google_account (id, status, updated_at) VALUES (1, 'disconnected', unixepoch());
