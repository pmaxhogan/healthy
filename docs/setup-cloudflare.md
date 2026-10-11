# Setting up Cloudflare

Everything below is one-time setup for a deployment: the D1 database, the KV
namespace used by the MCP OAuth provider, the custom domain, the Access
application in front of it, and connecting the repository to Workers Builds.

## 1. D1, KV, and the Durable Object

```sh
npx wrangler d1 create healthy
npx wrangler kv namespace create healthy-oauth-kv
```

Put the resulting ids into `worker/wrangler.jsonc`:

- `d1_databases[0].database_id` — the D1 database id.
- `kv_namespaces[0].id` — the KV namespace id. The binding name must stay
  `OAUTH_KV`; `@cloudflare/workers-oauth-provider` requires that exact name
  and it is not configurable.
- `account_id` — your Cloudflare account id.

The Durable Object bindings — `HEALTHY_MCP` (`HealthyMcp`), `FULL_REFRESH`
(`FullRefreshRunner`), `PORTAL_SIGNIN` (`PortalSignInRunner`) and `HC_INGEST`
(`HcIngestRunner`) — and their `new_sqlite_classes` migrations are already
correct in `worker/wrangler.jsonc` and do not need editing. The class and binding
names are fixed by their migration tags and must not change. `HC_INGEST` (the
`v4` tag) is the one added for the Android companion app: one object per paired
phone, applying that phone's queued uploads from an alarm. It is created by the
deploy; there is nothing to provision.

Then apply the schema:

```sh
npm run migrate:local   # local Miniflare D1, for `npm run dev:worker`
npm run migrate:remote  # the real, deployed D1 (also run by `npm run deploy`)
```

## 2. Custom domain

Add your domain to Cloudflare if it is not already there, then set
`routes[0].pattern` in `worker/wrangler.jsonc` to your hostname (`custom_domain:
true` is already set). `workers_dev` stays `false` deliberately: a
`*.workers.dev` hostname would be a second, un-gated front door to the same
Worker.

## 3. Cloudflare Access

Put an **Access application** in front of your hostname, with a policy that
allows only your own identity (your Google account, or whichever identity
health system your Cloudflare Zero Trust team uses).

An AI MCP client cannot complete an interactive Access login, so a narrow,
exact set of paths has to bypass Access. Configure this as either a
path-scoped **Bypass** policy on the same Access application, or as a
second Access application over just these paths with no policy at all —
whichever your Zero Trust setup makes easier. **(verify the exact
path-matching syntax Cloudflare's current Access UI expects for a wildcard
like `/mcp*` or `/.well-known/*` — it has changed between Zero Trust UI
versions.)** The paths:

```
/mcp*
/oauth/token
/oauth/register
/.well-known/*
/about
/privacy
/terms
/health
/ingest/health-connect
```

`/ingest/health-connect` is the Android companion app's upload endpoint. It is
the one path on this list that is not for an AI client or the public: a paired
phone has no Access identity, so Access cannot gate it, and the Worker
authenticates it instead with a per-device bearer token (see
[SECURITY.md](../SECURITY.md#device-upload)). Add it as an **exact path**, with
no wildcard, so the bypass covers that one URL and nothing under or beside it.
Until it is on the list, a phone's upload is redirected to the Access login and
the app reports an error. A quick check once it is in place:

```sh
curl -i -X POST https://<your-host>/ingest/health-connect
```

must answer `401` with `{"error":"unauthorized"}`, not a redirect to Cloudflare
Access.

Two things about how that exact-path entry behaves, observed against a production
Access application (this is Access's behaviour, not the Worker's, so check it again
if Cloudflare changes it). Access matches the bypass path **case-insensitively**,
while the Worker's router is case-sensitive: a request for the same path in other
letter case (`/Ingest/Health-Connect`) passes Access, does not match the upload route,
falls through to the Worker's own owner gate, and is refused there for lack of an
Access identity. That fails closed, but do not be surprised that a differently-cased
path gets the gate's answer rather than Access's. The trailing-slash variant,
`/ingest/health-connect/`, is not matched by the exact entry and stays behind Access.

Everything else — including the MCP consent page at `/authorize`, both
OAuth callback paths, and the whole admin API — stays behind Access. The
Worker independently verifies the Access JWT itself (issuer, `aud`, and the
email claim, in `worker/src/auth/access.ts`) rather than trusting a header
Cloudflare attaches, so a bypass policy that is accidentally too wide does
not by itself grant access to anything sensitive — it only removes Access
as one of the two required gates, and the password session is still
required for every path in this list except the MCP surface, the four
public pages, and the phone's upload path (which has its device token).

Two secrets come from this application's settings:

- `CF_ACCESS_TEAM_DOMAIN` — your Zero Trust team domain, of the form
  `<team>.cloudflareaccess.com` (no scheme, no trailing slash).
- `CF_ACCESS_AUD` — the Access application's "Application Audience (AUD)
  Tag", shown on its overview page. This binds the check to _this_
  application specifically; without it, a valid Access session for any
  other application in your team would also pass.
- `CF_ACCESS_ALLOWED_EMAIL` — the one email address allowed through. This
  is enforced in the Worker, independently of the Access policy itself.

## 4. Workers Builds

Connect the GitHub repository to Cloudflare Workers Builds, with:

- **Build command:** `npm run check`
- **Deploy command:** `npm run deploy`

The repository is a monorepo, and that changes nothing here: leave the
Workers Builds **root directory** at `/` (the repository root), because the root
`package.json` is an npm workspace whose `check` and `deploy` scripts fan into
`worker/`. Build with `npm run check` and deploy with `npm run deploy`, as above.
The Android app in `android/` is not part of either: it has its own CI job and
release workflow in GitHub Actions, and a push that changes only `android/`
still runs `npm run check`, which does not touch Gradle.

`npm run deploy` runs, inside `worker/`, `npm run migrate:remote && wrangler deploy`, so
the remote D1 migration always runs immediately before the new code that
depends on it, in that order, on every build. **(verify whether Workers
Builds automatically picks up `.node-version` and runs `npm ci` rather than
`npm install` — check the build's Node-version and install-command settings
if a build behaves differently from local `npm run check`.)**

## 5. Secrets

Set everything in the README's secrets table with `wrangler secret put
<NAME>` (each prompts for a value on stdin), for example:

```sh
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put CF_ACCESS_ALLOWED_EMAIL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put EPIC_CLIENT_ID_PROD
npx wrangler secret put EPIC_CLIENT_ID_NONPROD
npm run epic-org-secret -- --gen-key --put   # optional: derived per-organisation secrets
npx wrangler secret put TRELLO_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put TRELLO_MUST_LIST_ID
npx wrangler secret put TRELLO_DONE_LIST_ID
```

Two secrets have their own scripts, because their values are derived rather
than pasted in from another service:

```sh
npm run set-password           # prompts for the admin password, uploads its hash as PASSWORD_HASH
npm run set-password -- --print-only   # same, but prints the hash instead of uploading it

npm run gen-data-key -- --put  # mints a random AES-GCM-256 key, uploads it as DATA_KEY
```

`SESSION_SECRET` is just any long random string —
`openssl rand -base64 32` or equivalent, piped into
`wrangler secret put SESSION_SECRET`.

For local development, put the same names into a gitignored `worker/.dev.vars`
file (`NAME=value` per line) instead of using Worker secrets, and set
`DEV_MODE=true` there — that relaxes only the Cloudflare Access check
(there is no Access in front of `wrangler dev`); the password session is
still required.
