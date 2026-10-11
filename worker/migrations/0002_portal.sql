-- Healthy: patient-portal sync (upcoming visits) support.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Same conventions as 0001_init.sql: INTEGER unix seconds (UTC), `_enc`
-- columns hold app-layer AES-GCM-256 ciphertext with the AAD bound to
-- `<table>.<column>.<rowId>`, and nothing here names an organisation, a
-- person, a host, or an endpoint. All of that arrives at runtime.

-- ---------------------------------------------------------------------------
-- One portal account per provider: the credentials the owner typed, the
-- cookie jar that survives between runs, and the health of that session.
--
-- The portal is a scrape, not an API, so everything about it is per-instance
-- and discovered at runtime: `base_url` is the origin the login page finally
-- settled on after redirects, `mount_path` the prefix that instance mounts
-- its app under (deployments vary: a named prefix, or no prefix at all).
-- ---------------------------------------------------------------------------
CREATE TABLE portal_accounts (
  provider_id         TEXT PRIMARY KEY REFERENCES providers (id) ON DELETE CASCADE,
  -- Origin only, e.g. 'https://host.example'. No path, no trailing slash.
  base_url            TEXT,
  -- Leading and trailing slash, e.g. '/Prefix/' -- or '/' when root-mounted.
  mount_path          TEXT,
  -- Sealed: the portal login. Never returned by any API, only written.
  username_enc        TEXT,
  password_enc        TEXT,
  -- Sealed JSON serialisation of the cookie jar, including the
  -- trust-this-device cookie that lets a later run skip the emailed code.
  cookie_jar_enc      TEXT,
  session_state       TEXT NOT NULL DEFAULT 'none',
  last_login_at       INTEGER,
  last_ok_at          INTEGER,
  -- An error *code*, never a message, and never portal markup.
  last_error_code     TEXT,
  -- Rate limit: at most a handful of login attempts per UTC day. The counter
  -- resets when `login_attempts_day` no longer matches the current day, which
  -- is why the day is stored alongside the count rather than inferred.
  login_attempts_today INTEGER NOT NULL DEFAULT 0,
  -- Whole UTC days since the epoch: floor(unixSeconds / 86400).
  login_attempts_day  INTEGER,
  needs_reauth_since  INTEGER,
  updated_at          INTEGER NOT NULL,
  CHECK (session_state IN ('none', 'active', 'needs_reauth')),
  CHECK (login_attempts_today >= 0),
  -- A live session always knows where it is talking to.
  CHECK (session_state <> 'active' OR (base_url IS NOT NULL AND mount_path IS NOT NULL))
);
CREATE INDEX portal_accounts_state ON portal_accounts (session_state);

-- ---------------------------------------------------------------------------
-- Inbound mail the Worker accepted, reduced to the few fields the sign-in
-- flow needs. Bodies are never stored: a one-time code is extracted, sealed,
-- and everything else is dropped on the floor.
--
--   'otp'            -- a login verification code
--   'forward_verify' -- the mail provider's own "confirm forwarding" code
--   'other'          -- accepted from an allowlisted sender, nothing extracted
--
-- Pruned by the scheduled handler; rows are useful for minutes, not days.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_inbox (
  id          TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  from_addr   TEXT NOT NULL,
  subject     TEXT,
  kind        TEXT NOT NULL,
  -- Sealed, and only ever set for 'otp' / 'forward_verify'.
  code_enc    TEXT,
  -- Single use: set the moment a code is handed to a sign-in attempt.
  consumed_at INTEGER,
  -- Short TTL, so a stolen mailbox is not a standing key. 10 minutes for otp.
  expires_at  INTEGER,
  -- Size of the message as received, for a sanity check in the admin UI.
  raw_size    INTEGER NOT NULL DEFAULT 0,
  CHECK (kind IN ('otp', 'forward_verify', 'other')),
  CHECK (raw_size >= 0),
  CHECK (kind <> 'other' OR code_enc IS NULL)
);
CREATE INDEX mail_inbox_received ON mail_inbox (received_at);
-- The poll the sign-in flow runs: newest unconsumed code of a kind.
CREATE INDEX mail_inbox_pending ON mail_inbox (kind, consumed_at, received_at);

-- ---------------------------------------------------------------------------
-- Calendar projection gains a provenance column, because the same visit can
-- be seen twice: once from the portal (upcoming only, available immediately)
-- and later as a FHIR Encounter. `source` plus `portal_csn` is what keeps the
-- two from being calendared twice.
--
-- Existing rows are all FHIR-sourced, which is why 'fhir' is the default.
-- For a portal visit the event_key is '<providerId>:csn:<csn>'.
--
-- SQLite cannot add a CHECK to an existing table, so the 'fhir' | 'portal'
-- domain of `source` is enforced in the repo layer rather than here.
-- ---------------------------------------------------------------------------
ALTER TABLE calendar_events ADD COLUMN source TEXT NOT NULL DEFAULT 'fhir';
ALTER TABLE calendar_events ADD COLUMN portal_csn TEXT;
CREATE INDEX calendar_events_source ON calendar_events (source, provider_id);
CREATE INDEX calendar_events_portal_csn ON calendar_events (provider_id, portal_csn);
