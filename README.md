# Healthy

A single-tenant Cloudflare Worker that reads one person's own medical record
from their patient portals and does two things with it: keeps their upcoming
appointments in sync on their own Google Calendar, and serves the whole
aggregated record read-only to an AI assistant over MCP. It talks to health
systems the same way MyChart's own app does — patient-facing SMART on FHIR,
authorised by the account owner — so it can only ever read what that person
has already consented to share about themselves. There is no multi-tenancy,
no sign-up, and no shared database: one deployment is one person's data.

**Status: early.** The toolchain, schema, sync engine, MCP server and admin UI
are largely in place; hardening and the first real deployment are ongoing.

## Features

- **Appointment sync.** Polls each connected health system hourly for
  upcoming and recently-past encounters and projects them onto a Google
  Calendar, titled and described from a configurable template. Events are
  created, patched when details change, and — when an appointment is
  cancelled or simply vanishes from the portal — turned into a greyed-out
  "Cancelled:" ghost rather than deleted, so the calendar keeps its history.
  The one thing the sync deletes is a duplicate — a second copy of a visit
  another, better source already has an event for — because that visit is not
  cancelled and must appear exactly once.
- **Read-only MCP.** Serves the aggregated record over MCP (Streamable HTTP)
  with its own OAuth flow, so an assistant such as Claude can answer
  questions about medications, labs, conditions, and appointments across
  every connected health system — without ever being handed a credential.
  A server-side deny-list can withhold whole tools, resource types,
  providers, or individual fields before anything is serialised.
- **Re-auth alerts.** When a connection's refresh token stops working, opens
  a Trello card with a one-click reconnect link, and closes it automatically
  once the connection is restored.
- **Admin UI.** A small Vue SPA, served by the Worker, for adding
  connections, choosing the target calendar, tuning how events look, and
  reviewing what the MCP has been asked and what it withheld.

## Architecture

```
   owner's browser                              claude.ai / Claude Code
         |                                          (MCP client)
   Cloudflare Access (SSO)                              |
         |                                     OAuth (health:read), HTTPS
   password session                                     |
         v                                              v
  +---------------------------------------------------------------------+
  |                     Cloudflare Worker  "healthy"                    |
  |                                                                     |
  |   Hono app                            OAuthProvider                |
  |   - admin API        /api/*           - /mcp*        --> HealthyMcp |
  |   - SPA (assets)      /*              - /oauth/token       (Durable |
  |   - OAuth callbacks  /oauth/*         - /oauth/register     Object, |
  |   - public pages     /about /health   - /.well-known/*      SQLite) |
  |         |                  |                              |         |
  +---------|------------------|------------------------------|---------+
            |                  |                              |
            v                  v                              v
      Epic FHIR APIs     Google Calendar                MCP tools
   (patient SMART on     (owner's primary          -> policy filter (deny-list)
    FHIR, per org)     calendar, its own events)   -> normalized or raw FHIR

                 Trello  (re-auth alert cards, opened by the sync engine)

  Storage:  D1 "healthy"      — providers, connections, FHIR cache, audit, run log, settings
            Workers KV "OAUTH_KV" — MCP OAuth client registrations and grants
  Cron:     hourly  "7 * * * *"   — token keepalive, then an Encounter-only appointment sync
            daily   "23 6 * * *"  — full-scope FHIR refresh that repopulates the MCP cache
```

One Worker does everything. Requests arrive at a custom domain behind
Cloudflare Access, pass a password gate, and are handled by a Hono app that
serves the admin API and the built SPA. `@cloudflare/workers-oauth-provider`
sits in front of the same Worker and owns the MCP-facing OAuth surface
(`/mcp*`, `/oauth/token`, `/oauth/register`, `/.well-known/*`), so an AI
client — which cannot complete an interactive Access login — never has to.
The MCP server itself lives in a SQLite-backed Durable Object.

- **Storage.** Cloudflare D1 for everything durable; Workers KV for MCP OAuth
  state; Durable Objects for the MCP session and for driving a manual full
  refresh.
- **Long work.** A calendar sync fits in the request's `waitUntil`. A full
  refresh of a large record does not — `waitUntil` is cancelled about thirty
  seconds after the response — so the manual refresh button queues the work on
  a per-provider Durable Object whose alarm does one bounded chunk per
  invocation and re-arms until the record is walked. The nightly refresh runs
  straight through, because a cron invocation has the wall clock for it.
- **Encryption.** Tokens, per-organisation client secrets, patient
  identifiers and every cached clinical payload are AES-GCM-256 encrypted by
  the application before they reach D1, with the AAD bound to the table,
  column and row. See [SECURITY.md](SECURITY.md).
- **Vendor abstraction.** Health systems sit behind a `ProviderAdapter`
  interface. Epic is the only implementation today.

## Quick start

### Prerequisites

- Node 26 (see `.node-version`)
- A Cloudflare account on the **Workers Paid** plan, with a domain on
  Cloudflare
- A Google Cloud project
- A developer account at [fhir.epic.com](https://fhir.epic.com)
- [gitleaks](https://github.com/gitleaks/gitleaks) on your `PATH` (the
  pre-commit hook uses it)

### 1. Clone and install

```sh
git clone https://github.com/pmaxhogan/healthy.git
cd healthy
npm ci
```

`npm ci` also installs the git hooks (see `prepare` in `package.json`).

### 2. Cloudflare resources

Create the D1 database, the KV namespace, and a custom domain, and wire up
Cloudflare Access — the full walkthrough, including the exact paths that must
bypass Access, is in **[docs/setup-cloudflare.md](docs/setup-cloudflare.md)**.

### 3. Secrets

None of these live in the repository. Set them with
`wrangler secret put <NAME>`, or in a gitignored `.dev.vars` for local
development (one `NAME=value` line each).

| Secret                    | Where the value comes from                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN`   | Your Access team domain (`<team>.cloudflareaccess.com`). [setup-cloudflare.md](docs/setup-cloudflare.md) |
| `CF_ACCESS_AUD`           | The Access application's Audience (AUD) tag. [setup-cloudflare.md](docs/setup-cloudflare.md)             |
| `CF_ACCESS_ALLOWED_EMAIL` | The one identity allowed through — checked in the Worker, not just Access.                               |
| `PASSWORD_HASH`           | `npm run set-password` (prompts for a password, uploads the hash).                                       |
| `SESSION_SECRET`          | Any long random string, e.g. `openssl rand -base64 32`.                                                  |
| `DATA_KEY`                | `npm run gen-data-key -- --put` (mints and uploads the AES-GCM key).                                     |
| `GOOGLE_CLIENT_ID`        | The OAuth client from [setup-google.md](docs/setup-google.md).                                           |
| `GOOGLE_CLIENT_SECRET`    | The OAuth client from [setup-google.md](docs/setup-google.md).                                           |
| `EPIC_CLIENT_ID_PROD`     | Your app's production client id. [setup-epic.md](docs/setup-epic.md)                                     |
| `EPIC_CLIENT_ID_NONPROD`  | Your app's sandbox client id. [setup-epic.md](docs/setup-epic.md)                                        |
| `TRELLO_KEY`              | Trello API key. [setup-trello.md](docs/setup-trello.md)                                                  |
| `TRELLO_TOKEN`            | Trello API token. [setup-trello.md](docs/setup-trello.md)                                                |
| `TRELLO_MUST_LIST_ID`     | The Trello list new alert cards open in. [setup-trello.md](docs/setup-trello.md)                         |
| `TRELLO_DONE_LIST_ID`     | The Trello list resolved alert cards move to. [setup-trello.md](docs/setup-trello.md)                    |

Per-organisation Epic client secrets are **not** Worker secrets: they are
entered in the admin UI and stored encrypted in D1, one per health system,
rotated independently. When the admin UI is not an option (no live browser
session against that environment), `npm run set-provider-secret -- --provider
<id> --remote` sets the same column from the command line: it seals the value
exactly as the Worker does and writes it with `wrangler d1 execute`. The
secret is read from the `PROVIDER_CLIENT_SECRET` environment variable, or
from stdin if that is unset, so it is never a command-line argument or in
shell history, and the command never prints it back.

A patient-portal login, where one is configured, is stored the same way and for
the same reasons: sealed in D1 per organisation, never a Worker secret, and
never readable back out of the admin UI. The portal is a scrape rather than an
API, so the row also holds the mount the login page was discovered at, a
sealed cookie jar — which carries the "trust this device" cookie, and is
therefore treated as being exactly as sensitive as the password — and,
optionally, an address to email a verification code to, for the rare
deployment whose own login flow will not say. `npm run
set-portal-credentials -- --provider <id> --remote` is the no-browser
equivalent of the admin UI's portal card. The username comes from
`PORTAL_USERNAME` or the first line of stdin and the password from
`PORTAL_PASSWORD` or the rest of it, so neither is ever a command-line argument
or in shell history; add `--mfa-contact` (with `PORTAL_MFA_CONTACT` set) to
also set that email address:

```sh
{ echo "$portal_user"; echo "$portal_pass"; } |
  npm run set-portal-credentials -- --provider <id> --remote
```

Storing credentials this way resets the session state and drops any stored
cookie jar, because a changed password invalidates whatever the old session
was. With `--local`, run `npm run migrate:local` first or the table will not
exist yet.

### 4. Run it

```sh
npm run migrate:local  # apply the schema to the local D1
npm run dev:worker     # wrangler dev on :8787
npm run dev            # Vite dev server for the SPA (proxies API calls to :8787)
```

### 5. Deploy

```sh
npm run deploy   # runs the remote migration, then wrangler deploy
```

Or connect the repository to **Cloudflare Workers Builds** with build
command `npm run check` and deploy command `npm run deploy` — see
[docs/setup-cloudflare.md](docs/setup-cloudflare.md).

Then, in the admin UI: add your health systems and connect each one
([docs/setup-epic.md](docs/setup-epic.md)), connect Google
([docs/setup-google.md](docs/setup-google.md)), and wire up Trello alerts
([docs/setup-trello.md](docs/setup-trello.md)).

### MyChart portal (optional)

For a health system that also has a patient portal, the **Providers** page
shows a **MyChart portal** card under that provider: a portal login URL
(prefilled when one is already known), a username, a password and, optionally,
an email address to send verification codes to when it differs from the login
and the domain those codes arrive from — most deployments never need either of
those last two.

**Saving takes two clicks, on purpose.** **Save** probes the URL without
sending anything and reports where the portal actually is — a login URL often
redirects, sometimes to a different host — and **Confirm and save** stores the
login against _that_ origin. It is the origin your portal password is sent to
on every later sign-in, so it is worth reading before you agree to it. (A
redirect that leaves the site you pasted, or leaves https, is refused outright
rather than confirmed.) Changing only the password against a portal already
stored needs no second click.

Then **Sign in now** — the card polls while the sign-in is in progress and
shows what it is waiting on.

If the portal asks for an emailed verification code, that code has to reach
this Worker, not just your inbox: set up the one-time Gmail forwarding filter
on the **Mail** page first ([docs/mail.md](docs/mail.md)) so the code arrives
and the sign-in can pick it up on its own. Add the sending domain to the
allowlist there — the shipped list is Gmail's own confirmation sender and
nothing else — and the first code the portal accepts binds that sender to this
account, so nobody else's message can ever be claimed as its code. Once a session is established, the
hourly sync picks up that provider's upcoming portal visits the same way it
does FHIR encounters.

## Documentation

- **[docs/setup-epic.md](docs/setup-epic.md)** — registering the app on
  fhir.epic.com, and connecting a provider.
- **[docs/setup-google.md](docs/setup-google.md)** — the GCP project, OAuth
  consent screen, and calendar scopes.
- **[docs/setup-cloudflare.md](docs/setup-cloudflare.md)** — D1/KV/DO,
  custom domain, Access apps, Workers Builds.
- **[docs/setup-trello.md](docs/setup-trello.md)** — the board, key/token,
  and list ids the alert flow needs.
- **[docs/mcp.md](docs/mcp.md)** — connecting a claude.ai connector, the
  consent flow, and the exposure policy's deny-list syntax.
- **[docs/operations.md](docs/operations.md)** — cron cadence, backoff,
  alerts, re-auth, ghost events, rotating secrets, wiping data.
- **[docs/development.md](docs/development.md)** — repo layout, `npm run
check`, tests, fixtures, and the dependency-update pipeline.
- **[SECURITY.md](SECURITY.md)** — the threat model.

## Development

```sh
npm run dev           # Vite dev server for the SPA
npm run dev:worker    # wrangler dev on :8787
npm run check         # lint, typecheck, knip, test, build -- what CI runs
npm run fix           # eslint --fix + prettier --write
```

`npm run check` is the only gate that matters: it is what CI runs, what the
pre-push hook runs, and what Workers Builds runs before deploying. See
[docs/development.md](docs/development.md) for the rest.

## Licence

MIT. See [LICENSE](LICENSE).
