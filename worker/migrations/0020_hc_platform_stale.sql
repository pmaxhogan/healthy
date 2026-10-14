-- Healthy: hours whose stored platform total is out of date, and the one-off
-- scan that finds the ones already in the store.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: two new tables, nothing existing is touched.
--
-- The phone uploads Health Connect's own hourly totals (`Agg.<Metric>`, one
-- synthetic record per UTC hour) beside the records they are totals of, and
-- works out again only the hours it knows changed. A record it is told was
-- deleted comes with no time -- Health Connect's change feed gives a deleted
-- record's id and nothing else -- so the phone cannot know which hours to work
-- out again, and an old hour whose records were deleted kept a total that
-- still counted them. This store does know: the index and the chunk give the
-- record's time. So applying a batch notes here every hour that the deletion
-- (or the move) of a record of a totalled type left with a stale total, the
-- ingest route's answer tells the phone, and the phone works those hours out
-- again (worker/src/hc/store/platform-stale.ts).
--
-- Clear on purpose, like `hc_record_index` and `hc_dirty`: a record TYPE name
-- (the Health Connect SDK's class name, the same for every user), an hour and
-- this app's own bookkeeping. No value, no origin, nothing sealed -- so there
-- is no payload column for anything to sit behind.

-- One row per (device, record type, UTC hour) whose platform total is stale.
-- `record_type` is the type the total is of (`Steps` for `Agg.Steps`); the
-- phone is told it under that name. `hour_utc` is hours since the epoch, as
-- everywhere in the store.
--
-- What decides that a total arriving later is newer than the deletion: for a
-- row marked by a batch, `marked_seq` is that batch's queue sequence number
-- (`hc_ingest_queue.seq`), and only a total from a batch with a HIGHER number
-- clears it -- arrival order, exactly, the rule tombstones follow. A row the
-- scan below found in the store has no batch behind it: `marked_seq` is NULL,
-- `marked_at` is when it was found (unix seconds), and a total from a batch
-- that arrived in a later second clears it. For a row marked by a batch,
-- `marked_at` is when that batch arrived.
CREATE TABLE hc_platform_stale (
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  record_type TEXT NOT NULL,
  hour_utc    INTEGER NOT NULL,
  marked_seq  INTEGER,
  marked_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, record_type, hour_utc)
) WITHOUT ROWID;

-- Where the one-off scan of the stored totals has got to, per device. Totals
-- that went stale before the rows above were kept were never noted, so the
-- runner walks every stored `Agg.<Metric>` hour once, when it has nothing else
-- to do, and notes the ones that name an app with no record of the type in
-- that hour. `revision` is the scan's own (`SCAN_REVISION` in
-- worker/src/hc/store/platform-stale.ts): a deploy that raises it walks the
-- store again, with nothing to run by hand. `record_type` is the `Agg.<Metric>`
-- type being walked and `next_hour` the first hour not yet looked at; `done`
-- is 1 once every type has been walked.
CREATE TABLE hc_platform_scan (
  device_id   TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  next_hour   INTEGER NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  CHECK (done IN (0, 1))
) WITHOUT ROWID;
