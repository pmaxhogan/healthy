-- Healthy: an exact order between a delete and a rewrite of one record id, and
-- which sync run each uploaded batch belonged to.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: five nullable columns, nothing existing is rewritten. Neither
-- table has a sealed payload column, so a column appended here is not behind
-- one.

-- `deleted_seq`: the queue sequence number (`hc_ingest_queue.seq`, the first
-- part's) of the batch whose delete made the row a tombstone. `deleted_at` is
-- that batch's `received_at`, in whole seconds, and two batches can arrive in
-- one second; the sequence number is given out in arrival order and is kept
-- when a parked batch is queued again, so it orders any two batches exactly.
-- An upsert brings a tombstoned id back when its batch's number is higher.
--
-- NULL on a tombstone written before this migration: for those the rule stays
-- the one `deleted_at` allows (worker/src/hc/store/record-index.ts).
ALTER TABLE hc_record_index ADD COLUMN deleted_seq INTEGER;

-- What the phone says of the sync run a batch was uploaded in: what started
-- the run (`run_trigger`: a short stable code such as `periodic`, `alarm`,
-- `manual`, `backfill`) and when, by the phone's clock, the run began
-- (`run_started_ms`, epoch milliseconds), which is the same for every batch of
-- one run and so is what groups them. Neither is clinical.
--
-- A run that is cut off (the system stopped the job, the network went) cannot
-- say so itself: it never sends its closing report. So each batch also says
-- how the run BEFORE its own ended: that run's start (`prev_run_started_ms`,
-- which names it) and a short stable code (`prev_run_end`: `ok`, `interrupted`,
-- or the error code the run failed with).
--
-- NULL on every existing row, and on a batch from a build of the app that
-- does not send them.
ALTER TABLE hc_ingest_log ADD COLUMN run_trigger TEXT;
ALTER TABLE hc_ingest_log ADD COLUMN run_started_ms INTEGER;
ALTER TABLE hc_ingest_log ADD COLUMN prev_run_started_ms INTEGER;
ALTER TABLE hc_ingest_log ADD COLUMN prev_run_end TEXT;
