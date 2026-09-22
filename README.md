# Healthy

A single-tenant Cloudflare Worker that keeps one person's upcoming medical
appointments on their own Google Calendar, and exposes their aggregated health
record to an AI assistant over a read-only MCP server.

It talks to patient-facing FHIR APIs using SMART on FHIR, so it reads only what
the account owner has already authorised for their own record. It is deliberately
single-user: there is no multi-tenancy, no sign-up, and no shared database.

**Status: early.** The toolchain, schema, and Worker skeleton are in place; the
sync engine, MCP server, and admin UI are being built on top.

## What it does

1. **Appointment sync.** Polls each connected health system hourly for upcoming
   and recently-past encounters and projects them onto a Google Calendar. Events
   are created, patched when details change, and — when an appointment vanishes
   or is cancelled — marked as a greyed-out "Cancelled:" ghost rather than
   deleted, so the history survives.
2. **Read-only MCP.** Serves the aggregated record over MCP Streamable HTTP with
   OAuth, so an assistant can answer questions about medications, labs,
   conditions and appointments across health systems without being handed
   credentials.
3. **Re-auth alerts.** When a connection's refresh token stops working, opens a
   Trello card with a one-click reconnect link, and closes it automatically once
   the connection is restored.
4. **Admin UI.** A small Vue SPA for adding connections, choosing the target
   calendar, tuning how events are titled, and reviewing what the MCP has been
   asked.

## Architecture

```
worker/     Cloudflare Worker: Hono app, auth gates, sync engine, MCP server
src/        Vue 3 admin SPA, built by Vite into dist/ and served by the Worker
shared/     Types and constants both sides need (the only bridge between them)
migrations/ D1 schema
scripts/    Setup and maintenance CLIs
test/       vitest: unit (Node) + integration (real workerd, D1, DOs)
data/       Slimmed public index of FHIR endpoints, refreshed weekly by Actions
```

One Worker does everything. Requests arrive at the custom domain, pass through
Cloudflare Access and then a password gate, and are handled by a Hono app that
serves the API and the built SPA. Two cron triggers drive the hourly appointment
sync and a daily full refresh of the cache the MCP reads from. The MCP server
itself lives in a SQLite-backed Durable Object so each client session has durable
state.

- **Storage.** Cloudflare D1 for everything durable; Workers KV for MCP OAuth
  grants; a Durable Object for MCP sessions.
- **Encryption.** Tokens, per-organisation client secrets, patient identifiers
  and every cached clinical payload are encrypted in the application with
  AES-GCM-256 before they reach D1, with the additional authenticated data bound
  to the table, column and row.
- **Vendor abstraction.** Health systems sit behind a `ProviderAdapter`
  interface. Epic is the only implementation today.

## Deploying your own instance

This is built for one person's own record, but nothing stops you running it for
yours. You will need a Cloudflare account on the Workers Paid plan, a domain on
Cloudflare, a Google Cloud project, and a developer account with your health
system's FHIR vendor.

### 1. Cloudflare resources

```sh
npm install
wrangler d1 create healthy
wrangler kv namespace create healthy-oauth-kv
```

Put the resulting ids into `wrangler.jsonc` (`database_id`, the `OAUTH_KV` id,
and your `account_id`), and change `name` and the route `pattern` to yours. The
KV binding must stay named `OAUTH_KV` — the OAuth provider library requires it.

Then apply the schema:

```sh
npm run migrate:remote
```

### 2. Cloudflare Access

Put an Access application in front of the hostname so the admin UI is not
reachable by the public internet, with a policy that allows only your own
identity. Then add a **bypass** policy — or a second application with no
policy — for the paths the MCP and the public pages need, since an AI client
cannot complete an Access login:

```
/mcp*  /oauth/token  /oauth/register  /.well-known/*  /about  /privacy  /terms  /health
```

Everything else, including the consent page and the OAuth callbacks, stays
behind Access. The Worker independently verifies the Access JWT (issuer, `aud`,
and the email claim) rather than trusting the header, so a misconfigured bypass
cannot open the admin API.

### 3. Google OAuth

In a Google Cloud project with the Calendar API enabled, create an **OAuth
client (Web application)** and publish an **External** consent screen. It does
not need to pass verification for your own account to use it.

- Scopes: `.../auth/calendar.events.owned` and
  `.../auth/calendar.calendarlist.readonly`. Nothing broader — the sync only
  ever touches events it created itself.
- Authorised redirect URIs: `https://<your-host>/oauth/google/callback` and
  `http://localhost:8787/oauth/google/callback`.

Test against a throwaway calendar before pointing it at your primary one.

### 4. FHIR app registration (Epic)

Register a patient-facing app on Epic's developer portal
(<https://fhir.epic.com>) — their documentation is the authority here, and the
process changes; this is only the shape of it.

- Audience **Patients**, a **confidential** client, SMART v2, **R4 only**.
- Request the `.Read` and `.Search` scopes for the resource types you want
  synced and exposed. Enable auto-download / USCDI if offered.
- Redirect URIs: `https://<your-host>/oauth/callback` and
  `http://localhost:8787/oauth/callback`.
- Start in the sandbox. Going live means marking the app "Ready for Production"
  and then requesting a client secret from each health system individually —
  each organisation issues its own, and propagation can take a day or more.

### 5. Secrets

None of these live in the repository. Set them with `wrangler secret put <NAME>`,
or in a gitignored `.dev.vars` for local development.

| Secret                    | What it is                                                                   |
| ------------------------- | ---------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN`   | Your Access team domain, used to fetch the JWT signing keys.                 |
| `CF_ACCESS_AUD`           | The Access application's AUD tag; the `aud` claim tokens must carry.         |
| `CF_ACCESS_ALLOWED_EMAIL` | The single identity allowed through. Checked in the Worker, not just Access. |
| `PASSWORD_HASH`           | Second factor for the admin UI. Set it with `npm run set-password`.          |
| `SESSION_SECRET`          | HMAC key for the session cookie. Any long random string.                     |
| `DATA_KEY`                | base64 of 32 random bytes; the AES-GCM key. `npm run gen-data-key -- --put`. |
| `GOOGLE_CLIENT_ID`        | From step 3.                                                                 |
| `GOOGLE_CLIENT_SECRET`    | From step 3.                                                                 |
| `EPIC_CLIENT_ID_PROD`     | Your app's production client id.                                             |
| `EPIC_CLIENT_ID_NONPROD`  | Your app's sandbox client id.                                                |
| `TRELLO_KEY`              | Trello API key, for re-auth alerts.                                          |
| `TRELLO_TOKEN`            | Trello API token.                                                            |
| `TRELLO_MUST_LIST_ID`     | List that new alert cards open in.                                           |
| `TRELLO_DONE_LIST_ID`     | List that resolved alert cards move to.                                      |

Per-organisation FHIR client secrets are **not** Worker secrets: they are entered
in the admin UI and stored encrypted in D1, because there is one per health
system and they are rotated independently.

### 6. Deploy

```sh
npm run deploy     # applies migrations, then wrangler deploy
```

Or connect the repository to Cloudflare Workers Builds with build command
`npm run check` and deploy command `npm run migrate:remote && npx wrangler deploy`.

Finally, add your health systems in the admin UI and authorise each one, then
connect Google.

## Development

```sh
npm install           # also installs the git hooks
npm run dev           # Vite dev server for the SPA
npm run dev:worker    # wrangler dev on :8787 (the SPA proxies to it)
npm run migrate:local # apply migrations to the local D1
npm run check         # lint, typecheck, knip, test, build -- what CI runs
npm run fix           # eslint --fix + prettier --write
```

Requires Node 26 (see `.node-version`). `npm run check` is the only gate that
matters: it is what CI runs, what the pre-push hook runs, and what Workers Builds
runs before deploying.

## Licence

MIT. See [LICENSE](LICENSE).
