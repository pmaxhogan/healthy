# Development

## Repo layout

```
worker/                 The Cloudflare project (own package.json; the root is an npm workspace)
  src/                  The Worker: Hono app + MCP server + sync engine
    auth/               Access JWT verification, password, session, CSRF, rate limiting
    api/                Admin JSON API (/api/*)
    oauth/              Epic and Google OAuth flows, plus the reconnect redirect
    ehr/                The EhrAdapter interface and its implementations (Epic, ModMed)
    fhir/               FHIR types, the search registry, and per-resource normalizers
    google/             Google OAuth and Calendar API clients
    sync/               The calendar-sync diff engine, full refresh, mapping, backoff
    mcp/                The HealthyMcp Durable Object, tools, the consent page, audit
    policy/             The exposure deny-list: rules.ts (parsing) and filter.ts (the choke point)
    db/                 D1 client, per-table repos, and the seal()/open() crypto helpers
    lib/                Structured logging, retry-with-backoff, time, ids, the error taxonomy
    ingest/             POST /ingest/health-connect: the phone's upload route and its bounded body reader
    hc/                 Health Connect: wire format, device tokens, the sealed store (store/), rollups
                        (rollup/), dedupe and artefact rules, coverage, and the HcIngestRunner Durable Object
  ui/                   The Vue 3 admin SPA, built by Vite into worker/dist/ and served by the Worker
  shared/               Types both sides import — the only bridge between src/ and ui/
  migrations/           D1 schema, applied in order by wrangler d1 migrations
  data/epic-brands.json A slimmed, committed, public index of Epic FHIR endpoints
  scripts/              Setup and maintenance CLIs (set-password, gen-data-key, set-health-system-secret, slim-brands)
  test/unit/**          vitest, plain Node — pure logic, no Worker runtime
  test/integration/**   vitest, real workerd + D1 + Durable Objects
  test/spa/**           vitest, happy-dom — Vue component and helper tests
  test/fixtures/epic/** Synthetic FHIR responses used by the unit and integration suites
  test/fixtures/hc/**   phone-batches.json: the wire contract with the Android app (see below)
  wrangler.jsonc        Worker config; the vite, vitest, tsconfig, knip and eslint configs sit beside it
android/                The companion app: a Gradle project (Kotlin, Compose), module app/
  app/src/main/         The app: hc/ (Health Connect access and the record mappers), sync/ (engine,
                        pairing, state, backfill service), pair/ (QR scan), tasker/ (the Tasker plugin), ui/
                        (the status screen)
  app/src/test/         JVM unit tests: mappers, batching, retry, backfill cursor, pairing
  VERSION               major.minor; the patch is the repository's commit count
  obtainium.json        What Obtainium needs to find the release APK
docs/                   Operator and developer documentation
.github/workflows/      ci.yml (Worker gate, gitleaks, Android job), release.yml (Android APK),
                        dependabot-automerge.yml, brands.yml
```

The repository root holds only the npm workspace manifest (`package.json` and the
single `package-lock.json`), the lefthook and Prettier config, and the docs; every
script there fans into `worker/`.

`eslint` enforces that `worker/src/**` never imports from `worker/ui/**` and vice
versa — anything both sides need belongs in `worker/shared/`.

`android/` is a separate toolchain: JDK 21 and the Android SDK (platform 37.2), the
committed Gradle wrapper, and nothing from npm. **`npm run check` does not run
Gradle**, and Workers Builds never will; the Android build has its own job in
`.github/workflows/ci.yml` and its own release workflow. See
[setup-android.md](setup-android.md#building-from-source).

## `npm run check`

This is the whole gate. It is what CI runs on every push and pull request and
what the pre-push hook runs, so a green `npm run check` locally is a green
build everywhere else. Cloudflare Workers Builds does not run it again: by the
time a commit reaches `main` it has passed here (a direct push through the
hook, a pull request through its required checks), so the deploy only builds.
It runs, in order:

1. **`lint`** — `eslint .` (typescript-eslint strict + stylistic, plus
   unicorn, import-x, sonarjs, security, promise, and vue/vitest plugins),
   then `prettier --check .`.
2. **`typecheck`** — regenerates `worker/worker-configuration.d.ts` via `wrangler
types` first (it is gitignored and always derived, never hand-edited),
   then `tsc` against the worker, test, and node project configs, plus
   `vue-tsc` for the SPA.
3. **`knip`** — flags unused files, exports, and dependencies.
4. **`test`** — the full vitest run (see below).
5. **`build`** — `vite build` plus a second `vite build` for the sandboxed tool
   page, producing the `dist/` the Worker serves as assets.

`npm run fix` runs the mechanical half of this (`eslint --fix` and
`prettier --write`) for you.

## Git hooks (lefthook)

Installed automatically by `npm ci`'s `prepare` script
(`lefthook install && wrangler types`). Split by cost:

- **pre-commit** (parallel, staged files only): `eslint`, `prettier
--check`, `gitleaks git --pre-commit --staged --redact --no-banner`, and
  the unit test suite. None of it runs Gradle.
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

Three separate vitest projects, configured in `worker/vitest.config.ts`:

- **`unit`** (`npm run test:unit`) — plain Node, `worker/test/unit/**`. Pure logic
  with no Worker runtime: mapping, the diff engine, fingerprints, the
  policy filter, crypto round-trips, retry/backoff, token state machines,
  Trello dedupe logic, log redaction, CSRF/session helpers, the brands
  slimmer.
- **`integration`** (`npm run test:integration`) — real `workerd`, real D1,
  real Durable Objects via `@cloudflare/vitest-plugin`, driven from
  the actual `worker/wrangler.jsonc`, so schema and binding changes are exercised
  the same way production would see them: migrations applying cleanly, the
  auth gates in `DEV_MODE`, OAuth flows against mocked token endpoints,
  calendar sync end-to-end against fixture FHIR data and an in-memory
  Google mock (ghosting included), and MCP tool calls through the real
  Durable Object with policy denials and audit rows.
- **`spa`** (`npm run test:spa`) — happy-dom, `worker/test/spa/**`. Vue component
  and helper tests against a DOM but no Worker runtime: the fake `fetch`
  in `worker/test/spa/helpers.ts` answers 404 for any path a test did not
  declare, so an unexpected request fails loudly. `npm run test` runs all
  three projects together.

The Health Connect code has tests in every project: `worker/test/unit/hc/**`
(wire parsing, token hashing, the rollup and dedupe rules, coverage and the
staleness boundary, all pure), `worker/test/unit/mcp/hc/**` (the tools and the
exposure policy over them, including that `hc-fields.ts` names every field a tool
emits) and, in workerd, `worker/test/integration/ingest/**` (the upload route:
authentication, size limits, backpressure, idempotency, a batch id reused with
other content) and `worker/test/integration/hc/**` (the runner, the apply
pipeline, parked batches and their alert, rebuilds and wiping, against real D1
and Durable Objects), plus the Phone page in `worker/test/spa/**`.

### The phone contract fixture

`worker/test/fixtures/hc/phone-batches.json` is the one file the Android app and
the Worker both test against. The Android unit test `PhoneBatchFixtureTest` builds a
few batches (changes, a backfill month, deletes only, a state report) with the
app's real serializer and batcher from fully synthetic records, one of every
mapped type, and compares them with the file; it fails when the checked-in copy
differs. `worker/test/unit/hc/phone-contract.test.ts` runs every batch in the file
through the Worker's validator (`worker/src/hc/wire.ts`). Neither side can change
the wire alone: a mapper that emits something `wire.ts` refuses, or a `wire.ts` that
tightens, fails a test instead of failing on a phone.

To accept an intended change, regenerate the file from `android/`, review the diff,
and commit it:

```sh
HEALTHY_WRITE_FIXTURES=1 ./gradlew testDebugUnitTest
```

The comparison is of the parsed JSON, so a formatter may re-indent the file.

### Android tests

JVM unit tests only, in `android/app/src/test/`: one synthetic record per Health
Connect type through the mappers (with an assertion that every record type the SDK
has is mapped, and that the manifest declares exactly the permissions the types
need), batch splitting, acknowledge-then-commit and retry, how each Worker answer
is handled (including a record too large to send being replaced by a stub), the backfill cursor, the
hourly aggregates, pairing, the Tasker plugin, the contract fixture above, and a
build contract (the version scheme; no cleartext traffic in a release build and
loopback only in a debug one; no backups). There are no instrumented tests. Run them
from `android/`:

```sh
./gradlew testDebugUnitTest   # the unit tests
./gradlew lintDebug           # Android lint
./gradlew assembleDebug       # a debug APK, app/build/outputs/apk/debug/
```

CI runs those three and keeps the debug APK as an artifact. The fixtures are
synthetic and use `com.example.*` package names for the apps that wrote a record,
never a real app's.

## The local phone loop

A change to the upload path is exercised end to end, with a real phone, against a
local Worker before anything is pushed (the "validate locally" rule in
[CLAUDE.md](../CLAUDE.md)):

1. `npm run migrate:local`, then `npm run dev:worker` and `npm run dev`.
2. `adb reverse tcp:8787 tcp:8787`, and install the debug build with
   `adb install -r` (its application id ends in `.debug`, so it sits beside a
   release install).
3. On the local **Phone** page, pair a phone (scan the QR code, or paste the
   **Pairing code** into the app); the code's address is
   `http://localhost:8787`, which only a debug build of the app accepts, and only for
   loopback (a release build takes `https` and nothing else).
4. Watch the page and `npx wrangler d1 execute healthy --local --command "..."`
   (from `worker/`) while the app syncs.
5. Save any payload you capture under the gitignored `.local/` and turn it into a
   synthetic fixture by hand. Never copy a capture into a tracked file.

The full walkthrough is in [setup-android.md](setup-android.md#local-end-to-end-test).

## Fixtures policy

`worker/test/fixtures/epic/**` holds small JSON files — Encounter bundle pages, a
`metadata` capability statement, `smart-configuration`, a token response,
and a few `OperationOutcome` warning bodies. Some are hand-written to
isolate one behaviour; others come from `worker/scripts/record-fixtures.ts`, which
drives a real sandbox OAuth flow against one of Epic's published synthetic
test patients (e.g. `fhircamila`), runs every registered search against the
real `EhrAdapter`/`FhirClient` code, and writes the scrubbed responses
out as fixtures (`worker/scripts/lib/scrub-fixture.ts` does the scrubbing) —
recording is itself a smoke test of that code against a live server.
**Never point it at a production app registration, and never a real patient
record in any form**, per the privacy rule in [CLAUDE.md](../CLAUDE.md).
Keep additions small: these files are committed, and the point of a
fixture is to isolate one behaviour, not to capture a whole realistic
response.

## Dependabot and auto-merge

`.github/dependabot.yml` runs weekly, on Mondays, for three ecosystems: the npm
workspace (one lockfile, at the repository root), GitHub Actions, and the Android
Gradle project in `/android`. Each groups every semver-minor and semver-patch
update into a single pull request; a major update opens a pull request of its own.
Some bumps are not proposed at all: minor and patch updates of `agents`,
`@modelcontextprotocol/sdk` (pinned exactly on purpose, because their APIs churn
and a silent bump would break the MCP server without a compile error to catch it),
and every update of `jq-wasm`, major included (it is a development dependency, so
the development-only rule below would otherwise merge a major, and its vendored
wasm has to be regenerated by hand after any bump), major updates of `vitest` (until the Workers vitest pool supports it)
and the 7.0.x releases of `typescript`.

`dependabot-automerge.yml` approves a Dependabot pull request and enables
auto-merge (squash) on it, so it merges itself, with no human approval, once the
checks GitHub requires of the branch pass, in exactly two cases:

1. nothing in it is a major bump (the highest bump among a group's updates is minor
   or patch), or
2. everything in it is a development dependency, whatever the bump.

A major bump of anything that ships (a runtime dependency of the Worker or of the
Android app) is left for a person. A grouped pull request is judged on all of its
updates, not on the first. The development-only rule covers build tooling as well
as test tooling, such as `wrangler` and `vite`: a major bump of either merges on
passing required checks, with no one reading it.

**"Once CI passes" means the branch's required checks, and only those.**
`gh pr merge --auto` waits for the base branch's required status checks and never
bypasses them; a job that is not on that list gates nothing. The CI workflow has
three jobs (`check`, `gitleaks` and `android`). For a Gradle bump to be gated by the
Android tests and lint, the `android` job has to be made a required check in the
repository's branch protection settings, which this repository does not define.
Until it is, a Gradle pull request can merge on the strength of `check` alone,
which does not run Gradle.

In `release.yml` the workflow is read-only and the release job alone has
`contents: write`; every workflow checks out with `actions/checkout@v5`.

A merge made with the workflow's token does not start push-triggered workflows, so
`release.yml` also runs daily and releases any `main` commit not yet tagged.

## The brands data job

`.github/workflows/brands.yml` runs `worker/scripts/slim-brands.mjs` weekly
(Mondays 09:17 UTC), which downloads Epic's public "User-access Brands"
bundle from open.epic.com (tens of megabytes) and slims it down to
`worker/data/epic-brands.json` — just each brand's name, portal URL, and R4 FHIR
base URL. It commits the result back to `main` only when the content
actually changed, so an unchanged week produces no commit. This file is
public, non-personal data (Epic's own published directory) and is
committed rather than gitignored; only its _formatting_ is excluded from
Prettier, since it is machine-written and re-formatting it on every run
would produce a spurious diff. The pipeline (`worker/scripts/slim-brands.mjs`,
`worker/scripts/lib/**`, `worker/data/**`, `.github/workflows/brands.yml`) is called out
separately in [CLAUDE.md](../CLAUDE.md) and carries its own lint carve-out
in `worker/eslint.config.js`.
