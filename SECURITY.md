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

| Asset                                 | Store          | At rest                                          |
| ------------------------------------- | -------------- | ------------------------------------------------ |
| Health-system and Google OAuth tokens | D1             | AES-GCM-256, application layer                   |
| Per-organisation client secrets       | D1             | AES-GCM-256, application layer                   |
| Patient identifiers                   | D1             | AES-GCM-256, application layer                   |
| Cached FHIR resources                 | D1             | AES-GCM-256, application layer                   |
| Patient-portal upcoming visits        | D1             | AES-GCM-256, application layer                   |
| MCP access and refresh tokens         | Workers KV     | Managed by `@cloudflare/workers-oauth-provider`  |
| Admin password                        | Worker secret  | PBKDF2-SHA256, 100k iterations, per-hash salt    |
| Encryption key, API credentials       | Worker secrets | Cloudflare-managed                               |
| Configuration (calendar, templates)   | D1 `settings`  | Plaintext (non-sensitive by construction)        |
| Patient-portal login and cookie jar   | D1             | AES-GCM-256, application layer                   |
| Portal verification-code sender       | D1             | AES-GCM-256, application layer                   |
| Inbound mail: code, sender, subject   | D1             | AES-GCM-256, application layer                   |
| Full-refresh progress                 | Durable Object | Plaintext: provider ids, a run id, counts, codes |
| Portal sign-in progress               | Durable Object | Plaintext: a provider id, a step, counts, codes  |

Four tables hold values that are **plaintext on purpose**, and it is worth
saying which and why rather than leaving it to be inferred:

- `portal_accounts.base_url`, `mount_path` and `endpoint_json`, and the
  `portal_api_base_path` setting. Each names the organisation, which is the
  category this repository is otherwise strictest about — but they are also
  what the sign-in reads on every hop to build a URL, and sealing them would
  put a decrypt in the path of every request without changing who can read a
  D1 snapshot that already contains the sealed columns' ciphertext. The
  credentials, the cookie jar, the MFA contact and the expected code sender in
  the same row are all sealed.
- `mail_inbox.kind`, `received_at`, `consumed_at`, `expires_at` and
  `raw_size`: a classification, three timestamps and a byte count, none of
  which names anyone. The sender, the subject and the code are sealed. The
  legacy `from_addr` / `subject` columns are kept only until a migration can
  drop them and are written empty.
- `portal_visits.csn`, `start_at`, `status`, `state` and the timestamps: the
  portal's visit number (already stored the same way as
  `calendar_events.portal_csn`), the visit's start (as `calendar_events`
  stores it), a word from a fixed status vocabulary, and bookkeeping. The
  visit itself — practitioner, department, address, phone — is only in
  `payload_enc`, sealed against `portal_visits.payload_enc.<providerId>:<csn>`.
  Rows are purged a year after the visit.
- The two Durable Objects (`FULL_REFRESH`, `PORTAL_SIGNIN`) hold a provider
  id, a step name, counts and stable codes. Never a credential, never an
  emailed code, never a byte of a portal's HTML. `PORTAL_SIGNIN` additionally
  holds the sign-in gate: one lock per provider that both the admin button and
  the hourly cron take, so two sign-ins cannot each pass the daily attempt check
  before either increments it (and so the second `SendCode` cannot invalidate the
  code the first is waiting for).

**Encryption at rest is applied by the application, not just by the platform.**
Every sensitive column is sealed before it reaches D1 as
`v1:base64url(iv || ciphertext)`, with the AES-GCM additional authenticated data
bound to `<table>.<column>.<rowId>`. That binding means a ciphertext cannot be
lifted from one row or column and replayed in another: decryption with the wrong
AAD fails, and there is a test that asserts it does.

## Controls

**Two-factor admin gate.** Every administrative route requires _both_ a valid
Cloudflare Access JWT — verified in the Worker against the team's signing keys,
checking issuer, `aud`, expiry and the email claim, rather than trusting a
request header — _and_ a password-derived session. Access alone is not treated as
sufficient, so an Access misconfiguration is not by itself a breach. Sessions are
HMAC-signed cookies, `SameSite=Lax`, `Secure`, `HttpOnly`. State-changing
`/api` calls additionally require a custom header and a same-origin `Origin`
check. Login attempts are rate-limited per client, keyed by a hash of the IP
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
resource type, field path, or provider) held in the `mcp_policy` table. Filtering
happens on the server, never in the client or the prompt, and applies equally to
normalised output and to raw FHIR passthrough. Tests assert that denied data does
not appear in a response.

**Read-only by construction.** Every MCP tool is annotated `readOnlyHint` and
there is no code path from a tool call to a write, to a health system or to the
calendar.

**Least privilege on the calendar.** Google is authorised only for
`calendar.events.owned` and a read-only calendar list. The sync additionally
refuses to read or modify any event that does not carry its own
`extendedProperties.private.healthy = "1"` marker, so it cannot touch an entry a
human created, and it never deletes.

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
ran, by whom, against which providers, and how many rows came back — never the
rows.

**No personal data in the repository.** Endpoints, organisation identities, the
Access team domain and AUD, credentials, timezone and location are all runtime
configuration. gitleaks runs on staged changes in a pre-commit hook and over full
history in CI.

## Known limits

- `DATA_KEY` has no key id in the envelope, so rotating it invalidates existing
  sealed columns. Rotation currently means re-authorising every connection and
  dropping the cache.
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
