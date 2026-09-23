-- Healthy: drop the plaintext columns 0007 emptied, and name the columns it
-- sealed in place for what they now hold.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Only safe once the 0007 backfill has finished (`data_migrations`), which in
-- production it has: every value these columns held is now either sealed
-- elsewhere or was a leftover that was already blank.
--
-- The AADs of the renamed columns do not change. An AAD is part of the
-- ciphertext's authentication tag, so it stays the string each value was sealed
-- under (`providers.display_name.<id>`, `portal_accounts.base_url.<id>`, ...)
-- rather than following the column's new name; see the repos.

-- A calendar row's start lives in `detail_enc`; a visit's start in its payload.
ALTER TABLE calendar_events DROP COLUMN start_at;
ALTER TABLE portal_visits DROP COLUMN start_at;

-- The pre-0005 plaintext sender and subject, blanked by 0007.
ALTER TABLE mail_inbox DROP COLUMN from_addr;
ALTER TABLE mail_inbox DROP COLUMN subject;

-- Sealed in place by 0007: the names now say so.
ALTER TABLE providers RENAME COLUMN display_name TO display_name_enc;
ALTER TABLE providers RENAME COLUMN fhir_base_url TO fhir_base_url_enc;
ALTER TABLE providers RENAME COLUMN brand_key TO brand_key_enc;
ALTER TABLE providers RENAME COLUMN portal_url TO portal_url_enc;
ALTER TABLE providers RENAME COLUMN config_json TO config_enc;
ALTER TABLE portal_accounts RENAME COLUMN base_url TO base_url_enc;
ALTER TABLE portal_accounts RENAME COLUMN mount_path TO mount_path_enc;
ALTER TABLE portal_accounts RENAME COLUMN endpoint_json TO endpoint_enc;
