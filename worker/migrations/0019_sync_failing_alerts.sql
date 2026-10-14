-- Healthy: a third kind of alert, for a sync that keeps failing while its
-- connection is still authorised.
--
-- Until now an alert meant "the owner has to sign in again" (`reconnect`) or
-- "a phone's uploads were set aside" (`hc_parked`). A token endpoint that
-- answers 500 every hour, a health system whose searches all fail, a portal
-- whose pages stop parsing, a calendar that refuses writes: none of those is a
-- re-auth, so none of them raised anything, however long it lasted.
--
-- Two changes.
--
-- 1. `alerts` gets the wider CHECK and a `reason_code`: the stable error code
--    the alert was opened with, so the admin UI can say what is failing without
--    reading a card. NULL for every row written before this migration. SQLite
--    cannot alter a CHECK, so the table is rebuilt exactly as 0016 rebuilt it;
--    every row and both indexes carry over. Nothing references `alerts` by
--    foreign key.
--
-- 2. `sync_failures` is the streak a `sync_failing` alert is decided from: one
--    row per (subject, check) that is failing right now, counting consecutive
--    failed attempts. A success deletes the row, so the table holds only what is
--    currently failing and is empty when everything works.
--
--    `subject` is the `alerts.subject` the streak belongs to
--    ('health_system:<id>', 'portal:<id>', 'google', or 'sync' for a run that
--    stops before it reaches any of them). `check_name` is which pass of that
--    subject failed, because they run on different schedules and break
--    independently: 'calendar' and 'refresh' for a health system and for the
--    sync itself, 'visits' and 'messages' for a portal, 'calendar' for Google.
--    One counter per subject would let the hourly pass that still works reset
--    the streak of the four-hourly one that does not.
--
--    `connections.refresh_failures` is not reused for this: it is zeroed by
--    every successful token refresh, and a vendor whose access tokens live a few
--    minutes refreshes successfully at the head of every run whose sync then
--    fails, so the count would never get past one.
--
--    Codes and counts only. No message, no URL, nothing from a response.

CREATE TABLE alerts_new (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  -- 'health_system:<id>', 'portal:<id>', 'google', 'sync', or 'device:<id>'.
  subject        TEXT NOT NULL,
  trello_card_id TEXT,
  opened_at      INTEGER NOT NULL,
  resolved_at    INTEGER,
  -- A stable error *code*, never a message.
  reason_code    TEXT,
  CHECK (kind IN ('reconnect', 'hc_parked', 'sync_failing'))
);
INSERT INTO alerts_new (id, kind, subject, trello_card_id, opened_at, resolved_at)
  SELECT id, kind, subject, trello_card_id, opened_at, resolved_at FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
CREATE UNIQUE INDEX alerts_open_subject ON alerts (subject) WHERE resolved_at IS NULL;
CREATE INDEX alerts_opened ON alerts (opened_at);

CREATE TABLE sync_failures (
  subject         TEXT NOT NULL,
  check_name      TEXT NOT NULL,
  failures        INTEGER NOT NULL,
  first_failed_at INTEGER NOT NULL,
  last_failed_at  INTEGER NOT NULL,
  -- The code of the most recent failure. A code, never a message.
  last_error_code TEXT NOT NULL,
  PRIMARY KEY (subject, check_name),
  CHECK (failures > 0),
  CHECK (check_name IN ('calendar', 'refresh', 'visits', 'messages'))
) WITHOUT ROWID;
