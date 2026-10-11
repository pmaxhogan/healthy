-- Healthy: blind the identifiers D1 compares, seal the personal values it only
-- stores, and stop the plaintext leftovers.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive, like every migration before it: nothing here is dropped, so the
-- previous deploy keeps working in the minute between this migration and the new
-- code going live. What SQL cannot do -- compute an HMAC or an AES-GCM seal -- is
-- done by the Worker itself, in `worker/sync/backfill.ts`, which runs at the head
-- of the next calendar sync and holds every sync back until it has finished.
-- The columns it leaves unused are dropped by a later migration.
--
-- See SECURITY.md, "Assets and where they live", for what each column now holds.

-- ---------------------------------------------------------------------------
-- The calendar row's readable half, sealed.
--
-- The sync has to know a row's start (the window, the "is it over yet" rule, the
-- start-time dedupe) and the real calendar its event lives on (to move or delete
-- it there). Both go into one sealed JSON value, bound to
-- `calendar_events.detail_enc.<google_event_id>`. `start_at` is written NULL from
-- now on and `calendar_id` holds a keyed blind of the calendar id, so the unique
-- index on (calendar_id, google_event_id) keeps working.
--
-- The index on `start_at` goes: no query filters or orders on a column that is
-- about to be NULL in every row.
-- ---------------------------------------------------------------------------
ALTER TABLE calendar_events ADD COLUMN detail_enc TEXT;
DROP INDEX IF EXISTS calendar_events_start;

-- `portal_visits.start_at` is redundant with the sealed payload and is written
-- as 0 from now on; its index is equally useless.
DROP INDEX IF EXISTS portal_visits_start;

-- ---------------------------------------------------------------------------
-- The legacy plaintext mail columns.
--
-- Rows written before 0005 still carry the sender and subject in the clear. The
-- sealed pair has been the source of truth since, and the plaintext pair is only
-- a fallback for exactly these rows -- which are expired OTPs by now. Blank them
-- here, in SQL, rather than wait for the 7-day purge. The columns themselves are
-- dropped by a later migration.
-- ---------------------------------------------------------------------------
UPDATE mail_inbox SET from_addr = '', subject = NULL
 WHERE from_addr <> '' OR subject IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The rate limiter's IP hashes.
--
-- These were unkeyed sha256 digests of an IPv4 address, which enumerate in
-- seconds. The limiter now keys them with an HMAC, so an old row would never be
-- matched again anyway; a rate-limit window restarting is harmless.
-- ---------------------------------------------------------------------------
DELETE FROM login_attempts;

-- ---------------------------------------------------------------------------
-- Progress of the Worker-side backfill, one row per one-shot data migration.
--
-- `lease_until` stops a manual sync and the cron from running the same backfill
-- at once. `progress_json` holds counts only.
-- ---------------------------------------------------------------------------
CREATE TABLE data_migrations (
  name          TEXT PRIMARY KEY,
  started_at    INTEGER,
  completed_at  INTEGER,
  lease_until   INTEGER,
  last_error    TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL
);
