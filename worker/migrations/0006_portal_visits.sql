-- Healthy: keep the patient portal's upcoming visits, so the MCP can serve them.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: one new table, nothing existing is rewritten.
--
-- Epic's patient-facing FHIR view does not return an Encounter for a visit
-- before it happens, so until now the only record of an upcoming appointment
-- was the calendar event the portal pass wrote -- which the MCP cannot read.
-- This table is the portal pass's own copy of what `LoadUpcoming` returned,
-- one row per visit, refreshed every run.
--
-- `payload_enc` is the parsed visit (never portal markup), sealed with the AAD
-- bound to `portal_visits.payload_enc.<providerId>:<csn>` -- the composite row
-- id, because the primary key is composite. A payload lifted from one visit's
-- row to another's fails to open.
--
-- Plaintext on purpose: `csn` (the portal's own visit number, already stored
-- the same way as `calendar_events.portal_csn`), `start_at` (as
-- `calendar_events.start_at` is), and `status`, a word from a fixed vocabulary
-- ('scheduled', 'canceled', ...) that names no one. Everything that does name
-- someone -- practitioner, department, address, phone -- is in the payload.
--
-- `state` mirrors the calendar's ghost rule. A visit that stops being returned
-- while it is still in the future is 'missing' (cancelled, as far as anyone
-- can tell) from `missing_since`; one that stops being returned after its start
-- time is simply over and is left alone. A 'missing' visit the portal reports
-- again goes back to 'active'.
--
-- Pruned by the daily scheduled purge once `expires_at` passes: a year after
-- the visit, by which time the FHIR Encounter has long since taken over.
CREATE TABLE portal_visits (
  provider_id   TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  csn           TEXT NOT NULL,
  payload_enc   TEXT NOT NULL,
  -- sha256 of the plaintext payload, so an unchanged visit is not re-sealed.
  content_hash  TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  status        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'active',
  missing_since INTEGER,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (provider_id, csn),
  CHECK (state IN ('active', 'missing')),
  CHECK (state <> 'missing' OR missing_since IS NOT NULL)
);
CREATE INDEX portal_visits_start ON portal_visits (provider_id, start_at);
CREATE INDEX portal_visits_expires ON portal_visits (expires_at);
