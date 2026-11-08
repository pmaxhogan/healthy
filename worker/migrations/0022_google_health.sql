-- Healthy: Google Health daily metrics.
--
-- The owner's wearable data read from the Google Health API (the successor to
-- the Fitbit Web API) with the same Google grant the calendar uses, widened by
-- the owner to the Google Health read scopes. It carries what Health Connect
-- does not: blood-oxygen saturation, the nightly HRV breakdown, VO2 max, the
-- skin-temperature baseline, heart-rate zones and active zone minutes.
--
-- One row per data type per day. `data_type` is this app's name for the
-- metric (a fixed vocabulary, `worker/src/google/health.ts`) and `day` the
-- calendar date Google gives the value: both clear, as a Health Connect
-- rollup's keys are, so a range read is an index scan. Every value is in
-- `payload_enc`, sealed and padded, AAD bound to the table, the column and
-- `<data_type>:<day>`. The sealed column stays last.

CREATE TABLE google_health_daily (
  data_type   TEXT    NOT NULL,
  day         TEXT    NOT NULL,
  fetched_at  INTEGER NOT NULL,
  payload_enc TEXT    NOT NULL,
  PRIMARY KEY (data_type, day)
);

-- Per data type: when it was last read, whether that worked (a stable code
-- when it did not) and whether its whole history has been read once. No value.
CREATE TABLE google_health_sync (
  data_type       TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_ok_at      INTEGER,
  last_error_code TEXT,
  backfilled_at   INTEGER,
  updated_at      INTEGER NOT NULL
);
