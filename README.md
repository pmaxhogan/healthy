# Healthy

A single-tenant Cloudflare Worker that reads one person's own medical record
from their patient portals and does two things with it: keeps their upcoming
appointments in sync on their own Google Calendar, and serves the whole
aggregated record to an AI assistant over MCP: read-only, apart from one tool
that lets the assistant ask for a sync sooner than the schedule. It talks to health
systems the same way MyChart's own app does — patient-facing SMART on FHIR,
authorised by the account owner — so it can only ever read what that person
has already consented to share about themselves. A small Android companion
app adds a second kind of source: the person's own Health Connect data
(heart rate, sleep, steps, blood pressure and the rest), pushed from their
phone in the background and served over the same MCP. There is no
multi-tenancy, no sign-up, and no shared database: one deployment is one
person's data.

This is a monorepo: the Cloudflare Worker and its admin UI are in
[`worker/`](worker), the Android companion app in [`android/`](android).

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
- **MCP, read-only but for one tool.** Serves the aggregated record over MCP (Streamable HTTP)
  with its own OAuth flow, so an assistant such as Claude can answer
  questions about medications, labs, conditions, and appointments across
  every connected health system — without ever being handed a credential.
  A server-side deny-list can withhold whole tools, resource types,
  health systems, phones, or individual fields before anything is serialised.
  It covers a phone's Health Connect data the same way: a rule can name a
  Health Connect tool, an `hc:<Type>` resource type, a phone as a source, or a
  field, and a field rule removes that measurement under every name it has in
  every tool, including the values joined or derived from it.
- **A sync on request.** One MCP tool acts rather than reads:
  `sync_health_systems` lets the assistant ask for a sync now, of one health
  system, several, or (only when it says `all: true`) every one. It names the
  kind each time (`ordinary`, the hourly appointment sync plus a read of an
  already signed-in portal; `full`, every resource type; or `portal`, the
  patient-portal pass alone) and there is no default. It is held to a durable
  cooldown and a daily limit per health system and per kind, is refused while a
  run is in flight or a health system is rate limiting the app, can never sign
  in to a portal, and has a dry run that reports what would happen. A `tool`
  rule in the deny-list switches it off. The numbers and the reasoning are in
  [SECURITY.md](SECURITY.md#mcp-sync-tool) and [docs/mcp.md](docs/mcp.md#asking-for-a-sync-sync_health_systems).
- **Secure messages.** Where a patient portal is connected, the hourly portal
  pass also reads its Message Center -- every folder, every conversation, every
  message -- with the session it already holds, and the MCP serves them
  (`get_messages` lists conversations with a preview of the newest message;
  `get_message_thread` returns one conversation in full;
  `get_message_attachment` returns an attached file the pass fetched and
  sealed), deduplicated across health systems, sealed at rest like everything
  else.
- **Health Connect from your phone.** The Android companion app
  ([docs/setup-android.md](docs/setup-android.md)) reads every Health Connect
  record type it is granted, in the background every 15 minutes, plus a
  full-history backfill you start from the app, and uploads it to this Worker. The Worker keeps every
  record sealed, with sealed rollups for fast queries, so an assistant can
  answer from the cloud copy with the phone off, through its own set of MCP
  tools (heart-rate series, sleep, exercise, blood pressure, daily summaries,
  data-quality flags — see [docs/mcp.md](docs/mcp.md)). Each phone has its own
  revocable token, paired by scanning a QR code (or pasting the same pairing
  code) from the admin UI's **Phone** page. An upload the Worker accepted but
  cannot apply is never deleted: it is set aside, the Phone page shows it with
  its error code and a **Retry** button, and the batches behind it carry on.
  Install the app with Obtainium:
  `obtainium://add/https://github.com/pmaxhogan/healthy`.
- **Alerts.** When a connection's refresh token stops working, opens a Trello
  card with a one-click reconnect link, and closes it automatically once the
  connection is restored. A sync that keeps failing for any other reason (three
  runs in a row) gets a card that says what is failing and completes itself on
  the next run that works. A phone whose uploads have been set aside gets a card
  of its own, which completes itself when nothing from the phone is waiting.
- **Admin UI.** A small Vue SPA, served by the Worker, for adding
  connections, choosing the target calendar, tuning how events look,
  pairing and managing phones (the **Phone** page), and reviewing what the
  MCP has been asked and what it withheld.

## Architecture

```
   owner's browser        Android phone              claude.ai / Claude Code
         |            (companion app,                    (MCP client)
   Cloudflare Access   Health Connect)                        |
         |                   |                      OAuth (health:read), HTTPS
   password session   device bearer token                     |
         |            POST /ingest/health-connect             |
         v                   v                                v
  +---------------------------------------------------------------------+
  |                     Cloudflare Worker  "healthy"                    |
  |                                                                     |
  |   Hono app                            OAuthProvider                |
  |   - admin API        /api/*           - /mcp*        --> HealthyMcp |
  |   - SPA (assets)      /*              - /oauth/token       (Durable |
  |   - OAuth callbacks  /oauth/*         - /oauth/register     Object, |
  |   - public pages     /about /health   - /.well-known/*      SQLite) |
  |   - ingest  /ingest/health-connect                                  |
  |         |                  |                              |         |
  +---------|------------------|------------------------------|---------+
            |                  |                              |
            v                  v                              v
      Epic FHIR APIs     Google Calendar                MCP tools
   (patient SMART on     (owner's primary          -> policy filter (deny-list)
    FHIR, per org)     calendar, its own events)   -> normalized or raw FHIR,
                                                      and Health Connect data

                 Trello  (re-auth alert cards, opened by the sync engine)

  Health Connect pipeline (phone -> Worker -> MCP):
     phone --gzip JSON--> /ingest/health-connect --> sealed queue (D1)
        --> HcIngestRunner (Durable Object, alarm-driven)
        --> sealed hour chunks + sealed rollups (D1) --> MCP tools

  Storage:  D1 "healthy"      — health_systems, connections, FHIR cache, audit, run log, settings,
                                devices and the sealed Health Connect store
            Workers KV "OAUTH_KV" — MCP OAuth client registrations and grants
  Cron:     hourly  "7 * * * *"   — token keepalive, then an Encounter-only appointment sync
            4 hours "23 2,6,10,14,18,22 * * *" — full-scope FHIR refresh that repopulates the MCP cache
            10 min  "*/10 * * * *" — patient-portal session keepalive (never signs in);
                                     also wakes the Health Connect ingest runners
```

One Worker does everything. Requests arrive at a custom domain behind
Cloudflare Access, pass a password gate, and are handled by a Hono app that
serves the admin API and the built SPA. `@cloudflare/workers-oauth-provider`
sits in front of the same Worker and owns the MCP-facing OAuth surface
(`/mcp*`, `/oauth/token`, `/oauth/register`, `/.well-known/*`), so an AI
client — which cannot complete an interactive Access login — never has to.
The MCP server itself lives in a SQLite-backed Durable Object.

The phone's upload is the one other machine-facing route. `POST
/ingest/health-connect` sits above the owner gate, bypasses Access, and is
authenticated by its own per-device bearer token instead; all that token can do
is queue batches (records, deletions by id and a sync report) for that one
device, and read nothing back. See [SECURITY.md](SECURITY.md).

- **Storage.** Cloudflare D1 for everything durable; Workers KV for MCP OAuth
  state; Durable Objects for the MCP session, for driving a manual full
  refresh, and for applying a phone's uploads.
- **Health Connect.** The route validates and seals a batch into a queue and
  acknowledges it; an alarm-driven Durable Object (one per device) then applies
  it, in order, into sealed hour chunks (every record, losslessly) and sealed
  rollups (hourly, daily, per-minute heart rate, sleep nights, exercise
  sessions); an hour too large for one row is split across rows, and rollups
  start to appear while a backfill is still arriving. A request cannot do that
  work itself: a backfill batch touches more rows than one request may. A batch
  that cannot be applied is parked, not deleted: the phone has already moved
  past it, so the queued copy is the only one. No new Worker secret is needed
  — a device's token lives in D1 as a hash, and its data is sealed with the
  existing `DATA_KEY`.
- **Long work.** A calendar sync fits in the request's `waitUntil`. A full
  refresh of a large record does not — `waitUntil` is cancelled about thirty
  seconds after the response — so the manual refresh button queues the work on
  a per-health system Durable Object whose alarm does one bounded chunk per
  invocation and re-arms until the record is walked. The nightly refresh runs
  straight through, because a cron invocation has the wall clock for it. A sync
  an MCP client asks for is queued the same way, on the same kind of object: a
  tool call is answered at once and the run happens on an alarm.
- **Encryption.** Tokens, per-organisation client secrets, patient
  identifiers, every cached clinical payload and every Health Connect record
  and rollup are AES-GCM-256 encrypted by
  the application before they reach D1, with the AAD bound to the table,
  column and row. See [SECURITY.md](SECURITY.md).
- **Vendor abstraction.** Health systems sit behind a `EhrAdapter`
  interface, with two implementations: Epic and ModMed's certified FHIR API.

## Repository layout

```
worker/    The Cloudflare project: src/ (Worker), ui/ (Vue admin SPA), shared/,
           migrations/, test/, scripts/, wrangler.jsonc, and its own package.json
android/   The companion app: a Gradle project (Kotlin, Compose), module app/
docs/      Setup, operations and development guides
.github/   CI (the Worker gate, gitleaks and the Android job), the Android release
           workflow, Dependabot and its auto-merge, the brands job
```

The repository root is an npm workspace over `worker/`: `npm run check`, `npm
run deploy` and the other scripts there fan into it. Gradle is separate and is
not part of `npm run check`; see [docs/development.md](docs/development.md).

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

None of these live in the repository. The Health Connect pipeline adds none: a
paired phone's token is minted in the admin UI and stored hashed in D1. Set them with
`wrangler secret put <NAME>`, or in a gitignored `worker/.dev.vars` for local
development (one `NAME=value` line each).

| Secret                    | Where the value comes from                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN`   | Your Access team domain (`<team>.cloudflareaccess.com`). [setup-cloudflare.md](docs/setup-cloudflare.md)         |
| `CF_ACCESS_AUD`           | The Access application's Audience (AUD) tag. [setup-cloudflare.md](docs/setup-cloudflare.md)                     |
| `CF_ACCESS_ALLOWED_EMAIL` | The one identity allowed through — checked in the Worker, not just Access.                                       |
| `PASSWORD_HASH`           | `npm run set-password` (prompts for a password, uploads the hash).                                               |
| `SESSION_SECRET`          | Any long random string, e.g. `openssl rand -base64 32`.                                                          |
| `DATA_KEY`                | `npm run gen-data-key -- --put` (mints and uploads the AES-GCM key).                                             |
| `GOOGLE_CLIENT_ID`        | The OAuth client from [setup-google.md](docs/setup-google.md).                                                   |
| `GOOGLE_CLIENT_SECRET`    | The OAuth client from [setup-google.md](docs/setup-google.md).                                                   |
| `EPIC_CLIENT_ID_PROD`     | Your app's production client id. [setup-epic.md](docs/setup-epic.md)                                             |
| `EPIC_CLIENT_ID_NONPROD`  | Your app's sandbox client id. [setup-epic.md](docs/setup-epic.md)                                                |
| `MODMED_CLIENT_ID`        | Optional. Your ModMed app's client id. [setup-modmed.md](docs/setup-modmed.md)                                   |
| `EPIC_ORG_SECRET_KEY`     | Optional. The key per-organisation client secrets are derived from. `npm run epic-org-secret -- --gen-key --put` |
| `TRELLO_KEY`              | Trello API key. [setup-trello.md](docs/setup-trello.md)                                                          |
| `TRELLO_TOKEN`            | Trello API token. [setup-trello.md](docs/setup-trello.md)                                                        |
| `TRELLO_MUST_LIST_ID`     | The Trello list new alert cards open in. [setup-trello.md](docs/setup-trello.md)                                 |
| `TRELLO_DONE_LIST_ID`     | The Trello list resolved alert cards move to. [setup-trello.md](docs/setup-trello.md)                            |

Per-organisation client secrets (Epic's and ModMed's alike) are **not** Worker secrets: they are
entered in the admin UI and stored encrypted in D1, one per health system,
rotated independently. When the admin UI is not an option (no live browser
session against that environment), `npm run set-health-system-secret -- --health-system
<id> --remote` sets the same column from the command line: it seals the value
exactly as the Worker does and writes it with `wrangler d1 execute`. The
secret is read from the `HEALTH_SYSTEM_CLIENT_SECRET` environment variable, or
from stdin if that is unset, so it is never a command-line argument or in
shell history, and the command never prints it back.

A health system that names its **Epic organisation id** needs no stored secret
at all: with `EPIC_ORG_SECRET_KEY` set, the Worker derives one from the key, the
environment and that id. `npm run epic-org-secret -- --org <id>` prints the same
value to register with Epic. A stored secret, where there is one, always wins.

A patient-portal login, where one is configured, is stored the same way and for
the same reasons: sealed in D1 per organisation, never a Worker secret, and
never readable back out of the admin UI. The portal is a scrape rather than an
API, so the row also holds the mount the login page was discovered at, a
sealed cookie jar — which carries the "trust this device" cookie, and is
therefore treated as being exactly as sensitive as the password — and,
optionally, an address to email a verification code to, for the rare
deployment whose own login flow will not say. `npm run
set-portal-credentials -- --health-system <id> --remote` is the no-browser
equivalent of the admin UI's portal card. The username comes from
`PORTAL_USERNAME` or the first line of stdin and the password from
`PORTAL_PASSWORD` or the rest of it, so neither is ever a command-line argument
or in shell history; add `--mfa-contact` (with `PORTAL_MFA_CONTACT` set) to
also set that email address:

```sh
{ echo "$portal_user"; echo "$portal_pass"; } |
  npm run set-portal-credentials -- --health-system <id> --remote
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
command `npm run build` and deploy command `npm run deploy` — see
[docs/setup-cloudflare.md](docs/setup-cloudflare.md).

Then, in the admin UI: add your health systems and connect each one
([docs/setup-epic.md](docs/setup-epic.md)), connect Google
([docs/setup-google.md](docs/setup-google.md)), and wire up Trello alerts
([docs/setup-trello.md](docs/setup-trello.md)).

### Phone (optional)

To bring in Health Connect data, install the companion app on an Android 17+
phone with Obtainium (`obtainium://add/https://github.com/pmaxhogan/healthy`),
then open the admin UI's **Phone** page, pair the phone by scanning the QR code
it shows (or pasting the **Pairing code** under it into the app), and grant the
Health Connect permissions. The path
`/ingest/health-connect` must bypass Cloudflare Access
([docs/setup-cloudflare.md](docs/setup-cloudflare.md)); everything else is in
**[docs/setup-android.md](docs/setup-android.md)**.

### Patient portal (optional)

Two portal vendors are supported: Epic's MyChart and ModMed's patient portal.
Which one a URL is, is worked out when it is saved, not chosen. A ModMed portal
signs in with a username and password alone. Its password goes to a separate
OpenID Connect provider, which the confirm step shows beside the portal's own
origin and which the save echoes back; every sign-in posts the password there
and nowhere else, and refuses if the practice now names a different one -- the
next save shows the new address to confirm; its session is a short-lived token pair kept in the sealed jar and
refreshed by the ten-minute keepalive. If one ever asks for a one-time code,
the sync stops and opens the reconnect card rather than retrying. Its secure
messages (inbox and sent) are read with the same token, read-only -- nothing is
ever marked read -- and a practice's `RE:` reply is joined to the message it
answers.

For a health system that also has a patient portal, the **Health systems** page
shows a **Patient portal** card under that health system: a portal login URL
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
hourly sync picks up that health system's upcoming portal visits the same way it
does FHIR encounters.

## Documentation

- **[docs/setup-epic.md](docs/setup-epic.md)** — registering the app on
  fhir.epic.com, and connecting a health system.
- **[docs/setup-google.md](docs/setup-google.md)** — the GCP project, OAuth
  consent screen, and calendar scopes.
- **[docs/setup-cloudflare.md](docs/setup-cloudflare.md)** — D1/KV/DO,
  custom domain, Access apps, Workers Builds.
- **[docs/setup-trello.md](docs/setup-trello.md)** — the board, key/token,
  and list ids the alert flow needs.
- **[docs/setup-android.md](docs/setup-android.md)** — the Android companion
  app: installing it with Obtainium, pairing, Health Connect permissions,
  backfill, building and releasing it.
- **[docs/mcp.md](docs/mcp.md)** — connecting a claude.ai connector, the
  consent flow, and the exposure policy's deny-list syntax.
- **[docs/operations.md](docs/operations.md)** — cron cadence, backoff,
  alerts, re-auth, ghost events, the phone and Health Connect (including
  uploads set aside and how to retry them), rotating secrets, wiping data.
- **[docs/development.md](docs/development.md)** — repo layout, `npm run
check`, tests (including the Android unit tests and the phone-to-Worker contract
  fixture), fixtures, and the dependency-update pipeline.
- **[SECURITY.md](SECURITY.md)** — the threat model.

## Development

```sh
npm run dev           # Vite dev server for the SPA
npm run dev:worker    # wrangler dev on :8787
npm run check         # lint, typecheck, knip, test, build -- what CI runs
npm run fix           # eslint --fix + prettier --write
```

Locally, `wrangler dev` presents every request as plain http on the routed
custom domain; with `DEV_MODE=true` in `worker/.dev.vars` the Worker puts it back on
`http://localhost:8787` before anything reads it (`worker/src/lib/dev-origin.ts`),
which is what lets the OAuth provider start at all. To run a second Worker on
another port, set `DEV_ORIGIN=http://localhost:<port>` in that checkout's
`worker/.dev.vars` and start Vite with `HEALTHY_DEV_WORKER` set to the same origin.

`npm run check` is the only gate that matters: it is what CI runs and what the
pre-push hook runs. Workers Builds only builds and deploys. See
[docs/development.md](docs/development.md) for the rest.

## Licence

MIT. See [LICENSE](LICENSE).
