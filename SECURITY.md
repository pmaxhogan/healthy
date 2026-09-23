# Security

This application handles one person's health records. The threat model is
written down here because most of the design decisions in the codebase only make
sense in light of it.

## What is being protected

A single owner's clinical record: appointments, conditions, medications, lab
results, and the OAuth credentials that grant access to the health systems it was
read from. There is no other user's data in the system, which removes a whole
class of authorisation bugs and concentrates the risk on two things: the admin
surface, and the MCP surface.

## Assets and where they live

Three treatments, and every column is in exactly one of them:

- **Sealed**: AES-GCM-256 in the application, `v1:`/`v2:` envelope, AAD bound to
  `<table>.<column>.<rowId>` (see below). `v2:` pads the plaintext to a size
  bucket first (64, 128, 256, ... bytes), so the ciphertext stops giving away a
  short value's exact length.
- **Blinded**: a keyed HMAC-SHA256 under a key derived from `DATA_KEY` with HKDF
  (info `healthy/blind/v1`) — never the AES key itself. Deterministic, so the
  column is still a primary key, an index and an exact match, but a snapshot
  reader cannot compute or confirm one without the key. Every input includes the
  health system's row id, so the same upstream id at two organisations blinds to
  two unrelated values. Stored as `~` plus base64url (128 bits for an id, 256 for
  a digest). See `worker/db/blind.ts`.
- **Plaintext**: listed below, each with the reason.

| Asset                                                                                       | Store               | At rest                                                  |
| ------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| Health-system and Google OAuth tokens                                                       | D1                  | Sealed                                                   |
| Per-organisation client secrets                                                             | D1                  | Sealed, padded                                           |
| Health-system identity: name, FHIR base URL, brand, portal URL, config                      | D1 `health_systems` | Sealed in place, padded                                  |
| Patient FHIR id on the connection                                                           | D1                  | Sealed, padded                                           |
| Cached FHIR resources (including the Patient)                                               | D1                  | Payload sealed; resource id blinded; content hash keyed  |
| Patient-portal upcoming visits                                                              | D1                  | Payload sealed; visit number blinded; content hash keyed |
| Calendar bookkeeping: event key, encounter, visit number, calendar id                       | D1                  | Blinded; fingerprint keyed                               |
| Calendar bookkeeping: a row's start and real calendar id                                    | D1                  | Sealed together, padded (`calendar_events.detail_enc`)   |
| Google event marker (`extendedProperties.private.key`, `fp`)                                | Google              | The blinded event key and the keyed fingerprint          |
| Settings that name the owner: calendar id, timezone, mail sender allowlist, portal API path | D1 `settings`       | Sealed in place, padded                                  |
| Other settings: templates, colour ids, window, offsets, limits, backoff, MCP switch         | D1 `settings`       | Plaintext (names no one; see below)                      |
| Patient-portal login, MFA contact, expected code sender                                     | D1                  | Sealed, padded                                           |
| Patient-portal cookie jar                                                                   | D1                  | Sealed                                                   |
| Patient-portal location: base URL, mount path, discovered endpoint                          | D1                  | Sealed in place, padded                                  |
| Inbound mail: code, sender, subject                                                         | D1                  | Sealed, padded                                           |
| Login rate-limit key                                                                        | D1                  | Keyed digest of the client IP                            |
| MCP access and refresh tokens                                                               | Workers KV          | Managed by `@cloudflare/workers-oauth-health_system`     |
| Admin password                                                                              | Worker secret       | PBKDF2-SHA256, 100k iterations, per-hash salt            |
| Encryption key, API credentials                                                             | Worker secrets      | Cloudflare-managed                                       |
| Full-refresh progress                                                                       | Durable Object      | Plaintext: health system ids, a run id, counts, codes    |
| Portal sign-in progress                                                                     | Durable Object      | Plaintext: a health system id, a step, counts, codes     |

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
- **`portal_accounts.session_state`, the attempt counters and the
  timestamps**: whether the session is live, how many sign-ins were spent
  today, and how many emailed codes the scheduled sync asked for and when.
- **`mail_inbox.kind`, `received_at`, `consumed_at`, `expires_at` and
  `raw_size`**: a classification, three timestamps and a byte count. The legacy
  plaintext `from_addr` / `subject` columns were blanked by migration 0007 and
  dropped by 0008.
- **`mcp_audit`, `run_log`**: that a tool ran, by which client, how many rows
  came back, and each sync run's counts and error codes. The owner's activity
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

### The visit timeline

An appointment's start is sealed wherever it is stored, and each query that
used to read it plaintext was decided on its own:

- **The calendar window** (`calendar_events`). Both passes already read a
  health system's rows by `health_system_id` (indexed) and narrowed them to the
  window in memory, so the start moved into the sealed `detail_enc` with no new
  query and no new round trip: `list` opens each row it reads anyway. No
  plaintext bucket is kept; the old `start_at` column is dropped (0008).
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
for life.

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
`/oauth/register`, `/.well-known/*`, and the public pages. Those paths are
protected instead by the OAuth provider, which issues short-lived access tokens
against a consent grant the owner approved from behind the full gate. Anything
that can change state — including the consent page itself and every OAuth
callback — stays behind Access and the password.

**Single exposure choke point.** Every MCP tool result passes through one
server-side filter before serialisation, which applies the deny-list (by tool,
resource type, field path, or health system) held in the `mcp_policy` table. Filtering
happens on the server, never in the client or the prompt, and applies equally to
normalised output and to raw FHIR passthrough. Tests assert that denied data does
not appear in a response.

**Read-only by construction.** Every MCP tool is annotated `readOnlyHint` and
there is no code path from a tool call to a write, to a health system or to the
calendar.

**The "Try a tool" panel runs in a sandboxed, opaque-origin iframe.** The admin
UI's `/connectors` page lets the owner call a real MCP tool from the browser
(`worker/mcp/admin-call.ts` connects a real `McpServer` — the real zod schemas,
the real exposure policy, the real audit wrapper — to the SDK's own in-memory
transport, and every call is audited as `admin-console`, never bypassing the
choke point above). The tool's JSON argument editor and result viewer need
CodeMirror 6, and CodeMirror needs to inject styles at runtime with no CSP
nonce of its own to carry — which the app's main CSP, deliberately, has no
exception for. Rather than loosen `style-src` app-wide, that editor and viewer
are served as a second, self-contained page (`shared/mcp-sandbox.ts`'s
`MCP_SANDBOX_PATH`, `/tool-sandbox`) with its own, narrower CSP
(`sandboxContentSecurityPolicy`, `worker/auth/security-headers.ts`) and
embedded by `src/components/McpToolTester.vue` in
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
config (`vite.sandbox.config.ts`) that inlines its script and stylesheet
directly into the HTML with no `/assets/*` files of its own: a module script
loaded via `<script src>` is always fetched CORS-mode with credentials
"same-origin", and against this page's opaque origin that fetch is genuinely
cross-origin, so no cookie is sent and `ownerGate` answers with the login page
instead of the script — a failure with no console line and no failed network
entry, found only by comparing a working standalone load against a silently
blank embedded one. Inlining makes the top-level navigation (which, unlike a
subresource fetch, always carries credentials) the only request the page ever
makes; the inline script still needs its own CSP nonce, stamped on per
response by `worker/app.ts` with `HTMLRewriter`, since a static build cannot
bake in something that has to be fresh every time.

**Least privilege on the calendar.** Google is authorised only for
`calendar.events.owned` and a read-only calendar list. The sync additionally
refuses to read or modify any event that does not carry its own
`extendedProperties.private.healthy = "1"` marker, so it cannot touch an entry a
human created. It deletes in exactly one case: a duplicate of a visit another,
higher-precedence copy already has an event for, which is removed only after the
event is seen carrying that marker and the duplicate row's own key. A cancelled
or vanished visit is never deleted; it becomes a grey "Cancelled:" ghost.

**No PHI in logs.** Logs are structured JSON, one object per line, and every
field passes through a redactor (`worker/lib/log.ts`) before it is written. The
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

`test/unit/lib/log.test.ts` pins every rule above, including a JWT, a `ya29.`
token, a callback URL carrying `?code=`, and a 24-character Epic patient id under
a key that shape alone would not catch. The MCP audit trail records _that_ a tool
ran, by whom, against which health systems, and how many rows came back — never the
rows.

**No personal data in the repository.** Endpoints, organisation identities, the
Access team domain and AUD, credentials, timezone and location are all runtime
configuration. gitleaks runs on staged changes in a pre-commit hook and over full
history in CI.

## Known limits

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
