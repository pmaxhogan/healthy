-- Healthy: a second kind of source. A phone running the companion app pushes
-- its Health Connect records here, and the MCP serves them with the phone off.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- New tables, plus one rebuild at the very end: `alerts` gets a wider CHECK,
-- which SQLite can only do by copying the table. Every existing row and index
-- carries over; nothing else that exists is touched. A device is NOT a
-- health system and gets no `health_systems` row; the MCP names it
-- `device:<id>` wherever a health system id would go.
--
-- The rule for every table below is the one the rest of the schema follows:
-- nothing clinical is a clear column. What is clear is what D1 has to compare
-- or sort -- this app's own row ids, record TYPE names (they are the Health
-- Connect SDK's class names, the same for every user), instants, counts and
-- bookkeeping. Every value, every origin app's package name and every device
-- description lives inside a sealed payload. Bulk payloads are gzip-compressed
-- JSON sealed as bytes (`sealBytes`, worker/src/db/crypto.ts), a `v3:` text
-- envelope, with the AAD bound to the table, the column and the row's key.
--
-- Record ids and origin package names are keyed blinds (worker/src/db/blind.ts),
-- scoped to the device: equal values still compare equal and still hit the
-- index, but a snapshot carries neither Health Connect's ids nor the names of
-- the apps on the owner's phone.

-- One row per paired phone. The bearer token is shown once when it is minted
-- and never stored: `token_hash` is the SHA-256 of it (the token is 256 random
-- bits, so an unkeyed digest is not a confirmation oracle here). Revoking keeps
-- the row, so data already uploaded keeps its source; wiping deletes the row
-- and everything that hangs off it.
CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  name_enc          TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  rotated_at        INTEGER,
  revoked_at        INTEGER,
  last_seen_at      INTEGER,
  last_upload_at    INTEGER,
  app_version       TEXT,
  -- The phone's own report of its sync health (permissions, token ages,
  -- backfill progress, battery exemption), sealed: it names record types the
  -- owner granted or refused.
  sync_state_enc    TEXT,
  -- The ingest rate limiter's fixed window: when it opened and what it has seen.
  rate_window_start INTEGER NOT NULL DEFAULT 0,
  rate_window_count INTEGER NOT NULL DEFAULT 0
);

-- Batches the ingest route has accepted and not yet applied. The route's whole
-- job is to authenticate, bound, validate and seal a batch into this table and
-- answer; an alarm-driven Durable Object applies it. `seq` orders batches
-- strictly per device, which is what makes a delete that follows an upsert
-- land after it. A body larger than one row may hold is split into `parts`.
-- Rows are deleted once applied, so this table is empty at rest -- except for
-- a batch that could not be applied. The phone was told that batch was
-- accepted and has moved its cursor past it, so its body is the only copy of
-- those records: it is set aside (`parked_at`) rather than deleted, stops
-- blocking the batches behind it, and can be put back in the queue from the
-- Phone page once whatever stopped it is fixed.
CREATE TABLE hc_ingest_queue (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  batch_id    TEXT NOT NULL,
  part        INTEGER NOT NULL,
  parts       INTEGER NOT NULL,
  body_bytes  INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  parked_at   INTEGER,
  -- Last, so the depth and ordering queries never walk a megabyte of body.
  body_enc    TEXT NOT NULL,
  UNIQUE (device_id, batch_id, part),
  CHECK (part >= 0 AND part < parts)
);
CREATE INDEX hc_ingest_queue_device ON hc_ingest_queue (device_id, parked_at, seq);

-- One row per batch, kept: what arrived, what became of it. Counts, durations
-- and a stable error code only. It is also the idempotency record -- a batch id
-- seen before is acknowledged again and not queued twice -- provided it is the
-- same batch: `body_digest` is a keyed digest of the body, so a batch id reused
-- for different content is refused rather than acknowledged and dropped.
-- `run_log` is not reused because its `kind` CHECK would have to be widened for
-- a thing that is not a sync run.
CREATE TABLE hc_ingest_log (
  device_id     TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  batch_id      TEXT NOT NULL,
  body_digest   TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  applied_at    INTEGER,
  status        TEXT NOT NULL DEFAULT 'queued',
  error_code    TEXT,
  upserts       INTEGER NOT NULL DEFAULT 0,
  deletes       INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  applied       INTEGER NOT NULL DEFAULT 0,
  superseded    INTEGER NOT NULL DEFAULT 0,
  removed       INTEGER NOT NULL DEFAULT 0,
  body_bytes    INTEGER NOT NULL DEFAULT 0,
  raw_bytes     INTEGER NOT NULL DEFAULT 0,
  phone_time    INTEGER,
  apply_ms      INTEGER,
  PRIMARY KEY (device_id, batch_id),
  CHECK (status IN ('queued', 'applying', 'applied', 'failed'))
);
CREATE INDEX hc_ingest_log_received ON hc_ingest_log (device_id, received_at);

-- The lossless store: every record of one type from one origin app that STARTS
-- in one UTC hour, as one sealed row. A change rewrites one chunk. A record
-- that runs past its hour (a night of sleep) still lives in the chunk of its
-- start; `max_end_ms` is what lets a range read find it. `content_hash` is a
-- keyed digest of the payload, so an unchanged chunk is not re-sealed.
CREATE TABLE hc_chunks (
  device_id    TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_type  TEXT NOT NULL,
  origin_hash  TEXT NOT NULL,
  hour_utc     INTEGER NOT NULL,
  -- 0 for nearly every chunk. A payload too large for one D1 value is cut into
  -- consecutive parts; parts above 0 carry `record_count` 0 and the same
  -- instants and `content_hash` as part 0, so counts sum correctly and any
  -- range predicate that finds a chunk finds all of it.
  part         INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL,
  min_start_ms INTEGER NOT NULL,
  max_end_ms   INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- Last on purpose, here and in every table below: SQLite stores a row's
  -- columns in order and spills a large value onto overflow pages, so any
  -- column AFTER the payload can only be read by walking that payload. Kept
  -- last, the counts and instants beside it are read without touching it.
  payload_enc  TEXT NOT NULL,
  PRIMARY KEY (device_id, record_type, origin_hash, hour_utc, part),
  CHECK (part >= 0)
) WITHOUT ROWID;
CREATE INDEX hc_chunks_range ON hc_chunks (device_id, record_type, hour_utc);
-- Only the chunks holding a record that runs past its own hour: what a range
-- read needs to find a night of sleep that started before the window, without
-- walking every earlier chunk of the type. Partial, so it stays tiny -- nearly
-- every chunk ends inside its hour and is not in it.
CREATE INDEX hc_chunks_spill ON hc_chunks (device_id, record_type, origin_hash, max_end_ms)
  WHERE max_end_ms >= (hour_utc + 1) * 3600000;

-- Record id -> the chunk that holds it. Health Connect reports a deletion as an
-- id and nothing else, and an edit may move a record to another hour; both
-- need this. A deleted id keeps its row as a tombstone (`deleted_at`): ids are
-- never reused, so an upsert that arrives late for a deleted record is dropped.
CREATE TABLE hc_record_index (
  record_id_blind TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_type     TEXT NOT NULL,
  origin_hash     TEXT NOT NULL,
  hour_utc        INTEGER NOT NULL,
  deleted_at      INTEGER
) WITHOUT ROWID;
CREATE INDEX hc_record_index_device ON hc_record_index (device_id);

-- Pre-aggregates, maintained when a chunk is written, so a year of daily steps
-- is a few hundred small rows instead of every interval the phone ever wrote.
-- All sealed: an hourly step count is as clinical as the records it sums.

-- Per (type, origin, UTC hour): n, sum, min, max, mean, first, last per field.
CREATE TABLE hc_rollup_hour (
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_type TEXT NOT NULL,
  origin_hash TEXT NOT NULL,
  hour_utc    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  payload_enc TEXT NOT NULL,
  PRIMARY KEY (device_id, record_type, origin_hash, hour_utc)
) WITHOUT ROWID;
CREATE INDEX hc_rollup_hour_range ON hc_rollup_hour (device_id, record_type, hour_utc);

-- Per (type, origin, calendar day in the configured default time zone). `day`
-- is a civil date (`YYYY-MM-DD`). `tz_digest` is a keyed digest of the zone the
-- row was built for -- never the zone's name -- so a change of the `timezone`
-- setting is detectable and every row built for the old zone is rebuilt.
CREATE TABLE hc_rollup_day (
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_type TEXT NOT NULL,
  origin_hash TEXT NOT NULL,
  day         TEXT NOT NULL,
  tz_digest   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  payload_enc TEXT NOT NULL,
  PRIMARY KEY (device_id, record_type, origin_hash, day)
) WITHOUT ROWID;
CREATE INDEX hc_rollup_day_range ON hc_rollup_day (device_id, record_type, day);

-- Heart rate at one-minute resolution: one row per (origin, UTC hour) holding
-- up to sixty minute buckets (n, min, max, mean, time-weighted). One row per
-- hour rather than per minute, which is sixty times fewer rows to write and read.
CREATE TABLE hc_hr_minute (
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  origin_hash TEXT NOT NULL,
  hour_utc    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  payload_enc TEXT NOT NULL,
  PRIMARY KEY (device_id, origin_hash, hour_utc)
) WITHOUT ROWID;
CREATE INDEX hc_hr_minute_range ON hc_hr_minute (device_id, hour_utc);

-- One row per sleep session: stage minutes, the overnight heart-rate and HRV
-- joins, the HR-checked wake. Keyed by the session's blinded record id; the
-- instants are clear so a range of nights is an index scan.
CREATE TABLE hc_sleep_night (
  device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_id_blind TEXT NOT NULL,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  payload_enc     TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id_blind)
) WITHOUT ROWID;
CREATE INDEX hc_sleep_night_range ON hc_sleep_night (device_id, start_ms);

-- One row per exercise session: duration, joined heart rate, steps, distance
-- and energy, overlap merges and the left-running flag.
CREATE TABLE hc_exercise_session (
  device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_id_blind TEXT NOT NULL,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  payload_enc     TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id_blind)
) WITHOUT ROWID;
CREATE INDEX hc_exercise_session_range ON hc_exercise_session (device_id, start_ms);

-- The rebuild work list. Applying a batch marks what it touched -- a local day,
-- a sleep night, an exercise session -- and the runner rebuilds each once the
-- queue is empty, so a month of backfill rebuilds a day once, not per batch.
-- `kind` and `key` are this app's own vocabulary: a kind names what to rebuild,
-- and a key is a UTC hour with a type, an origin blind with an hour, or a
-- blinded record id. A mark whose source will not open is kept under a
-- `parked:` kind rather than retried for ever.
CREATE TABLE hc_dirty (
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  key       TEXT NOT NULL,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, kind, key)
) WITHOUT ROWID;

-- Per (device, record type): what the phone may read and what has arrived, so
-- an MCP answer can tell "not permitted", "permitted, no data" and "stale"
-- apart from an empty list. Clear on purpose: permission states, instants and
-- counts, the same bookkeeping `fhir_sync_state` keeps in the clear.
CREATE TABLE hc_sync_state (
  device_id        TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_type      TEXT NOT NULL,
  permission_state TEXT NOT NULL DEFAULT 'unknown',
  first_ms         INTEGER,
  last_ms          INTEGER,
  record_count     INTEGER NOT NULL DEFAULT 0,
  last_upload_at   INTEGER,
  token_age_s      INTEGER,
  backlog          INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  backfill_oldest_ms INTEGER,
  reported_at      INTEGER,
  PRIMARY KEY (device_id, record_type),
  CHECK (permission_state IN ('granted', 'denied', 'unavailable', 'unknown')),
  CHECK (backfill_complete IN (0, 1))
) WITHOUT ROWID;

-- Bookkeeping counts for one device's types, without opening a payload: the
-- recount after a batch reads exactly these columns, and with this index it
-- never touches the table at all.
CREATE INDEX hc_chunks_counts ON hc_chunks (device_id, record_type, record_count, min_start_ms, max_end_ms);

-- A second kind of alert: a phone's upload could not be applied and is being
-- kept (`hc_ingest_queue.parked_at`). SQLite cannot alter a CHECK, so the table
-- is rebuilt with the wider one; every row and both indexes carry over. Nothing
-- references `alerts` by foreign key.
CREATE TABLE alerts_new (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  -- 'health_system:<id>', 'google', or 'device:<id>'.
  subject        TEXT NOT NULL,
  trello_card_id TEXT,
  opened_at      INTEGER NOT NULL,
  resolved_at    INTEGER,
  CHECK (kind IN ('reconnect', 'hc_parked'))
);
INSERT INTO alerts_new (id, kind, subject, trello_card_id, opened_at, resolved_at)
  SELECT id, kind, subject, trello_card_id, opened_at, resolved_at FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
CREATE UNIQUE INDEX alerts_open_subject ON alerts (subject) WHERE resolved_at IS NULL;
CREATE INDEX alerts_opened ON alerts (opened_at);
