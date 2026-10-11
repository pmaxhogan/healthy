# Security

This application handles one person's health records. The threat model is
written down here because most of the design decisions in the codebase only make
sense in light of it.

## What is being protected

A single owner's clinical record: appointments, conditions, medications, lab
results, and the OAuth credentials that grant access to the health systems it was
read from; and, where a phone is paired, that person's own Health Connect data
(heart rate, sleep, steps, blood pressure and every other record type the phone
holds) together with the device token that lets the phone upload it. There is no
other user's data in the system, which removes a whole class of authorisation
bugs and concentrates the risk on three things: the admin surface, the MCP
surface, and the one machine-facing upload route.

## Assets and where they live

Three treatments, and every column is in exactly one of them:

- **Sealed**: AES-GCM-256 in the application, `v1:`/`v2:`/`v3:` envelope, AAD
  bound to `<table>.<column>.<rowId>` (see below). `v2:` pads the plaintext to a
  size bucket first (64, 128, 256, ... bytes), so the ciphertext stops giving
  away a short value's exact length. `v3:` is the same frame around raw bytes
  instead of text, used for the bulk Health Connect payloads, which are
  gzip-compressed JSON; it is not padded.
- **Blinded**: a keyed HMAC-SHA256 under a key derived from `DATA_KEY` with HKDF
  (info `healthy/blind/v1`) — never the AES key itself. Deterministic, so the
  column is still a primary key, an index and an exact match, but a snapshot
  reader cannot compute or confirm one without the key. Every input includes the
  health system's row id, so the same upstream id at two organisations blinds to
  two unrelated values. Health Connect blinds are scoped the same way, to the
  device row: a record's id and the package name of the app that wrote it are
  blinded over the device id, so two phones share nothing a snapshot could join
  on. Stored as `~` plus base64url (128 bits for an id, 256 for a digest). See
  `worker/src/db/blind.ts`.
- **Plaintext**: listed below, each with the reason.

| Asset                                                                                         | Store                                                                     | At rest                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Health-system and Google OAuth tokens                                                         | D1                                                                        | Sealed                                                                              |
| Per-organisation client secrets                                                               | D1                                                                        | Sealed, padded                                                                      |
| Health-system identity: name, FHIR base URL, brand, portal URL, config                        | D1 `health_systems`                                                       | Sealed in place, padded                                                             |
| Patient FHIR id on the connection                                                             | D1                                                                        | Sealed, padded                                                                      |
| Cached FHIR resources (including the Patient)                                                 | D1                                                                        | Payload sealed; resource id blinded; content hash keyed                             |
| Patient-portal upcoming visits                                                                | D1                                                                        | Payload sealed; visit number blinded; content hash keyed                            |
| Patient-portal secure messages                                                                | D1                                                                        | Payload sealed, padded; keys blinded; content hash keyed                            |
| Secure-message attachments: the files, their names, types and sizes                           | D1                                                                        | Each piece sealed, padded; metadata sealed; keys blinded                            |
| Calendar bookkeeping: event key, encounter, visit number, calendar id                         | D1                                                                        | Blinded; fingerprint keyed                                                          |
| Calendar bookkeeping: a row's start and real calendar id                                      | D1                                                                        | Sealed together, padded (`calendar_events.detail_enc`)                              |
| Google event marker (`extendedProperties.private.key`, `fp`)                                  | Google                                                                    | The blinded event key and the keyed fingerprint                                     |
| Settings that name the owner: calendar id, timezone, mail sender allowlist, portal API path   | D1 `settings`                                                             | Sealed in place, padded                                                             |
| Other settings: templates, colour ids, window, offsets, limits, backoff, MCP switch           | D1 `settings`                                                             | Plaintext (names no one; see below)                                                 |
| Patient-portal login, MFA contact, expected code sender                                       | D1                                                                        | Sealed, padded                                                                      |
| Patient-portal cookie jar                                                                     | D1                                                                        | Sealed                                                                              |
| Patient-portal location: base URL, mount path, discovered endpoint                            | D1                                                                        | Sealed in place, padded                                                             |
| Inbound mail: code, sender, subject                                                           | D1                                                                        | Sealed, padded                                                                      |
| Login rate-limit key                                                                          | D1                                                                        | Keyed digest of the client IP                                                       |
| Device bearer token (one per paired phone)                                                    | D1 `devices`                                                              | Never stored; only its SHA-256 (the token is 256 random bits)                       |
| Device name (what the owner called the phone)                                                 | D1 `devices`                                                              | Sealed in place, padded                                                             |
| The phone's last sync report (permissions, battery exemption, backfill)                       | D1 `devices`                                                              | Sealed in place                                                                     |
| Health Connect records: every record of one type from one app in one UTC hour                 | D1 `hc_chunks`                                                            | Gzip JSON sealed as a `v3:` envelope; AAD bound to table, column and row key        |
| Health Connect rollups: hourly, daily, per-minute heart rate, sleep nights, exercise sessions | D1 `hc_rollup_*`, `hc_hr_minute`, `hc_sleep_night`, `hc_exercise_session` | Payload sealed (`v3:`); keys and times clear                                        |
| Health Connect record id; origin app package name                                             | D1 (index and keys)                                                       | Keyed blinds, scoped to the device; the name itself is only inside a sealed payload |
| Uploads waiting to be applied, or parked (set aside, kept until retried or wiped)             | D1 `hc_ingest_queue`                                                      | The whole gzip body sealed (`v3:`)                                                  |
| Alert card about parked uploads: the phone's name, a count, a stable error code, a UTC time   | Trello                                                                    | Plaintext at Trello; no id, record type or value (see "Alert cards")                |
| Upload log, per-type sync state                                                               | D1 `hc_ingest_log`, `hc_sync_state`                                       | Plaintext: counts, instants, permission states, stable codes                        |
| Device token on the phone                                                                     | Android app storage                                                       | Encrypted under a non-exportable Android Keystore key                               |
| MCP access and refresh tokens                                                                 | Workers KV                                                                | Managed by `@cloudflare/workers-oauth-provider`                                     |
| Admin password                                                                                | Worker secret                                                             | PBKDF2-SHA256, 100k iterations, per-hash salt                                       |
| Encryption key, API credentials                                                               | Worker secrets                                                            | Cloudflare-managed                                                                  |
| Full-refresh progress                                                                         | Durable Object                                                            | Plaintext: health system ids, a run id, counts, codes                               |
| Portal sign-in progress                                                                       | Durable Object                                                            | Plaintext: a health system id, a step, counts, codes                                |
| Health Connect apply progress                                                                 | Durable Object                                                            | Plaintext: a device id, a position in a batch, a keyed digest of the zone           |

What is **plaintext on purpose**, table by table. None of it names a person, a
health system, a practitioner, a place or a visit; what it does disclose is
listed rather than left to be inferred:

- **Row ids and foreign keys** everywhere (`health_systems.id`, `health_system_id`,
  `connections.id`, ULIDs): this app's own random ids. A ULID's first ten
  characters are its creation time, which duplicates a timestamp column next
  to it.
- **`health_systems.vendor`, `environment`, `created_at`, `updated_at`,
  `deleted_at`**: "epic", "prod" or "sandbox", and bookkeeping.
- **`connections.scope`, `status`, the lease and failure columns and the
  timestamps**: the SMART scope string is the same list of US Core categories
  for every organisation. `google_account.scope` and `status` likewise.
- **`fhir_cache.health_system_id`, `resource_type`, `last_updated`, `fetched_at`,
  `expires_at`**, and **`fhir_sync_state`**: which types of record exist and
  how many, and each type's refresh health. Row counts per type and the size
  class of a sealed payload are accepted leaks (see Known limits).
- **`calendar_events.health_system_id`, `state`, `source`, `first_seen_at`,
  `last_seen_at`, `ghosted_at`, `updated_at`**: whether a row is live or a
  ghost, which pass wrote it, and when this app saw it. Not when the
  appointment is.
- **`portal_visits.health_system_id`, `status`, `state`, `missing_since`,
  `fetched_at`, `expires_at`**: a word from a fixed status vocabulary and
  bookkeeping. `expires_at` is rounded up to a 30-day boundary, so it does not
  date the visit (see "The visit timeline" below).
- **`portal_messages.health_system_id`, `state`, `missing_since`,
  `fetched_at`**, and **`portal_message_sync`**: whether a stored message is
  still listed by its own portal, bookkeeping, and each health system's last
  Message Center read (when, whether it was complete, a stable error code, and
  thread and message counts). The subject, body, sender, care team, folder and
  owning organisation are all in the sealed payload; the row keys are blinds of
  the message's content, never the portal's ids.
- **`portal_message_attachments.state`, `error_code`, `chunks`,
  `attempted_at`, `fetched_at`** and the chunks' `seq`: whether a file is
  stored or why it failed (a stable code), how many pieces it has -- which
  bounds its size to within about 576 KiB -- and when it was tried. The name,
  type, size and every byte are sealed; the key is a blind of the message's
  content and the file's position, never the portal's per-session id, which is
  used by the run that listed it and never stored.
- **`portal_accounts.session_state`, the attempt counters and the
  timestamps**: whether the session is live, how many sign-ins were spent
  today, and how many emailed codes the scheduled sync asked for and when.
- **`mail_inbox.kind`, `received_at`, `consumed_at`, `expires_at` and
  `raw_size`**: a classification, three timestamps and a byte count. The legacy
  plaintext `from_addr` / `subject` columns were blanked by migration 0007 and
  dropped by 0009.
- **`mcp_audit`, `run_log`**: that a tool ran, by which client, how many rows
  came back (and, for a `jq` call, the program's SHA-256, length and item
  counts — never its text), and each sync run's counts and error codes. The owner's activity
  times and clinical counts (for example a tool's `result_count`) are visible
  here; that is accepted.
- **The other settings** (`default_title_template`, `default_color_id`,
  `ghost_color_id`, `window_past_days`, `default_arrival_offset_min`,
  `sync_backoff_until`, `mcp_enabled`, `portal_login_attempt_limit`): generic
  configuration. A title template is only placeholders unless the owner types
  a name into it; one that does should go into a health system's config, which
  is sealed.
- **`data_migrations`**: which one-shot backfill ran, when, and counts (the 0007
  backfill has run and its code is gone; the row is its record).
- The two Durable Objects (`FULL_REFRESH`, `PORTAL_SIGNIN`) hold a health system
  id, a step name, counts and stable codes. Never a credential, never an
  emailed code, never a byte of a portal's HTML. `PORTAL_SIGNIN` additionally
  holds the sign-in gate: one lock per health system that both the admin button and
  the hourly cron take, so two sign-ins cannot each pass the daily attempt check
  before either increments it (and so the second `SendCode` cannot invalidate the
  code the first is waiting for).

### Health Connect data: what is clear and why

Migration 0016 follows the same rule as the rest of the schema: no clinical value
is a clear column. Every value, every origin app's package name and every device
description lives inside a sealed payload, and the aggregates are sealed too,
because an hourly step count is as clinical as the records it sums. What D1 has
to compare or sort stays in the clear, and it discloses more than most of the
schema, so it is listed plainly:

- **Record type names** (`HeartRate`, `SleepSession`, ...) in `hc_chunks`,
  `hc_rollup_*` and `hc_sync_state`. They are the Health Connect SDK's own class
  names, the same for every user, but together they say which kinds of data the
  owner's phone and wearable produce, and `hc_sync_state` says which the owner
  refused.
- **Instants**: the UTC hour of every chunk and rollup row, the day of every
  daily rollup (a civil date), the moment a queued upload was set aside
  (`hc_ingest_queue.parked_at`), and the start and end of every sleep night and
  exercise session. A reader of a snapshot can therefore see _when_ the phone
  held data of each type: the hours a heart-rate series exists, and the times
  of every recorded sleep and workout. They cannot see a value.
- **Counts and sizes**: records per chunk and per type, first and last record
  times per type, the size class of each sealed payload (gzip bytes, sealed
  without padding; a chunk too large for one row is several rows, `part` 0, 1, ...,
  each with the chunk's own instants), and per-upload counts, byte sizes,
  durations and stable error codes in `hc_ingest_log`, kept 30 days for applied
  batches and indefinitely for failed ones. Accepted, as with `fhir_cache`.
- **Permission states** per type (`granted`, `denied`, `unavailable`), the phone's
  upload and last-seen times, and the app version string it last sent
  (`devices`). The type names and the app version are written by whoever holds
  the device token, so they are not to be trusted either (see "What a stolen
  device token can and cannot do").
- **Blinds** reveal equality and nothing else: that two chunks came from the same
  app, not which app; that a record id recurs, not what it is.
- `hc_rollup_day.tz_digest` is a keyed digest of the zone the row was built for,
  never the zone's name, so a change of the `timezone` setting is detectable.
  `hc_dirty` holds the rebuild work list: a UTC day with a record type, an origin
  blind with a UTC hour, or a blinded record id, under a kind
  that is this app's own vocabulary (`parked:<kind>` for a mark set aside).

None of it is a value, a name or a place. It is the owner's rhythm, which is the
cost of being able to answer a range query without opening every row.

### The visit timeline

An appointment's start is sealed wherever it is stored, and each query that
used to read it plaintext was decided on its own:

- **The calendar window** (`calendar_events`). Both passes already read a
  health system's rows by `health_system_id` (indexed) and narrowed them to the
  window in memory, so the start moved into the sealed `detail_enc` with no new
  query and no new round trip: `list` opens each row it reads anyway. No
  plaintext bucket is kept; the old `start_at` column is dropped (0009).
- **Ordering** (`calendar_events.list`, `portal_visits.list`): applied after
  the rows are opened. A health system has tens of rows, not thousands.
- **"Is this visit over yet"** (`portal_visits.record`): only the rows the
  portal stopped returning are opened, to read their start.
- **The purge** (`portal_visits.purgeExpired`): the one query that filters on
  time in SQL. It uses `expires_at` (indexed), which was the visit's start plus
  a year to the second, and is now rounded up to a 30-day boundary: the purge
  still runs within a month of when it would have, and the column no longer
  says when the visit was. `fhir_cache.expires_at` was never derived from a
  visit.

**Encryption at rest is applied by the application, not just by the platform.**
Every sensitive column is sealed before it reaches D1 as
`v1:base64url(iv || ciphertext)` (or `v2:`, the same around a padded plaintext),
with the AES-GCM additional authenticated data bound to
`<table>.<column>.<rowId>`. That binding means a ciphertext cannot be lifted from
one row or column and replayed in another: decryption with the wrong AAD fails,
and there is a test that asserts it does. Where a row's id is itself blinded
(`fhir_cache`, `portal_visits`), the AAD uses the stored, blinded id; a calendar
row's detail is bound to its Google event id, which is the one id that row keeps
for life. The envelope version is authenticated as well (the AAD handed to
AES-GCM is `<version>\0<table>.<column>.<rowId>`), so a `v2:` value relabelled
`v1:` fails to open rather than being parsed under the wrong rule. Values sealed
before the version was bound still open under the bare AAD and stay relabel-able
until their column is next written, which re-seals them.

## Controls

**Two-factor admin gate.** Every administrative route requires _both_ a valid
Cloudflare Access JWT — verified in the Worker against the team's signing keys,
checking issuer, `aud`, expiry and the email claim, rather than trusting a
request header — _and_ a password-derived session. Access alone is not treated as
sufficient, so an Access misconfiguration is not by itself a breach. Sessions are
HMAC-signed cookies, `SameSite=Lax`, `Secure`, `HttpOnly`. State-changing
`/api` calls additionally require a custom header and a same-origin `Origin`
check. Login attempts are rate-limited per client, keyed by a keyed HMAC of the IP
rather than the address itself.

**MCP path scoping.** An AI client cannot complete an interactive Access login,
so a deliberately narrow set of paths bypasses Access: `/mcp*`, `/oauth/token`,
`/oauth/register`, `/.well-known/*`, the public pages, and one path for the
phone, `/ingest/health-connect` (Access treats that entry as the path and
everything beneath it; see below). The MCP paths are protected instead by the
OAuth provider, which issues short-lived access tokens against a consent grant
the owner approved from behind the full gate; the phone's path is protected by
its own device token (next). Anything else that can change state — including the
consent page itself and every OAuth callback — stays behind Access and the
password. The Worker does not rely on the Access policy for that: it verifies the
Access JWT itself on every path behind the owner gate (all but the public
pages, the MCP and OAuth-provider paths, and the phone's one route), so a bypass
entry wider than it should be exposes no other path. A request without a valid Access identity gets 403, and one
without a password session gets 401 or the login page: it fails closed.

Two mismatches between Access and the Worker were observed in production, and
both are harmless for the same reason. Access treats the phone's bypass entry as
that path **and everything beneath it**: `/ingest/health-connect/`,
`/ingest/health-connect/x` and `/ingest/health-connect/x/y` all pass Access. It
also matches **case-insensitively**, while the Worker's router is case-sensitive,
so `/INGEST/health-connect` passes Access too. Nothing is registered beneath that
path and the case variants do not match the upload route, so all of these fall to
the Worker's own owner gate, which verifies the Access identity itself and refuses
them (403, no Access identity): they fail closed. Siblings such as
`/ingest/health-connectx`, `/ingest/health` and `/ingest` are not matched and stay
behind Access. These are Access's behaviours, not something this repository
controls, so check them again after a change on Cloudflare's side. Right after the
entry is created the sub-path behaviour can lag for some minutes (a sub-path may
still be redirected to Access at first), so a check made immediately can mislead.

What keeps this safe is the Worker's route order (`worker/src/app.ts`) and the
owner gate's own Access check, not Access matching exactly. What is reachable
without an Access identity is still exactly one route, with its own bearer-token
check. The corollary is a rule for the future: because Access publishes everything
beneath `/ingest/health-connect/`, **nothing may ever be registered under that
path** (for example `/ingest/health-connect/status`) without its own
authentication, since it would be reachable without Access.

<a id="device-upload"></a>**The phone's upload route is the one route above the
owner gate.** `POST /ingest/health-connect` is registered between the public
router and `ownerGate` (the header comment of `worker/src/app.ts` is the contract),
because a phone has neither an Access identity nor a password session. Its
Access bypass entry opens that path and the paths beneath it, but the Worker serves
only the exact path; everything beneath it is refused by the owner gate. The route
is terminal for every other method on the exact path (405), so nothing there can fall through to the
gate and answer with a login page. It authenticates with a **device token**:
`hcd1.<device id>.<secret>`, where the secret is 32 bytes from the CSPRNG. The
token is shown once when it is minted (as a QR code and a copyable pairing code on
the Phone page), and only
its SHA-256 is stored; a digest is enough here because 256 random bits leave
nothing to search, and a slow hash would only cost the Worker CPU. The device
id is in the token so the route loads exactly one row by primary key. Tokens are
per device, **revocable** (the token stops working at once, so nothing new is
accepted; its stored data stays until it is wiped, and batches the Worker had
already queued are still applied, because applying does not look at revocation)
and **rotatable** (a new token is minted and the old digest is overwritten). A
wipe deletes the queue, parked batches included, along with everything else, so
wipe, not revoke, is what removes data a thief had already queued. For the same
reason a revoked phone's stored data is **still served** by the MCP until it is
wiped, and a phone paired again as a new device while its old row's data was not
wiped is stored twice and answers can double-count; the Health Connect tools warn
(`multiple_devices:<n>`) when rows come from more than one device.

The route's defences, in the order they run, each before the next costs anything:

1. _Token shape_ is checked before any database read: the version tag, an id of
   the shape this app mints, a secret of exactly the right length, and an
   `Authorization` header of bounded size. A request without a well-formed token
   costs only that check.
2. _The token itself_ is compared by constant-time comparison of SHA-256 digests,
   against one row. Missing, malformed, unknown, wrong and revoked tokens all
   get the same 401 with the same body, so the route is not an oracle for which
   device ids exist; an unknown id is compared against a dummy digest so it
   spends the same work as a wrong secret.
3. _A per-device rate limit_: 120 requests per fixed 60-second window, counted
   before the body is read, answered 429 `rate_limited` with `retry-after`. The
   window is fixed, not sliding, so a device can send up to twice the limit across
   a window boundary. A backfill needs a few requests a minute.
4. _Backpressure_, also before the body is read. A device with more than 96 MiB
   or 400 batches waiting (parked batches are not waiting) is told to come back
   (429 `backlogged`, `retry-after`), so a device cannot make the Worker hold an
   unbounded queue of work to apply. The
   check is not atomic with the insert, so requests already past it can overshoot
   by what one rate-limit window lets through.
5. _Size limits on the bytes actually read and actually expanded_: at most 8 MiB
   of compressed body and 16 MiB once decompressed, counted as the stream is read
   and the stream cancelled the moment either is passed (413). No header is
   trusted, so a gzip bomb stops at the limit. The body must be gzip with a JSON
   media type (415 otherwise) and valid UTF-8 JSON, and may carry at most 25,000
   upserts plus deletes, counted on the array lengths before anything is
   validated; a batch over that is refused whole (413) so the phone splits it, and
   is never truncated.
6. _Strict envelope validation._ A malformed envelope is refused whole (400), and
   so is a batch naming a device other than the token's. Each record is validated
   on its own: a bad one is reported as rejected without losing the rest, the
   response lists the first 100 rejections and gives the exact total, and every
   instant must lie between 1970 and the year 2200.
7. _A sealed queue._ The batch is sealed into `hc_ingest_queue` in one
   transaction and acknowledged only after that. A batch id already seen is
   acknowledged again without being queued twice, but only if its content (a keyed
   digest of the body) is the same: the same id with different content is refused
   with 409, so a batch is never acknowledged for records that were not taken. An
   alarm-driven Durable Object applies the queue afterwards, so a request never
   holds a connection open for D1 work. A batch the applier cannot read is marked
   `failed` and **parked**: kept in the queue table, set aside so it no longer
   blocks the batches behind it, never deleted, because the phone was told it was
   accepted and has moved on. One whose application keeps failing is parked the
   same way after eight attempts, counted before each one so an invocation that is
   killed outright counts too. A parked batch raises an alert (see "Alert cards")
   and is put back in the queue by Retry on the Phone page; a wipe removes it.
   `failed` rows stay in the upload log, and `applied` ones are pruned after 30
   days.

**What a stolen device token can and cannot do.** It can send batches to its own
device's queue, within the limits above, and nothing else. A batch carries records
(an upsert replaces a stored record with the same id), deletions by record id, and
the phone's own sync report, which sets that device's per-type permission states,
battery and background flags and last error as the Phone page and the MCP
`hc_coverage` and `hc_sync_status` tools show them. So a thief can add false
records, delete or overwrite records whose ids it knows, and misreport the
phone's state. It cannot read anything back (no response carries a stored
record), cannot touch another device, and cannot reach the admin API, the MCP or
the calendar. The route reads no record in order to answer.

The thief chooses every string it sends, and **Health Connect free text is
untrusted input that reaches the MCP client.** Titles, notes, nutrition names, the
names of the apps that wrote a record and the device description sit inside sealed
payloads, but the Health Connect MCP tools return them to the assistant as
written. A forged or merely hostile record can therefore carry instructions aimed
at the model, exactly as a prose field in a FHIR resource can (see Known limits).
Two things are attacker-choosable in the clear: the record **type** name (any
string of up to 64 letters, digits and `_.:-` starting with a letter, because the
Worker keeps a type it does not recognise rather than dropping it, and the sync
report may name up to 500 types) and the **app version** string (64 characters).
Both reach the Phone page and the MCP tools. Revoke the device when a phone is
lost, which stops new uploads at once; batches already queued are still applied,
so wipe it if its data cannot be trusted. The token is as sensitive as a write
credential to that device, not as a read credential to the record.

**Single exposure choke point.** Every MCP tool result passes through one
server-side filter before serialisation, which applies the deny-list (by tool,
resource type, field path, or health system) held in the `mcp_policy` table. Filtering
happens on the server, never in the client or the prompt, and applies equally to
normalised output and to raw FHIR passthrough. Tests assert that denied data does
not appear in a response. A field rule can reach any depth — keys inside arrays of
objects, arrays inside arrays, every FHIR `value[x]` variant — and a named path
segment that meets an array is applied to every element, so a path written
without `[]` cannot silently match nothing. Redaction removes the key; it never
leaves a placeholder a model could read as data or a `jq` program could select. A
rule written in one vocabulary is translated into the other (renames, and
normalised text rendered from a raw coding or reference), so one rule strips both
shapes; a rule that could match nothing is refused at write time. A field rule's
warning names its path, never its tool or health system scope.

`raw: true` is the FHIR resource minus the policy, and that includes every name
a resource copies from another one. Every `Reference` anywhere in a raw resource
— nested, in arrays, in extensions, in contained resources — is judged by the
type it points at (from `reference`, relative, absolute or `#contained`, or
from `type`): its `display` and `identifier` are removed when that type is
denied, when it is the patient (or a related person) and a rule hides the
patient's name, or when it is a clinician (`Practitioner`, `PractitionerRole`,
`Person`) and those are denied or a rule hides a clinician's name or a field one
is rendered into. A reference whose type cannot be read fails closed: removed
whenever any person type is restricted. The normalised strings rendered from
those references (`requester`, `author`, `practitioners[].name`, …), and what
was read from a withheld resource itself (a clinician's specialty, a denied
Location's address), go with them — judged by the raw reference behind the item, or, where there is none,
by every type the field may point at. `contained[]` resources are filtered as
resources of their own type. A resource's narrative (`text`, rendered HTML no
path can reach into) is dropped whenever the policy withholds anything from
that resource or restricts any person's name. Each removal is a warning
(`policy_reference_display_removed:<Type>`, `policy_field_removed:<Type>.text`)
that never carries the value. See [docs/mcp.md](docs/mcp.md#names-inside-references-and-narratives).

**Previewing a rule reads real data, for the owner only.** The rule builder's
`POST /api/mcp/policy/structure` (key names of a tool's real answer) and
`POST /api/mcp/policy/preview` (a draft rule's before and after on one real item)
run the real tool through the in-memory MCP server, behind Access, the password
session and the CSRF guard. They write no audit row (they are not an assistant's
reads) and log nothing; the structure endpoint returns names only, never values;
and `get_document_text` is previewed on a synthetic item so a preview can never
spend a health system's metered document quota. A denied health system's visit can also reach an
allowed one's patient portal through a shared record, stored under the allowed
system; `get_appointments` and `get_health_summary` therefore match every
appointment against the denied systems' own Encounters and portal visits (read
for matching only, never returned) and drop any that is the same visit. See the
limits below for what that match cannot catch.

<a id="jq-cost-bounds"></a>**The `jq` argument runs a caller's program, bounded.** Every MCP tool accepts
an optional jq program (see [docs/mcp.md](docs/mcp.md)), so a third-party model
can now make this Worker execute code of its choosing. What limits it:

- _It sees only released data._ It runs after the exposure policy, on the
  filtered items, so it cannot reach a denied field, resource type or health
  system. A jq error message can quote a value, and that message is returned to
  the caller (a model cannot fix a filter otherwise) — but only a value from
  that same policy-filtered input. It is never logged.
- _It has no capabilities._ Real jq 1.8.2 compiled to wasm (jq-wasm, vendored
  under `worker/src/mcp/jq/vendor/`), with no `eval` and no run-time wasm
  compilation. Its "filesystem" is Emscripten's in-memory one with nothing in
  it but the input, its `$ENV` is Emscripten's fixed placeholder (no Worker
  secrets), and it has no network.
- _It is bounded in time and memory, per call._ The wasm is instrumented
  (`worker/scripts/build-jq-wasm.mjs`) to burn one unit of fuel per function entry and
  loop iteration and trap when it runs out; the budget is 100 million units
  plus 100 per input byte, capped at 2³¹−1 (a few seconds of CPU). Its linear
  memory is capped at 64 MiB, so an allocation bomb fails that call with
  `jq_out_of_memory` instead of taking the isolate's 128 MB with it. Each call
  gets a fresh instance, discarded afterwards, so a trapped run leaves no state
  behind. A program of the form `.[] | ...` over items too large to parse at
  once is run over them a piece at a time on that one instance (docs/mcp.md);
  the bounds do not multiply: the memory cap is the instance's, and the fuel is
  still one budget for the call (the same 100 million units plus 100 per input
  byte, counted across the pieces), with the 2³¹−1 cap then applying to each
  piece, since parsing alone would otherwise exhaust it near 250 MB of items.
  Because fuel makes the engine interruptible, no static pattern-matching
  of "dangerous" programs is attempted — that would be both incomplete and
  wrong about legitimate uses such as `limit(3; repeat(.))`. The program itself
  is capped at 4096 characters. The Worker's own CPU limit remains the last
  backstop. None of these bounds truncates data: a program that exceeds one
  fails with an explicit error, and the same call without `jq` returns
  everything.
- _It is audited without its text._ The audit row keeps the program's SHA-256,
  its length and the item counts in and out — not the program, which can name
  what the caller was looking for.

**Read-only by construction.** Every MCP tool is annotated `readOnlyHint` and
there is no code path from a tool call to a write, to a health system or to the
calendar.

**The "Try a tool" panel runs in a sandboxed, opaque-origin iframe.** The admin
UI's `/connectors` page lets the owner call a real MCP tool from the browser
(`worker/src/mcp/admin-call.ts` connects a real `McpServer` — the real zod schemas,
the real exposure policy, the real audit wrapper — to the SDK's own in-memory
transport, and every call is audited as `admin-console`, never bypassing the
choke point above). The tool's JSON argument editor and result viewer need
CodeMirror 6, and CodeMirror needs to inject styles at runtime with no CSP
nonce of its own to carry — which the app's main CSP, deliberately, has no
exception for. Rather than loosen `style-src` app-wide, that editor and viewer
are served as a second, self-contained page (`worker/shared/mcp-sandbox.ts`'s
`MCP_SANDBOX_PATH`, `/tool-sandbox`) with its own, narrower CSP
(`sandboxContentSecurityPolicy`, `worker/src/auth/security-headers.ts`) and
embedded by `worker/ui/components/McpToolTester.vue` in
`<iframe sandbox="allow-scripts">` — deliberately without `allow-same-origin`,
which gives the loaded document an opaque origin: no cookies, no session
storage, and `default-src`/`connect-src`/`img-src`/`font-src` all `'none'`
mean it could not call `/api` even if it had a session to call with. The one
relaxation anywhere in this app's CSP, `style-src 'unsafe-inline'`, lives only
on this route, and is safe only because every other directive there is
_more_ restrictive than the default policy, not less (see that function's own
comment for the full argument, including why `script-src` is a nonce rather
than `'self'` or an origin literal).

The parent does the authenticated `/api/mcp/tools/*` calls and hands the tool
schema, request and result to the frame with `postMessage`; the frame never
touches the network. Both directions validate the message's shape at runtime
(`isSandboxInboundMessage`/`isSandboxOutboundMessage`) and the parent checks
`event.source` against the iframe's own `contentWindow` — `event.origin` is
the literal string `"null"` for an opaque origin and cannot be used as an
identity check. The frame's own page is built by a _second_, separate Vite
config (`worker/vite.sandbox.config.ts`) that inlines its script and stylesheet
directly into the HTML with no `/assets/*` files of its own: a module script
loaded via `<script src>` is always fetched CORS-mode with credentials
"same-origin", and against this page's opaque origin that fetch is genuinely
cross-origin, so no cookie is sent and `ownerGate` answers with the login page
instead of the script — a failure with no console line and no failed network
entry, found only by comparing a working standalone load against a silently
blank embedded one. Inlining makes the top-level navigation (which, unlike a
subresource fetch, always carries credentials) the only request the page ever
makes; the inline script still needs its own CSP nonce, stamped on per
response by `worker/src/app.ts` with `HTMLRewriter`, since a static build cannot
bake in something that has to be fresh every time.

**Least privilege on the calendar.** Google is authorised only for
`calendar.events.owned` and a read-only calendar list. The sync additionally
refuses to read or modify any event that does not carry its own
`extendedProperties.private.healthy = "1"` marker, so it cannot touch an entry a
human created. It deletes in exactly one case: a duplicate of a visit another,
higher-precedence copy already has an event for, which is removed only after the
event is seen carrying that marker and the duplicate row's own key. A cancelled
or vanished visit is never deleted; it becomes a grey "Cancelled:" ghost.

**The phone app keeps the same discipline.** The companion app holds a read-only
Health Connect grant (it never writes to it), keeps the device token encrypted
under an AES-256-GCM key in the Android Keystore that cannot be exported (so a
copy of its data folder yields nothing), disables backups and device transfer so
the token is not copied off the phone, allows no cleartext traffic and takes only
an `https` pairing address in a release build (a debug build, whose application id
ends in `.debug`, alone also accepts the phone's own loopback, `localhost` and
`127.0.0.1`, for local development), reads the
pairing QR code with CameraX and ZXing on the device rather than a Google scanner
(which would bring usage reporting), and ships **no analytics, crash reporting or
third-party SDK that sends anything anywhere**. The only host it contacts is the
Worker it was paired with. A release is signed with a key the owner holds as
repository secrets (APK signature schemes v2 and v3, the latter so the key can be
rotated later); the key is an asset in its own right, since Android will not update
an app signed with a different one.

**Health Connect data goes through the same exposure choke point.** A device is a
source, not a health system, and appears in an MCP answer's `coverage` as
`device:<id>` with `hc:<Type>` resource types, so the deny-list can withhold a
tool, a type, a phone or a field exactly as it does for a FHIR resource: a rule
may name one of the Health Connect tools, an `hc:<Type>` resource type (the
rule builder lists every record type the app maps, 40, and the daily summary, 41 in
all, whether or not a record of one has arrived yet), a phone as a source
(`device:<id>`) and a field. A **field rule follows the measurement, not the
spelling**: the one reading is `systolic` on a sitting, inside `readings`, in
`data` of a raw record, in an aggregate's `values`, and on a daily summary row
that is not even tagged with its type, and a rule written in any of those removes
it under all of them, in every tool, including joined and derived values (the
heart rate on a night's row, the pulse on a blood-pressure reading). The map of
which field of which tool belongs to which type is `worker/src/policy/hc-fields.ts`,
and a test holds it to what the tools really emit. A rule that could reach nothing
(a misspelt type, a field the type does not have, an aggregate named as if it were
a type) is refused when it is saved rather than saved and silently ineffective.
A type the owner has not permitted to the app is reported as "not permitted",
never silently absent. [docs/mcp.md](docs/mcp.md) has the rule syntax.

**Alert cards.** Two conditions open a Trello card and complete it when they clear:
a connection that needs reconnecting, and a phone whose uploads are parked. What
the card says leaves this system's encryption and is plaintext at Trello. A
reconnect card carries the health system's display name, as the owner entered it. A
parked-uploads card carries the name the owner gave the phone, how many uploads
are parked, a stable error code, the time in UTC, and the link to the Phone page. It
carries **no id, record type, value or origin app**, and the link is the page's own
address with nothing in it that names the device. So Trello learns that a phone with that
name has uploads waiting, never what they hold. Choose a phone's name accordingly:
it is the one free-text field on a card.

**No PHI in logs.** Logs are structured JSON, one object per line, and every
field passes through a redactor (`worker/src/lib/log.ts`) before it is written. The
guarantee is two parts, and it is worth being precise about which is which:

- _Enforced_ by the redactor: keys that name a credential (`token`, `secret`,
  `password`, `authorization`, `cookie`, `refresh`, `verifier`, `api_key`,
  `private`, `email`), keys that name a host, a domain or an origin (`domain`,
  `hostname`, `origin` anywhere in the name, and `host` as an exact key — a
  sending domain names a health system, and "ghosted" contains "host", which is
  why that one is exact), the exact keys `code` and `state`, and keys naming a
  patient or FHIR identifier are replaced wholesale. The corollary of `code`
  being dropped: every stable error code this project logs travels as
  `errorCode`, never as `code`. By shape, it strips
  `Bearer`/`Basic` credentials, the value of a credential-bearing query
  parameter (`?code=`, `access_token=`, `token=`…), anything address-shaped, and
  any long opaque run — 32 or more characters of base64url, dots included, which
  is what a JWT (`a.b.c`) and a `ya29.`-prefixed Google token look like — whether
  it is the whole value or embedded in a sentence. `/` and `:` end a run, so a
  request path and a URL's host stay readable while a credential inside one does
  not. Nesting deeper than six levels
  is dropped, so a resource handed to the logger by mistake cannot be serialised.
- _Convention_, not enforcement: callers pass counts, ids of this app's own
  rows, durations, HTTP statuses and stable error codes, and nothing else. This
  is not an allowlist — an unrecognised key with an innocuous-looking value is
  written as given — so clinical content, practitioner names, addresses and
  organisation identities must not be handed to the logger at all. Reviews check
  new log calls against that rule.

The ingest route and the Health Connect runner log only this app's own device id,
batch ids, counts, byte sizes, durations and stable `errorCode`s: never a token,
a record id, a value or an origin app's package name. A token is also kept out of
the admin API's logs (a response that carries one is `no-store` and no handler
logs a body).

`worker/test/unit/lib/log.test.ts` pins every rule above, including a JWT, a `ya29.`
token, a callback URL carrying `?code=`, and a 24-character Epic patient id under
a key that shape alone would not catch. The MCP audit trail records _that_ a tool
ran, by whom, against which health systems, and how many rows came back — never the
rows.

**Dependency updates merge themselves under a rule, and only as strongly as the
required checks.** A Dependabot pull request is approved and set to auto-merge with
no human approval when nothing in it is a major bump, or when everything in it is a
development dependency; a major bump of anything that ships is left for a person
(`.github/workflows/dependabot-automerge.yml`). The merge itself waits for the
branch's required status checks and never bypasses them, so "CI passes" means those
and no others. The `check` job (lint, types, unit and integration tests, the build)
runs the Worker; the Android project is built and tested only by the separate
`android` job, so a Gradle bump is gated by Android's tests and lint only if that
job is made a required check in the repository's branch protection. That is a
setting of the GitHub repository, not of this one, and it is not claimed here to be
set.

**No personal data in the repository.** Endpoints, organisation identities, the
Access team domain and AUD, credentials, timezone and location are all runtime
configuration. gitleaks runs on staged changes in a pre-commit hook and over full
history in CI.

## Known limits

- **Health Connect: the clear columns are a pattern of life.** The record types a
  phone produces, the hour each was recorded in, the start and end of every sleep
  and workout, per-type counts, and each upload's time and size are not hidden
  (see "Health Connect data: what is clear and why"). They hold no value, name or
  place. Whoever can read D1 can see when the owner slept and exercised, though
  not how well.
- **Health Connect: a device token authorises writes.** See above: a stolen token
  cannot read, but can inject false records, delete records it knows the ids of,
  and misreport the phone's state, for its own device, until it is revoked (and
  what it already queued is still applied). There is no signature on the data
  itself; Health Connect offers none the Worker could check. Nothing caps the
  total a device may store, so a stolen token can also spend storage, at up to 120
  requests a minute of up to 8 MiB each. Parked batches stay in the queue table and
  are not counted by the backpressure check.
- **Health Connect free text is untrusted.** The exposure policy removes types and
  fields; it does not scrub prose, and the Health Connect tools return titles,
  notes, app names and device descriptions as the phone sent them. A hostile app on
  the phone, or a forged upload, can plant text that tries to instruct the
  assistant reading it. The record type name and the app version string are also
  attacker-choosable clear columns.
- **The rate limit is a fixed window.** 120 requests per 60 seconds per device,
  restarted by the first request after a window ends, so a burst of up to twice
  that can straddle a boundary.
- **The upload route has no throttle for failed guesses.** Rate limiting is per
  authenticated device. An unauthenticated caller costs a shape check, or for a
  well-formed token one primary-key read and a digest comparison; with a 256-bit
  secret there is nothing to find by guessing. Cloudflare's own platform
  protections are the only brake on volume.
- **A phone's data is only as good as the phone.** The app reads what Health
  Connect returns, from whichever app wrote it. Duplicates and artefacts are
  stored as written and flagged at query time; nothing is dropped on the way in.

- A ModMed portal is signed in to with the owner's username and password, posted
  to the OpenID Connect provider the practice's own sign-in document names. The
  admin card's confirm step shows that provider's origin beside the portal's,
  and the save has to echo it back: the server re-probes on every save and
  refuses (`portal_origin_unconfirmed`) a provider that is neither the one just
  confirmed nor the one already stored. Every sign-in re-reads the document and
  refuses the same way if it names anywhere else -- which raises the reconnect
  card -- and every form POST of the sign-in, the password's above all, must
  target that provider's origin or it is not sent (`portal_redirected_offsite`).
  A practice that moves its sign-in therefore cannot silently relocate the
  password. The resulting access
  and refresh tokens sit in the sealed cookie jar and are as sensitive as the
  password for their (short) lifetime. The portal's own "am I signed in" endpoint
  answers `true` to any bearer token, so it is never used as proof of a session.
- The exposure policy removes structured fields, references and narratives; it
  does not scrub free prose. A name a clinician typed into a report's
  `conclusion`, a note, a document's text (`get_document_text`) or a secure
  message's `body` or `subject` (`get_messages`, `get_message_thread`) is
  returned as written unless that field is hidden or the tool denied; a
  `get_messages` preview and `search` are built from the body the policy
  released, so hiding the message field `body` removes both. A message's sender and care team are
  structured and are withheld by the name rules; a signature inside the body is
  prose.
- A secure message two portals show is recognised as one only by identical
  content (instant, author role, text). A copy of a denied health system's
  message is dropped only when that system's own copy is stored, as with visits;
  a linked organisation that is not connected has no copy to match against, so
  its messages are answered as the showing portal's, marked `firstParty: false`.

- `DATA_KEY` has no key id in the envelope, so rotating it invalidates existing
  sealed columns and moves every blinded value. Rotation currently means
  re-authorising every connection, dropping the cache and letting the calendar
  re-pair.
- A blind is deterministic: two rows holding the same value are visibly equal
  (every calendar row on one calendar has the same `calendar_id`). That is the
  point -- it is what keeps the lookups indexed -- and it discloses equality,
  never the value.
- Row counts, the size class of a sealed clinical payload, and this app's own
  timestamps are not hidden. Padding applies to short, human-chosen values;
  cached FHIR resources are not padded.
- **D1 Time Travel keeps the past.** D1 can restore any point in its retention
  window (30 days on the Workers Paid plan), which means the plaintext that
  migration 0007 and its backfill rewrote -- the owner's calendar id, timezone,
  the health systems' names and URLs, the patient's FHIR ids, visit numbers and
  times -- stays recoverable by anyone with access to this account's D1 until
  that window has passed. The same is true of any value any migration
  overwrites.
- **A `health_system` deny rule cannot catch a copy it cannot attribute.** When
  an allowed health system's portal lists a denied one's visit, the copy is
  dropped only if the denied system has its own record of that visit stored (a
  cached Encounter or a portal visit) to match it against. A portal copy does
  not say which organisation owns it -- at most a guessed "external" flag, and
  `via` is the portal that listed it, not the owner -- so if the denied system
  is not connected, or its portal pass has never stored the visit, the copy is
  answered as the listing system's. The match is also the cross-organisation
  dedupe's, so it errs the safe way: an allowed visit at the same time and
  department as a denied one is hidden as well.
- D1 has no per-row access control; the encryption is what stands in for it.
- The consent page authorises the whole `health:read` scope. There is no
  per-tool consent granularity beyond the deny-list the owner sets.

## Reporting a vulnerability

Please do **not** open a public issue.

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability), which opens a draft
advisory only the maintainer can see.

Please include what you found, how to reproduce it, and what an attacker could
reach. Expect an acknowledgement within a few days. This is a personal project
with no bounty programme, but credit in the advisory is yours if you want it.
