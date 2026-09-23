# Development

## Repo layout

```
worker/                 The Cloudflare Worker (Hono app + MCP server + sync engine)
  auth/                 Access JWT verification, password, session, CSRF, rate limiting
  api/                  Admin JSON API (/api/*)
  oauth/                Epic and Google OAuth flows, plus the reconnect redirect
  ehr/                       The EhrAdapter interface; ehr/epic is the only implementation
  fhir/                 FHIR types, the search registry, and per-resource normalizers
  google/               Google OAuth and Calendar API clients
  sync/                 The calendar-sync diff engine, full refresh, mapping, backoff
  mcp/                  The HealthyMcp Durable Object, tools, the consent page, audit
  policy/               The exposure deny-list: rules.ts (parsing) and filter.ts (the choke point)
  db/                   D1 client, per-table repos, and the seal()/open() crypto helpers
  lib/                  Structured logging, retry-with-backoff, time, ids, the error taxonomy
src/                    The Vue 3 admin SPA, built by Vite into dist/ and served by the Worker
shared/                 Types both sides import — the only bridge between worker/ and src/
migrations/             D1 schema, applied in order by wrangler d1 migrations
data/epic-brands.json   A slimmed, committed, public index of Epic FHIR endpoints
scripts/                Setup and maintenance CLIs (set-password, gen-data-key, set-health_system-secret, slim-brands)
test/unit/**            vitest, plain Node — pure logic, no Worker runtime
test/integration/**     vitest, real workerd + D1 + Durable Objects
test/spa/**             vitest, happy-dom — Vue component and helper tests
test/fixtures/epic/**   Synthetic FHIR responses used by the unit and integration suites
.github/workflows/      ci.yml, dependabot-automerge.yml, brands.yml
```

`eslint` enforces that `worker/**` never imports from `src/**` and vice
versa — anything both sides need belongs in `shared/`.

## `npm run check`

This is the whole gate. It is what CI runs on every push and pull request,
what the pre-push hook runs, and what Cloudflare Workers Builds runs before
deploying — the same command everywhere means a green `npm run check`
locally is a green build everywhere else. It runs, in order:

1. **`lint`** — `eslint .` (typescript-eslint strict + stylistic, plus
   unicorn, import-x, sonarjs, security, promise, and vue/vitest plugins),
   then `prettier --check .`.
2. **`typecheck`** — regenerates `worker-configuration.d.ts` via `wrangler
types` first (it is gitignored and always derived, never hand-edited),
   then `tsc` against the worker, test, and node project configs, plus
   `vue-tsc` for the SPA.
3. **`knip`** — flags unused files, exports, and dependencies.
4. **`test`** — the full vitest run (see below).
5. **`build`** — `vite build`, producing the `dist/` the Worker serves as
   assets.

`npm run fix` runs the mechanical half of this (`eslint --fix` and
`prettier --write`) for you.

## Git hooks (lefthook)

Installed automatically by `npm ci`'s `prepare` script
(`lefthook install && wrangler types`). Split by cost:

- **pre-commit** (parallel, staged files only): `eslint`, `prettier
--check`, `gitleaks git --pre-commit --staged --redact --no-banner`, and
  the unit test suite.
- **pre-push**: the full `npm run check` — the same thing CI runs, so a
  push that passes locally is a push CI will agree with.

## Installing gitleaks

The pre-commit hook needs `gitleaks` on your `PATH`:

- Windows: `winget install Gitleaks.Gitleaks`
- macOS: `brew install gitleaks`
- otherwise: a release binary from the
  [gitleaks GitHub releases](https://github.com/gitleaks/gitleaks/releases)

CI additionally runs `gitleaks/gitleaks-action` over the repository's
**full history** on every push and pull request, independent of what
pre-commit already caught on the tip.

## Test projects

Three separate vitest projects, configured in `vitest.config.ts`:

- **`unit`** (`npm run test:unit`) — plain Node, `test/unit/**`. Pure logic
  with no Worker runtime: mapping, the diff engine, fingerprints, the
  policy filter, crypto round-trips, retry/backoff, token state machines,
  Trello dedupe logic, log redaction, CSRF/session helpers, the brands
  slimmer.
- **`integration`** (`npm run test:integration`) — real `workerd`, real D1,
  real Durable Objects via `@cloudflare/vitest-pool-workers`, driven from
  the actual `wrangler.jsonc`, so schema and binding changes are exercised
  the same way production would see them: migrations applying cleanly, the
  auth gates in `DEV_MODE`, OAuth flows against mocked token endpoints,
  calendar sync end-to-end against fixture FHIR data and an in-memory
  Google mock (ghosting included), and MCP tool calls through the real
  Durable Object with policy denials and audit rows.
- **`spa`** (`npm run test:spa`) — happy-dom, `test/spa/**`. Vue component
  and helper tests against a DOM but no Worker runtime: the fake `fetch`
  in `test/spa/helpers.ts` answers 404 for any path a test did not
  declare, so an unexpected request fails loudly. `npm run test` runs all
  three projects together.

## Fixtures policy

`test/fixtures/epic/**` holds small JSON files — Encounter bundle pages, a
`metadata` capability statement, `smart-configuration`, a token response,
and a few `OperationOutcome` warning bodies. Some are hand-written to
isolate one behaviour; others come from `scripts/record-fixtures.ts`, which
drives a real sandbox OAuth flow against one of Epic's published synthetic
test patients (e.g. `fhircamila`), runs every registered search against the
real `EhrAdapter`/`FhirClient` code, and writes the scrubbed responses
out as fixtures (`scripts/lib/scrub-fixture.ts` does the scrubbing) —
recording is itself a smoke test of that code against a live server.
**Never point it at a production app registration, and never a real patient
record in any form**, per the privacy rule in [CLAUDE.md](../CLAUDE.md).
Keep additions small: these files are committed, and the point of a
fixture is to isolate one behaviour, not to capture a whole realistic
response.

## Dependabot and auto-merge

`.github/dependabot.yml` runs weekly (Mondays), grouping every semver-minor
and semver-patch npm update into a single PR per ecosystem (npm and GitHub
Actions separately). `dependabot-automerge.yml` approves and enables
`gh pr merge --auto --squash` on that grouped PR once CI is green.
Semver-major updates are excluded from grouping and open individually for
manual review — in particular, `agents` and `@modelcontextprotocol/sdk` are
pinned to exact versions on purpose, since their APIs churn between
releases, and a silent major bump there would break the MCP server without
a compile error to catch it.

Auto-merge like this needs either a public repository or a paid GitHub
plan **(verify current GitHub pricing/feature gating for private-repo
auto-merge and required branch protection)** — this repository starts
private and is intended to flip public once the security review in
[SECURITY.md](../SECURITY.md) passes.

## The brands data job

`.github/workflows/brands.yml` runs `scripts/slim-brands.mjs` weekly
(Mondays 09:17 UTC), which downloads Epic's public "User-access Brands"
bundle from open.epic.com (tens of megabytes) and slims it down to
`data/epic-brands.json` — just each brand's name, portal URL, and R4 FHIR
base URL. It commits the result back to `main` only when the content
actually changed, so an unchanged week produces no commit. This file is
public, non-personal data (Epic's own published directory) and is
committed rather than gitignored; only its _formatting_ is excluded from
Prettier, since it is machine-written and re-formatting it on every run
would produce a spurious diff. The pipeline (`scripts/slim-brands.mjs`,
`scripts/lib/**`, `data/**`, `.github/workflows/brands.yml`) is called out
separately in [CLAUDE.md](../CLAUDE.md) and carries its own lint carve-out
in `eslint.config.js`.
