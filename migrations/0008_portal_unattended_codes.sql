-- Healthy: cap how often the scheduled sync may email the owner a sign-in code.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- Additive only: three new columns on `portal_accounts`, nothing rewritten.
--
-- The hourly sync re-signs in when it finds a portal session dead, and a portal
-- that wants an emailed code for that sends the owner an email every time. The
-- daily attempt counter (`login_attempts_today`) bounds *attempts*, but it is
-- shared with the owner's own "Sign in now" button, so an unattended run that
-- spends it leaves the owner locked out of their own retry until tomorrow.
--
-- These count only the codes an *unattended* sign-in asked the portal to email,
-- so the scheduled sync can be held to a few a day, spaced apart, and leave the
-- rest for the owner. The count resets the same way the attempt counter does --
-- by comparing the stored UTC day to today's, with no sweep -- and the last
-- instant is what spaces them out. Counts and a timestamp, like the attempt
-- counter: nothing here names anyone.
ALTER TABLE portal_accounts ADD COLUMN unattended_codes_today INTEGER NOT NULL DEFAULT 0
  CHECK (unattended_codes_today >= 0);
-- Whole UTC days since the epoch: floor(unixSeconds / 86400).
ALTER TABLE portal_accounts ADD COLUMN unattended_codes_day INTEGER;
ALTER TABLE portal_accounts ADD COLUMN last_unattended_code_at INTEGER;
