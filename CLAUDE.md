# Healthy — notes for agents and contributors

A single-user Cloudflare Worker that syncs medical appointments to Google
Calendar and serves the same record read-only over MCP. Read `README.md` for the
architecture and `SECURITY.md` for the threat model.

## Privacy: the one rule that is never negotiable

This repository is public and the application handles health information.
**Never commit personal data.** Not in code, not in comments, not in tests, not
in a commit message, not in a fixture.

That means none of:

- health-system, hospital, clinic, or practitioner names
- FHIR base URLs, organisation ids, or patient portal URLs
- email addresses, patient identifiers, or anything read from a real record
- the Cloudflare Access team domain or application AUD
- locations, timezones, Trello board or list ids

Cloudflare **binding** ids in `wrangler.jsonc` — the D1 database id, the KV
namespace id, the account id — are allowed. They are not credentials.

Consequences for how code is written:

- No configuration value above has a default in source. If the code needs it, it
  reads it from a Worker secret or the D1 `settings` table.
- Test fixtures are synthetic (Epic's sandbox patients), never real.
- Cron comments do not translate schedules into local time — that would leak the
  timezone. Schedules are UTC and described as UTC.
- Logs carry an explicit field allowlist. Never a token, a bearer header, an
  email, clinical content, or a health system name.

## Develop and validate locally before pushing — always

**Every change is made working locally first. Nothing is pushed to find out
whether it works.** A push to `main` deploys to production through Workers
Builds, and a deploy-and-retry loop is slow, burns live resources, and for the
portal flows emails the owner a verification code and spends the portal's daily
sign-in attempts.

1. Run the stack locally: `npm run dev:worker` (the Worker on port 8787) and
   `npm run dev` (the admin UI, which proxies `/api`, `/auth` and `/oauth` to
   that Worker). Apply migrations with `npm run migrate:local`.
2. Exercise the change end to end there — the real flow, not only the unit
   tests — until it works completely.
3. For code that talks to a third party (Epic, a patient portal, Google,
   Trello), drive it from a local harness against the real service and save
   every page or response it receives under the gitignored `.local/` directory
   (for example `.local/portal-pages/01-login.html`, with status and final URL
   noted), so it can be inspected, diffed and turned into synthetic fixtures
   offline. Reuse persisted session state from `.local/` between runs instead
   of signing in again. Never copy those captures into tracked files.
4. Only then add synthetic-fixture tests, run `npm run check`, commit and push.

## Never cap what is fetched or stored

Paginate every upstream read to the end and cache every page, however unlikely
a large result looks (more than 100 appointments in a month, medications,
conditions, allergies — it does not matter). No `MAX_*` ceiling on what is
fetched, parsed or stored, and no silent truncation anywhere. An MCP tool
returns everything the caller asked for, even if that is megabytes of JSON; a
`limit` is only ever applied when the caller passes one, and the response says
so. Honest and noisy beats quietly incomplete.

## Naming: "health system", not "provider"

In a medical app "provider" naturally means a clinician (doctor, nurse, NP).
Do not use it for a connected organisation. Call that a **health system**
(`healthSystem`, `health_system_id`, …) in new code, docs and UI text; a
clinician is a **practitioner**. The codebase was migrated in migration 0009; the
only `provider`s left are the OAuth sense (`@cloudflare/workers-oauth-provider`),
FHIR's `serviceProvider`, the frozen `providers.*` AAD strings, and a patient
portal's own JSON field names for the clinician.

## Where secrets live

- **Worker secrets** (`wrangler secret put`): the full list is in the README's
  setup table. `npm run set-password` rotates `PASSWORD_HASH`;
  `npm run gen-data-key -- --put` mints `DATA_KEY`.
- **Local development**: `.dev.vars` — gitignored, never committed.
- **D1**: per-organisation FHIR client secrets, encrypted with `DATA_KEY` before
  they are written. One per health system, rotated independently, so they are not
  Worker secrets.
- **`.local/`**: gitignored scratch space for planning docs and anything that may
  mention personal specifics. Nothing personal from `.local/` may be copied into
  a tracked file.

## Before you finish

```sh
npm run check   # lint, typecheck, knip, test, build -- the whole gate
npm run fix     # eslint --fix + prettier --write
```

`npm run check` is what CI runs, what the pre-push hook runs, and what Cloudflare
Workers Builds runs before deploying. It is the only definition of "done".

Also worth knowing:

- The pre-commit hook runs eslint and Prettier on staged files, the unit suite,
  and `gitleaks git --pre-commit --staged`. gitleaks must be on PATH.
- Integration tests run in real workerd against real D1 and Durable Objects,
  driven from `wrangler.jsonc`, so schema and config changes are exercised.
- `worker-configuration.d.ts` is generated by `wrangler types` at the head of
  `npm run typecheck` and is gitignored. Do not hand-edit or commit it.
- No eslint rule is disabled without a comment saying why. Keep it that way.
- `worker/**` must not import `src/**`, and `src/**` must not import
  `worker/**`; shared code goes in `shared/`. eslint enforces this.
- `agents` and `@modelcontextprotocol/sdk` are pinned to exact versions on
  purpose — their APIs churn between releases. Check the pinned version's own
  types before writing against them, and do not let Dependabot bump them
  silently.
- The brands data pipeline (`scripts/slim-brands.mjs`, `scripts/lib/**`,
  `data/**`, `.github/workflows/brands.yml`) is owned separately and has a
  temporary lint carve-out at the bottom of `eslint.config.js`.

## Browser automation in this repository

For this project the owner's instruction is that browser automation uses the
`mcp__claude-in-chrome__*` tools, driving the owner's real Chrome so existing
logins (Cloudflare, Google, the Epic developer portal) work. This deliberately
overrides the owner's global "use /browse, never claude-in-chrome" rule, for
this repository only. Patient-portal logins are never automated; only the owner
types those.
