# Operations

Running day-to-day: what the two cron triggers do, how a rate limit is
handled, what the reconnect-alert lifecycle looks like, what "needs
re-auth" actually means, how ghosted calendar events behave, how to rotate
every secret, and how to wipe the deployment's data.

## Cron cadence

Both schedules are UTC, and deliberately never translated to local time
anywhere in the code or its comments — doing so would disclose the
deployment owner's timezone in a public repository.

- **Hourly, `7 * * * *`.** Runs a token keepalive for every connection
  (including Google) first, then an Encounter-only appointment sync. The
  keepalive runs first on purpose: if a grant has died, the sync's own
  token calls would each rediscover that separately and less usefully than
  one clear keepalive failure.
- **Daily, `23 6 * * *`.** Runs the full-scope FHIR refresh that
  repopulates the cache the MCP reads from (every resource type, for every
  connected provider), then a calendar sync — cheap immediately afterward,
  since the refresh just filled the cache the sync's reference resolution
  reads from. Finishes by pruning expired FHIR cache rows, expired OAuth
  states, and `mcp_audit` rows older than a year.

An unrecognised cron string is logged and ignored, not guessed at, so a
schedule added to `wrangler.jsonc` without matching code is a visible
no-op rather than an accidental full refresh running on the wrong minute.

## Backoff on 429

A rate limit from _any_ provider, or from Google, backs off _every_
provider's sync until the same moment — not just the one that got limited.
The detection covers three shapes: an explicit 429, a rate-limit error
carrying a `Retry-After`-derived delay, and Google's quota-exhaustion
response, which is a **403**, not a 429, but is treated identically. The
backoff window is `max(Retry-After, 2 hours)`, stored as
`settings.sync_backoff_until` — the two-hour floor exists because an
organisation that starts rate-limiting a patient-facing endpoint is
throttling the whole app, not one request, and retrying in the 60 seconds
a header asked for just burns the next quota window too.

## The run log

Every sync (scheduled or manual) writes one row to `run_log`: its kind
(`calendar`, `full`, `refresh`, or `manual`), when it started and finished,
whether it succeeded, and a `summary_json` of counts — never any clinical
content. View recent runs in the admin UI's **Runs** page, or `GET
/api/runs`.

## Alerts: the reconnect lifecycle

When a connection's token refresh fails with `invalid_grant`, Healthy opens
a Trello card via `openReconnectCard` and records an `alerts` row. There is
at most one open alert per subject (`provider:<id>` or `google`) — a
partial unique index enforces that a second failure while one is already
open is a no-op, not a duplicate card.

The card's link is `https://<your-host>/oauth/reconnect/<id>`, where `<id>`
can be the literal `google`, a `connections.id`, or a `providers.id` — the
route resolves whichever it is handed and redirects into the right
authorisation flow. Opening it on a phone works end to end: sign in past
Access and the password, land on the health system's or Google's own
sign-in page, and the reconnect is done in one pass.

The card **auto-completes** — marked done and moved to the "done" list —
the next time a sync sees that connection succeed again. There is nothing
to dismiss manually.

**Not every OAuth failure opens a card.** Only `invalid_grant` on a
_refresh_ attempt means "the owner must reconnect": the refresh token
expired, was revoked in the portal, or was invalidated by a password reset
there. `invalid_client` and `unauthorized_client` are wrong-credential
errors — a misconfigured client id or secret — and are deliberately **not**
treated as needs-reauth, because sending the owner through a reconnect flow
cannot fix a bad client secret; those show up as connection errors instead
and need a secret rotated (see below).

## What "needs re-auth" means

`connections.status = 'needs_reauth'` (or the single `google_account` row's
equivalent) means the health system's or Google's own refresh grant was
rejected. For Epic connections, the org that issued the refresh token
controls how long it lives before this happens on its own, even with no
error on this app's part — **(verify: Epic does not publish a fixed
refresh-token lifetime; it is organisation-controlled and has been
observed to vary)**. For Google, the 7-day expiry described in
[docs/setup-google.md](setup-google.md) is the most common cause if the
consent screen was ever left in Testing status.

## Ghost events

An appointment that is cancelled, or simply no longer appears in the
Encounter search window, is never deleted from the calendar. It becomes a
**ghost**: the event title gets a `Cancelled: ` prefix, its transparency
becomes `transparent` (so it stops blocking availability), its colour
switches to the configured ghost colour (`ghost_color_id`, grey by
default), and its description keeps the original appointment details plus
the moment it was noticed missing. `calendar_events.state` tracks this
persistently; a ghost that reappears in a later sync (the appointment was
rescheduled back, or a search-window quirk made it vanish temporarily) is
**restored** to active rather than left ghosted forever.

Ghosting is suppressed for a provider on any run where Epic reports the
`4119` OperationOutcome warning (partial or filtered results): a real
appointment must never be turned into a ghost because an organisation's own
API had a temporary filtering problem, so inserts and patches still
proceed on such a run, but nothing is ghosted until a run comes back clean.

## Rotating secrets

- **`PASSWORD_HASH`** — `npm run set-password` (prompts twice, uploads the
  hash). `npm run set-password -- --print-only` prints the hash instead, if
  you want to upload it by hand.
- **`SESSION_SECRET`** — any new long random string via `wrangler secret
put SESSION_SECRET`. This invalidates every existing session cookie; you
  will need to sign in again afterward.
- **`DATA_KEY`** — `npm run gen-data-key -- --put`. **This is destructive**:
  the AES-GCM envelope carries no key id, so rotating it makes every
  already-sealed column unreadable. In practice, rotating it means
  re-authorising every Epic and Google connection from scratch and letting
  the FHIR cache repopulate — there is no in-place re-encryption path.
- **A per-organisation Epic client secret** — set or rotate it from the
  provider's page in the admin UI (`POST /api/providers/:id/secret`).
  Write-only: once saved, it is never read back or displayed again.
- **`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `EPIC_CLIENT_ID_PROD`/
  `EPIC_CLIENT_ID_NONPROD`, `TRELLO_KEY`/`TRELLO_TOKEN`/list ids** —
  `wrangler secret put <NAME>` as usual.
- **`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_EMAIL`** —
  `wrangler secret put <NAME>`. A team-domain change is picked up
  automatically (the JWKS cache is keyed by team domain), no redeploy
  required.

## Wiping data

There is no single "wipe everything" button; wiping is a combination of
disconnecting through the admin UI (which does the safe parts — revoking
what can be revoked upstream, clearing the FHIR cache, soft-deleting the
provider) and, for a full reset, operating on D1 directly:

```sh
npx wrangler d1 execute healthy --remote --command "DELETE FROM fhir_cache"
npx wrangler d1 execute healthy --remote --command "DELETE FROM calendar_events"
npx wrangler d1 execute healthy --remote --command "DELETE FROM connections"
npx wrangler d1 execute healthy --remote --command "DELETE FROM mcp_audit"
```

A few things this does **not** do, worth knowing before you rely on it:

- **`google_account` is a seeded singleton row** (`CHECK (id = 1)`) that
  the code assumes always exists. Reset it with an `UPDATE` back to
  `status = 'disconnected'` rather than deleting the row — deleting it
  leaves the app in a state nothing else writes it back from.
- **Deleting `calendar_events` does not touch Google Calendar itself.**
  The rows are this app's own bookkeeping; the events they describe, ghosts
  included, stay on the calendar. The sync re-pairs with them on the next
  run via `extendedProperties.private.key` on the Google event, so clearing
  the table is closer to "forget what we know" than "undo the sync."
- **MCP grants live in Workers KV (`OAUTH_KV`), not in D1.** Wiping D1 does
  not revoke any connected MCP client; use the **Revoke** button per grant
  in the admin UI, or delete the whole KV namespace if you are
  decommissioning the deployment entirely. **(verify: there is no bulk
  "revoke every grant" endpoint today.)**
- The D1 database name `healthy` is hard-coded in the `migrate:*` npm
  scripts as well as in `wrangler.jsonc`; if you renamed the database, the
  scripts (and the commands above) need the new name too.

To decommission a deployment entirely: disconnect every provider and
Google from the admin UI, revoke every MCP grant, then delete the D1
database and the KV namespace from the Cloudflare dashboard or with
`wrangler d1 delete` / `wrangler kv namespace delete`.

## Log fields and redaction

Logs are structured JSON lines (`worker/lib/log.ts`), one object per line.
Redaction is applied to every field on every line and is a safety net, not
the primary control — the actual guarantee is that call sites are written,
and tested, to never pass clinical content, provider names, or credentials
to the logger in the first place:

- Any key that looks credential-shaped (containing `token`, `secret`,
  `password`, `authorization`, `cookie`, `refresh`, `verifier`, `api key`,
  or `private`, case-insensitively) is replaced with `[redacted]`.
- The keys `code`, `state`, `authCode`, `codeVerifier`, and `nonce` are
  redacted on an exact match — this is why a field describing a database
  row's own state is always named something like `eventState`, never
  `state`, elsewhere in the codebase.
- Any string containing a `Bearer <token>` or `Basic <token>` has the
  token portion redacted.
- Any whitespace-delimited token containing `@` is replaced with `[email]`.
- Any opaque-looking string 40 characters or longer (the shape of a token
  or an id) is collapsed to `[opaque:<length>]`.
- Anything nested more than six levels deep becomes `[deep]`, which both
  caps the cost of an accidentally-logged resource and makes a
  self-referential object safe to pass.
