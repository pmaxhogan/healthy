-- Healthy: keep the patient portals' secure messages, so the MCP can serve them.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: two new tables, nothing existing is rewritten.
--
-- `portal_messages` is one row per message the portal pass read from a Message
-- Center, every folder, every conversation, every message in each. Nothing about
-- a message is stored in the clear:
--
--   - `message_key` and `thread_key` are keyed blinds (worker/db/blind.ts) of the
--     health system id and a digest of the message's own content -- its delivery
--     instant, author role and text, and its thread's subject and first message.
--     Content, not the portal's ids: those are per-session tokens that may not
--     survive a new sign-in.
--   - `payload_enc` is the parsed message and its thread's details (subject,
--     folder, care team, body as plain text -- never portal markup), sealed and
--     padded, with the AAD bound to `portal_messages.payload_enc.<healthSystemId>:
--     <message_key>`. A payload lifted from one row to another's fails to open.
--   - `content_hash` is a keyed digest of the payload, so an unchanged message is
--     not re-sealed every hour.
--
-- Plaintext on purpose: `state` ('active', or 'missing' for a message the
-- portal's own organisation stopped listing), `missing_since` and `fetched_at` --
-- bookkeeping that names no one. Messages are kept until the health system is
-- deleted: there is no expiry, because a message is part of the record.
CREATE TABLE portal_messages (
  health_system_id TEXT NOT NULL REFERENCES health_systems (id) ON DELETE CASCADE,
  message_key      TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  payload_enc      TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'active',
  missing_since    INTEGER,
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY (health_system_id, message_key),
  CHECK (state IN ('active', 'missing')),
  CHECK (state <> 'missing' OR missing_since IS NOT NULL)
);
CREATE INDEX portal_messages_thread ON portal_messages (health_system_id, thread_key);

-- One row per health system: how the last Message Center read went, so an MCP
-- answer can say whether its messages are current (`coverage`) rather than let
-- an empty inbox pass for a failing one. Counts and a stable error code only.
CREATE TABLE portal_message_sync (
  health_system_id TEXT PRIMARY KEY REFERENCES health_systems (id) ON DELETE CASCADE,
  last_attempt_at  INTEGER NOT NULL,
  last_ok_at       INTEGER,
  last_error_code  TEXT,
  complete         INTEGER NOT NULL DEFAULT 1,
  threads          INTEGER NOT NULL DEFAULT 0,
  messages         INTEGER NOT NULL DEFAULT 0,
  CHECK (complete IN (0, 1))
);
