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

| Asset                                 | Store          | At rest                                         |
| ------------------------------------- | -------------- | ----------------------------------------------- |
| Health-system and Google OAuth tokens | D1             | AES-GCM-256, application layer                  |
| Per-organisation client secrets       | D1             | AES-GCM-256, application layer                  |
| Patient identifiers                   | D1             | AES-GCM-256, application layer                  |
| Cached FHIR resources                 | D1             | AES-GCM-256, application layer                  |
| MCP access and refresh tokens         | Workers KV     | Managed by `@cloudflare/workers-oauth-provider` |
| Admin password                        | Worker secret  | PBKDF2-SHA256, 600k iterations, per-hash salt   |
| Encryption key, API credentials       | Worker secrets | Cloudflare-managed                              |
| Configuration (calendar, templates)   | D1 `settings`  | Plaintext (non-sensitive by construction)       |

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
HMAC-signed cookies, `SameSite=Strict`, `Secure`, `HttpOnly`. State-changing
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

**No PHI in logs.** Logs are structured JSON with an explicit field allowlist.
Tokens, bearer headers, email addresses, patient identifiers, clinical content
and health-system names are never logged, and there are redaction tests that fail
if they appear. The MCP audit trail records _that_ a tool ran, by whom, against
which providers, and how many rows came back — never the rows.

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
