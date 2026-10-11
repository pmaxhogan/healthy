-- Healthy: keep the files attached to secure messages, so the MCP can serve them.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: two new tables, nothing existing is rewritten.
--
-- The portal's attachment ids are per-session tokens, so a file can only be
-- fetched by the same portal pass that listed it, with the session it holds.
-- The pass fetches every attachment it has not stored yet and seals it here;
-- the MCP's `get_message_attachment` reads it back without talking to a portal.
--
-- `portal_message_attachments` is one row per attachment the pass tried to fetch:
--
--   - `attachment_key` is a keyed blind (worker/db/blind.ts) of the health system
--     id, the message's content digest and the attachment's position in the
--     message -- never a portal id.
--   - `meta_enc` is its name, file type, content type and size, sealed and
--     padded against `portal_message_attachments.meta_enc.<healthSystemId>:
--     <attachment_key>`.
--   - Plaintext on purpose: `state` ('stored', or 'failed' with a stable
--     `error_code`), `chunks`, `attempted_at` and `fetched_at` -- bookkeeping
--     that names no one.
--
-- `portal_message_attachment_chunks` holds a stored file's bytes: base64, cut
-- into pieces that each seal to well under D1's 2,000,000-byte value limit, each
-- sealed and padded against `portal_message_attachment_chunks.data_enc.
-- <healthSystemId>:<attachment_key>:<seq>`. Every piece of every file is kept:
-- there is no size ceiling.
--
-- Kept until the health system is deleted, like the messages themselves.
CREATE TABLE portal_message_attachments (
  health_system_id TEXT NOT NULL REFERENCES health_systems (id) ON DELETE CASCADE,
  attachment_key   TEXT NOT NULL,
  meta_enc         TEXT NOT NULL,
  state            TEXT NOT NULL,
  error_code       TEXT,
  chunks           INTEGER NOT NULL DEFAULT 0,
  attempted_at     INTEGER NOT NULL,
  fetched_at       INTEGER,
  PRIMARY KEY (health_system_id, attachment_key),
  CHECK (state IN ('stored', 'failed')),
  CHECK (state <> 'failed' OR error_code IS NOT NULL),
  CHECK (state <> 'stored' OR fetched_at IS NOT NULL)
);

CREATE TABLE portal_message_attachment_chunks (
  health_system_id TEXT NOT NULL,
  attachment_key   TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  data_enc         TEXT NOT NULL,
  PRIMARY KEY (health_system_id, attachment_key, seq),
  FOREIGN KEY (health_system_id, attachment_key)
    REFERENCES portal_message_attachments (health_system_id, attachment_key) ON DELETE CASCADE
);
