# Operations

Running day-to-day: what the three cron triggers do, how a rate limit is
handled, what the reconnect-alert lifecycle looks like, what "needs
re-auth" actually means, how ghosted calendar events behave, how to run the
phone's Health Connect upload, how to rotate every secret, and how to wipe the
deployment's data.

## Cron cadence

All three schedules are UTC, and deliberately never translated to local time
anywhere in the code or its comments — doing so would disclose the
deployment owner's timezone in a public repository.

- **Hourly, `7 * * * *`.** Runs a token keepalive for every connection
  (including Google) first, then an Encounter-only appointment sync. The
  keepalive runs first on purpose: if a grant has died, the sync's own
  token calls would each rediscover that separately and less usefully than
  one clear keepalive failure.
- **Every four hours, `23 2,6,10,14,18,22 * * *`.** Runs the full-scope FHIR refresh that
  repopulates the cache the MCP reads from (every resource type, for every
  connected health system), then a calendar sync — cheap immediately afterward,
  since the refresh just filled the cache the sync's reference resolution
  reads from. Finishes by pruning expired FHIR cache rows, expired OAuth
  states, and `mcp_audit` rows older than a year.
- **Every ten minutes, `*/10 * * * *`.** The patient-portal session
  keepalive: one signed-in page load per `active` portal account, and the
  cookie jar saved back when the session is still alive. A portal's chart
  session idles out in less than an hour, so a session touched only by the
  hourly run is dead at every run -- and re-establishing it can mean an
  emailed code. The keepalive never signs in and never spends an attempt; a
  dead session is left for the hourly run. It writes no `run_log` row, only a
  `portal.keepalive` log line per account. The same tick also wakes the
  Health Connect ingest runner of every paired phone, as a safety net under the
  wake the upload route does itself (see below).

An unrecognised cron string is logged and ignored, not guessed at, so a
schedule added to `worker/wrangler.jsonc` without matching code is a visible
no-op rather than an accidental full refresh running on the wrong minute.

## Portal sign-ins the scheduled run makes on its own

When the hourly run finds a portal session dead it may sign in again, but it
is held to limits the owner's own "Sign in now" is not, because nobody is
watching it and every code it asks for is an email to the owner:

- **It leaves the day's last two attempts for the owner.** The daily budget
  (`portal_login_attempt_limit`) is shared with the button; once only two
  are left, the scheduled run stops signing in until the next UTC day
  (reported as `portal_signin_deferred`; the account stays `active`).
- **At most two emailed codes a UTC day, at least six hours apart.** A sign-in
  that needs no code (a password alone, or a device the portal trusts) is not
  limited by this. Inside the six hours after its last code the run does not
  sign in at all -- every look at the trusted device costs an attempt -- and
  the run's `portalErrors` says `portal_signin_deferred`.
- **Past that, the account waits for the owner.** A sign-in that wants a code
  stops before the email, the account goes to `needs_reauth` with
  `portal_signin_needs_owner`, and a reconnect card is opened. One press of
  "Sign in now" (which has its reserved attempts) puts it back.

## Backoff on 429

A rate limit from _any_ health system, or from Google, backs off _every_
health system's sync until the same moment — not just the one that got limited.
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
whether it succeeded, and a `summary_json` of counts, plus the distinct
warning and error codes seen (`warningCodes`, `errors`) — bare, stable codes
such as an Epic OperationOutcome code, never a health system id or any clinical
content. View recent runs in the admin UI's **Runs** page, or `GET
/api/runs`.

## Alerts: the reconnect lifecycle

When a connection's token refresh fails with `invalid_grant`, Healthy opens
a Trello card via `openReconnectCard` and records an `alerts` row. There is
at most one open alert per subject (`health_system:<id>` or `google`) — a
partial unique index enforces that a second failure while one is already
open is a no-op, not a duplicate card.

The card's link is `https://<your-host>/oauth/reconnect/<id>`, where `<id>`
can be the literal `google`, a `connections.id`, or a `health_systems.id` — the
route resolves whichever it is handed and redirects into the right
authorisation flow. Opening it on a phone works end to end: sign in past
Access and the password, land on the health system's or Google's own
sign-in page, and the reconnect is done in one pass.

The card **auto-completes** — marked done and moved to the "done" list —
the next time a sync sees that connection succeed again. There is nothing
to dismiss manually.

A second kind of alert, `hc_parked`, is about a paired phone rather than a
connection. When an upload the Worker had accepted cannot be applied it is set
aside, not deleted (see [When the queue backs up](#when-the-queue-backs-up)), and
the first one set aside opens an alert for that phone, with a Trello card where
Trello is configured. There is
one open alert per phone (the subject is `device:<id>`, under the same unique
index), however many uploads are parked. The card says that uploads from the phone
are waiting, how many and which stable error code at the moment it opened, and links
to the Phone page; it carries the name you gave the phone (as a reconnect card
carries a health system's display name) and no id, record type or value. It
**completes itself** when nothing from the phone is parked any more: after an
upload that was retried is applied, or when the phone is deleted. The Alerts page
lists it as "Phone uploads", with a link to the Phone page.

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

## Event descriptions

A synced event's description is shared with the owner. Healthy owns
everything from a line that is exactly `-------` down: that line, then
"Synced by Healthy · do not edit below the line", then the appointment
details. Anything typed **above** the line is the owner's and is kept
verbatim on every update (HTML included: once the owner applies any
formatting, Google's web editor saves the whole description as HTML); anything **below** it is overwritten. If the line
is missing, the Healthy block is appended again after whatever the
description holds. An edit above the line never causes a write; an edit below
it, or a deleted line, is repaired on the next sync. The current description
comes from the same `events.list` call the sync already makes, so none of this
costs an extra Google request, and the owner's text is never logged or stored.

Events written before the line existed (details ending in "Synced by Healthy ·
do not edit") are rewritten once into the new layout, and any note the owner
added after that old footer is kept above the new line. On that first sync
after the change, every event inside the sync window is patched once and every
existing ghost there is re-ghosted once, so the run's patched and ghosted
counts are briefly high without anything having been cancelled. Events older
than the window, and ghosts Healthy can no longer rebuild (the cached
appointment has expired, or a portal visit vanished and its start has since
passed), are not rewritten and keep the old layout.

When the patient portal lists the visit first-hand, the visit-type line links
to that visit's own page in the portal (`Visits/VisitDetails?csn=<the portal's
token for the visit>`, on the connected portal account's own address);
otherwise it links to the portal's visits list, or to the health system's
configured portal url. The portal's directions for the department (its
boilerplate removed, see [docs/mcp.md](mcp.md)) and the visit's instructions,
when there are any, come first under the "Synced by Healthy" line.

## Event titles

The owner may rename any synced event, and that title is never overwritten.
Each row records a keyed digest of the title Healthy last wrote
(`calendar_events.title_digest`); every sync compares it with the title Google
holds now, from the listing it already makes. Different means the owner edited
it: every later write — a changed time, a new address, ghosting — leaves the
title alone, and a cancelled visit then keeps the owner's title without the
`Cancelled: ` prefix (it still turns grey and stops blocking time). Setting the
title back to exactly what Healthy last wrote hands it back: Healthy updates it
again from then on. The run log's `sync.plan` / `portal.plan` lines count the
events whose title is the owner's (`titlesKept`).

Rows from before this existed are seeded on the first sync: a title equal to
the one Healthy computes now is Healthy's; a different one is the owner's when
nothing upstream has changed since Healthy last wrote it; otherwise it is taken
as Healthy's and updated.

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

Ghosting is suppressed for a health system on any run where Epic reports the
`4119` OperationOutcome warning (partial or filtered results): a real
appointment must never be turned into a ghost because an organisation's own
API had a temporary filtering problem, so inserts and patches still
proceed on such a run, but nothing is ghosted until a run comes back clean.

A **duplicate** is not a ghost. When a visit already on the calendar turns
out to be a second copy of one a higher-precedence source speaks for (a FHIR
Encounter, or the owning organisation's own portal listing of a visit
another organisation's portal showed second-hand), the visit is not
cancelled — it is on the calendar once, under the other copy — so the
duplicate event is **deleted** and its `calendar_events` row removed, rather
than left as a "Cancelled:" twin. The sync deletes only an event that
carries `extendedProperties.private.healthy = "1"` and the row's own key;
one the owner has taken over is merely forgotten. If the better copy later
goes away (its organisation is disconnected), the remaining copy is
calendared again on the next run.

## The phone and Health Connect

A paired phone uploads on its own (see [setup-android.md](setup-android.md));
the Worker accepts a batch, queues it, and applies it in the background. Day to
day the only thing to look at is the admin UI's **Phone** page.

### Reading the Phone page

Each paired phone has a card:

- **The status pill.** _revoked_: its token has been revoked (this wins over the
  rest). _never uploaded_: paired, but nothing has
  arrived yet. _active_: it uploaded within the last six hours. _stale_: it has not
  (see below).
- **A warning, when uploads or rebuilds are parked.** "N uploads could not be
  applied and are being kept", with their total size and the error codes, and/or "N
  summary rebuilds could not run", and a **Retry** button that puts both back. It
  appears only while something is set aside; see
  [When the queue backs up](#when-the-queue-backs-up).
- **Last upload / Last seen.** When the Worker last accepted a batch from the
  phone, and when it last heard from it (any authenticated request, even one it
  then refused). **Paired** shows when the phone was paired, rotated or revoked; the
  card heading carries the app version it last reported.
- **Records and Types.** Records stored, and how many record types are granted
  or denied on the phone.
- **Waiting to apply.** The queue: batches the Worker has accepted and not yet
  applied. It is empty at rest. Parked batches are not in it.
- **What the phone last reported:** the battery exemption, background read,
  exercise routes (once the phone has reported them), history read, whether the backfill is complete, and the last error code. A
  red _no_ on the battery exemption or background read is the usual reason a
  phone goes stale.

**Show details** adds two tables. _Record types_ is one row per type with its
permission, record count, first and last record time, backlog on the phone,
backfill state and coverage status (a denied type reads `unsupported` with a
"not permitted" notice; a granted type with no records reads "permitted, no
data"). _Recent uploads_ is the ingest log, newest first: when it arrived, its
status (`queued`, `applying`, `applied` or `failed`; a `failed` row is a parked
batch), counts of upserts, deletes and rejected records, size, how long applying
took, and an error code. Both are counts, instants and stable codes; nothing on this
page is a health value. The card's other buttons are **Rename**, **Rotate token**,
**Revoke** and **Delete phone and data**.

### Staleness

A phone is **stale** when no batch has arrived for six hours. The phone syncs
every 15 minutes, so that is many missed cycles: it is off, offline, has lost
its background permission, or was revoked. Staleness changes how the data is
reported, not what is served: the MCP still answers from the stored copy and says
the source is stale, so an assistant does not take an old reading for a current
one. A revoked phone also reads as stale in coverage.

### Rotate, revoke, delete

| Action                    | Effect on the token                     | Effect on stored data                                                         | Reversible                       |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| **Rotate token**          | New token; the old one is dead at once. | None.                                                                         | Yes: rotate again.               |
| **Revoke**                | The token stops working.                | Kept, and still served (as stale). Batches already queued are still applied.  | No: pair the phone again as new. |
| **Delete phone and data** | The device row is deleted.              | Everything deleted, in slices, the queue (parked batches too) and upload log. | No.                              |

Rotate token to hand a phone a fresh one (a lost QR code, a suspected leak): the
phone must then pair again by scanning the new code, and answers 401 until it
does. Revoke a phone you no longer have; its history stays, and so does anything
it had already queued, which the Worker keeps applying. Delete phone and data to
remove a phone and everything it uploaded, queue included: the Phone page asks
you to type the phone's name, deletes a bounded amount per call and repeats until
it is done. A phone's
history is far more rows than one request may delete, so do not try to delete it
by hand with one `DELETE`. Wiping never touches the phone's own Health Connect
data.

### When the queue backs up

Applying a batch is background work: an alarm-driven Durable Object (one per
phone) applies batches strictly in order, a bounded slice at a time, so a month
of backfill can take several minutes to drain after the phone has finished
sending. A short queue is normal during a backfill. If it does not shrink:

1. Look at the card for the parked-uploads warning, then open **Show details** and
   read the **Recent uploads** table. A `failed` batch with an error code is one
   the Worker **parked**: kept, set aside and no longer in the queue, so it cannot
   block the batches behind it (the queue is strictly ordered). Either it could not
   be read (`batch_unreadable`, `batch_invalid`, `batch_mismatch`,
   `queue_parts_missing`, `crypto`, `payload_too_large`, `payload_malformed`,
   `chunk_malformed`), or applying it kept failing and the Worker gave up on it
   (`apply_gave_up`). Anything else is retried.
2. **A parked batch is never deleted.** The phone was told it was accepted and has
   moved on, so the queued body is the only copy of those records. Fix the cause
   (the Worker's logs name it: `npx wrangler tail`, from `worker/`, shows the
   runner's lines, which carry the device id, counts and an `errorCode`), then
   press **Retry**. That puts every parked batch back in the queue in its original
   order, and every parked rollup or summary mark back in the rebuild list (`POST /api/phone/devices/:id/retry-failed`) and wakes the runner.
   Applying an old batch after newer ones is safe: an upload only replaces a stored
   record with an older `lastModified`, and a record deleted since stays deleted. A
   batch that is parked again after a retry reopens nothing new: the phone's alert
   is already open. The batch's log row stays (only `applied` rows are pruned, after
   30 days).
3. A slice that throws (D1 unavailable, a timeout) is retried after a growing
   delay, from five seconds up to ten minutes. The runner counts an attempt, and
   writes the count down, **before** each slice runs, so a slice that never
   returns (an invocation killed for CPU or memory) is counted too. After eight
   attempts on the same batch without one finishing, about ten minutes of trying,
   it is parked as `apply_gave_up`; its count starts again if it is queued again.
   The ten-minute cron tick wakes the runner regardless. Each slice also logs one
   `hc.slice` line: the device id, which phase it was in (`apply` or `rebuild`),
   the statements and milliseconds it spent, the units of work finished, what ended
   it (`done`, `statements` or `time`) and how many batches are still queued.
4. When a phone already has more than 96 MiB or 400 batches waiting, the Worker
   answers its uploads with 429 `backlogged` and `retry-after`; the app waits and
   retries. Parked batches are not counted. Leave the phone charging and online and
   it catches up.

Applying keeps its promises under a retry: each chunk is written, with its hourly
rollup, heart-rate minutes and index rows, in one transaction; a record whose edit
moved it to another hour is taken out of the old chunk in the same transaction that
puts it in the new one, so it is in exactly one place; and an hour with more records
than one database value can hold is split across several rows, never cut short.
While a backfill is still arriving, each applied batch is followed by a share of a
slice spent rebuilding (a fifth, rising to a half as the list of pending rebuilds
grows), so daily rollups, nights and sessions start to appear before
the last batch has landed, and the rest are rebuilt once the queue is empty. A
rollup row that no longer opens is rebuilt from the stored records (logged as
`hc.rollup_repaired` or `hc.hr_minute_repaired`). A rollup or summary whose source
records cannot be read cannot be rebuilt: its mark is parked (`hc.mark_parked`)
rather than retried for ever with every other mark behind it. That raises no alert;
an assistant sees it as the warning `hc_rollups_parked:<source>:<n>` on an answer,
and **Retry** on the Phone page puts these marks back to be rebuilt along with any
parked uploads.

Nothing here needs a manual fix beyond **Retry**, and **deleting the phone is not a
way to clear a queue**: it deletes the phone's history, not just its backlog.

### After changing the `timezone` setting

Hourly rollups are in UTC and do not care. **Daily rollups are calendar days in
the zone of the sealed `timezone` setting**, resolved when a day is rebuilt, not
when its records arrived, so changing the setting means every daily row was built
for the wrong zone. The Worker notices the change (the ten-minute tick wakes each
phone's runner, which compares a keyed digest of the zone against the one each row
was built for) and rebuilds the daily rollups, one record type at a time, from the
stored hourly rollups (opening the one chunk at a day's edge only where the zone's
offset puts the edge inside a UTC hour). Nothing has to be uploaded again. While it runs, daily answers read only rows of the current zone,
so they may be incomplete for a little while; hourly answers and the raw records
are unaffected. There is no
button for it and no default zone in source: the setting is the only input.

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
- **`EPIC_ORG_SECRET_KEY`** — **do not rotate it.** Epic keeps a hash of
  every client secret derived from it, so a new key disables the app at every
  organisation that was registered with a derived secret until each is
  re-registered in the developer portal. `npm run epic-org-secret -- --gen-key
--put` refuses to overwrite an existing one. Keep a copy outside Cloudflare:
  a Worker secret cannot be read back.
- **A per-organisation Epic client secret** — set or rotate it from the
  health system's page in the admin UI (`POST /api/health-systems/:id/secret`), or, with
  no live browser session against that environment, `npm run
set-health-system-secret -- --health-system <id> --remote`. Write-only: once saved,
  it is never read back or displayed again.
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
health system) and, for a full reset, operating on D1 directly:

```sh
npx wrangler d1 execute healthy --remote --command "DELETE FROM fhir_cache"
npx wrangler d1 execute healthy --remote --command "DELETE FROM calendar_events"
npx wrangler d1 execute healthy --remote --command "DELETE FROM connections"
npx wrangler d1 execute healthy --remote --command "DELETE FROM mcp_audit"
```

A few things this does **not** do, worth knowing before you rely on it:

- **It does not touch Health Connect data.** A paired phone's records live in
  the `hc_*` tables, hanging off `devices`. Remove them from the **Phone** page
  (**Delete phone and data**), which deletes in slices; a bare `DELETE` over a phone's history is
  too large for D1 to finish in one statement.
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
  scripts as well as in `worker/wrangler.jsonc`; if you renamed the database, the
  scripts (and the commands above) need the new name too.

To decommission a deployment entirely: disconnect every health system and
Google from the admin UI, revoke every MCP grant, then delete the D1
database and the KV namespace from the Cloudflare dashboard or with
`wrangler d1 delete` / `wrangler kv namespace delete`.

## Log fields and redaction

Logs are structured JSON lines (`worker/src/lib/log.ts`), one object per line.
Redaction is applied to every field on every line and is a safety net, not
the primary control — the actual guarantee is that call sites are written,
and tested, to never pass clinical content, health system names, or credentials
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
- Any opaque-looking string 32 characters or longer, dots included (the shape of a token
  or an id) is collapsed to `[opaque:<length>]`.
- Anything nested more than six levels deep becomes `[deep]`, which both
  caps the cost of an accidentally-logged resource and makes a
  self-referential object safe to pass.
