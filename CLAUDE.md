# Healthy — notes for agents and contributors

A single-user Cloudflare Worker that syncs medical appointments to Google
Calendar and serves the same record read-only over MCP, plus an Android companion
app that uploads the owner's Health Connect data to it. Read `README.md` for the
architecture and `SECURITY.md` for the threat model.

## Monorepo

- `worker/` is the whole Cloudflare project (`src/` the Worker, `ui/` the Vue SPA,
  `shared/`, `migrations/`, `test/`, `scripts/`); the root `package.json` is an npm
  workspace whose scripts fan into it. Run npm commands from the root, or from
  `worker/` for a single vitest file.
- `android/` is a Gradle project (Kotlin, Compose; application id
  `dev.maxhogan.healthy.companion`). **Gradle is not part of `npm run check`**: it
  has its own CI job and its own release workflow. A change under `android/` still
  runs `npm run check`, which does not exercise it, so run `./gradlew
testDebugUnitTest lintDebug` from `android/` yourself before pushing (JDK 21 and
  Android SDK platform 37.2).
- Health Connect on the Worker side is `worker/src/ingest/**` (the one route above
  the owner gate, with its own device-token auth) and `worker/src/hc/**`. Read the
  header of `worker/src/ingest/route.ts` before touching either: it is a security
  boundary, and `worker/src/app.ts`'s registration order is what keeps it one.
- The phone and the Worker share one wire contract, as a file:
  `worker/test/fixtures/hc/phone-batches.json`. The Android unit test
  `PhoneBatchFixtureTest` writes it (and fails when the checked-in copy is stale;
  accept an intended change by running it with `HEALTHY_WRITE_FIXTURES=1`), and
  `worker/test/unit/hc/phone-contract.test.ts` runs every batch in it through the
  Worker's validator. A change to either side of the wire changes the file.
- Workers Builds is unaffected by the monorepo: root directory `/`, build
  `npm run build`, deploy `npm run deploy`. It only builds and deploys; it does
  not run the gate again (the pre-push hook and CI already have), so a push that
  skips the hook deploys unchecked. Do not skip it.

## Health Connect store: invariants

The phone is told a batch was accepted and moves its cursor past it, so the queued
body is the only copy of those records. These hold for `worker/src/hc/**`,
`worker/src/db/repos/hc-ingest-queue.ts` and the MCP tools over them:

- **Never delete a queued batch that was acknowledged.** One that cannot be applied
  is parked (`hc_ingest_queue.parked_at`), which keeps it, takes it out of the
  ordered queue and raises the `hc_parked` alert; the Phone page's Retry puts it
  back (along with any rollup or summary mark that was parked). Only an applied batch, or a device wipe, removes queue rows.
- **Sealed payload columns stay last** in every `hc_*` table (`payload_enc`,
  `body_enc`). SQLite spills a large value to overflow pages, so any column after
  it can only be read by walking it. New columns go before it.
- **A chunk may span several `hc_chunks` rows** (`part` 0, 1, ...). Any query over
  `hc_chunks` either goes through the store readers (`readChunks`, `read.ts`) or
  filters `part = 0`.
- **Every field a Health Connect tool emits is declared** in
  `worker/src/policy/hc-fields.ts` (`JOINED_FIELDS` or `OWN_FIELDS`) and in
  `worker/src/policy/tree.ts`; a unit test holds them to the tools' real output.
  A field nobody placed is a field an exposure rule cannot find.
- Applying a batch is replayable and bounded. The chunks of a page share one
  `db.batch` (a round trip to D1 costs far more than the statements in it), cut
  by statements and by sealed bytes, and the cursor moves only after the commit
  that holds its work; a commit D1 refuses falls back to one per chunk. A slice
  that dies is run again, and the runner counts an attempt before each slice
  (eight, then the head batch is parked as `apply_gave_up`). The queue row goes
  in the same transaction that records the batch applied.
  `worker/test/integration/hc/replay.test.ts` kills a run around every commit and
  compares the store with an uninterrupted one: a change to `apply.ts` keeps it
  green.
- **A record id comes back.** Health Connect gives a record rewritten under the
  same client record id the id it had, and the app's own ids for the platform's
  hourly totals (`agg:<Metric>:<hour>`) are deleted and upserted as an hour
  empties and fills. A tombstone in `hc_record_index` carries WHICH batch
  deleted the id, as its place in the order batches arrived (`deleted_seq`, the
  batch's `hc_ingest_queue.seq`, which a parked batch keeps when it is queued
  again), and only refuses an upsert from a batch that arrived no later: a
  lower number, or the same batch. `deleted_at` (that batch's `received_at`, in
  whole seconds) decides only for a tombstone written before the number was
  kept, where a tie in one second goes to the upsert. Never compare either with
  a record's `lastModified`.
- **A deletion makes the hours' platform totals stale, and the store says so.**
  Health Connect gives a deleted record's id and nothing else, so the phone
  cannot know which hours' `Agg.<Metric>` totals counted it. Applying a batch
  marks every hour the OLD copy of a record of a totalled type covered (deleted,
  moved, or replaced) in `hc_platform_stale`, in the same `db.batch` as the chunk
  write, stamped with the batch's `seq` -- except the hours whose total the
  batch carries itself, and never for `Agg.*` records. A total from a batch with
  a higher `seq` clears a mark (a scanned mark, with no `seq`, by arrival
  second). The ingest route's 200 tells the phone its marks; nothing else ever
  reaches it, and no route may be added for it. The list of totalled types is
  `PLATFORM_PAIRS` (`worker/src/policy/hc-fields.ts`), which must match the
  app's `AggMetric` (a unit test reads both). See
  `worker/src/hc/store/platform-stale.ts`.
- **A stored rollup holds every record whole, where it starts.** Dividing a
  record among the buckets it spans is done when an answer is made
  (`worker/src/mcp/hc/aggregate.ts`), from the `crossing` list a rollup carries.
  A change to what a rollup holds raises `ROLLUP_REVISION`
  (`worker/src/hc/store/read.ts`): that re-rolls every stored day, and the hour
  rollups under them, by the path a change of zone takes, with nothing to run
  by hand.
- Statements are nearly free in production (about a millisecond); round trips
  are not (about 20 ms a read, 65 to 80 ms a commit). `hc.slice` logs
  `roundTrips`, `executed` and `sqlMs`: measure there before optimising, and do
  not trust a local timing, where a round trip is in-process.

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
- device serials, wireless-debugging addresses, or the package names of the apps
  on anyone's phone

Cloudflare **binding** ids in `worker/wrangler.jsonc` — the D1 database id, the KV
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

## Android: privacy rules

The app reads the owner's most personal data, so the Worker's privacy rule holds
for `android/` unchanged:

- No personal data in the app, its fixtures, its tests, or a commit. Test
  fixtures are synthetic; a record's origin is always a `com.example.*` package
  (for instance `com.example.wearable` or `com.example.phone`), never a real
  app's.
- **No analytics, crash reporting, advertising id or any third-party SDK that
  contacts a server.** The only host the app talks to is the Worker it was paired
  with. Do not add a dependency that phones home.
- A release build refuses cleartext traffic outright and takes only an `https`
  pairing address; only a debug build (application id suffix `.debug`) may reach
  the phone's own loopback over `http`, for the `adb reverse` development loop.
- The device token is never logged, displayed or put in a log string; it is stored
  only encrypted under the Android Keystore. Logs carry counts and stable error
  codes.
- The keystore and its passwords live in `.local/` or a password manager and in
  repository secrets, never in the tree. Captured payloads go under `.local/`.

## Never cap what is fetched or stored

Paginate every upstream read to the end and cache every page, however unlikely
a large result looks (more than 100 appointments in a month, medications,
conditions, allergies — it does not matter). No `MAX_*` ceiling on what is
fetched, parsed or stored, and no silent truncation anywhere. An MCP tool
returns everything the caller asked for, even if that is megabytes of JSON; a
`limit` is only ever applied when the caller passes one, and the response says
so. Honest and noisy beats quietly incomplete.

There is exactly one documented exception: the Health Connect MCP tools (heart-rate
series, records, aggregates and the rest) can match far more than an assistant
can read, so they apply a **soft byte budget**, `max_bytes`, default 25 KB. It cuts
at a row boundary, always sets `truncated: true` and returns a cursor to continue
from, and the caller can lift it by passing a larger `max_bytes`. It never
applies to what is fetched from the phone or stored: the upload, the store and
the rollups are uncapped in total. The upload route does bound a single request
(8 MiB compressed, 16 MiB decompressed, 25,000 records, a rate limit and queue
backpressure), but it refuses an oversize batch whole with 413 so the phone splits
it, and never truncates one. `data_quality` additionally stops at a window
boundary: it assesses a range half a year at a time and reads at most two
windows a call, because one request cannot read years of rollups, and when it
stops short it always says `truncated: true` with a cursor (nothing is dropped,
and `total` is then the findings so far). Do not copy this pattern to another
tool without recording it here.

## Naming: "health system", not "provider"

In a medical app "provider" naturally means a clinician (doctor, nurse, NP).
Do not use it for a connected organisation. Call that a **health system**
(`healthSystem`, `health_system_id`, …) in new code, docs and UI text; a
clinician is a **practitioner**. The codebase was migrated in migration 0010; the
only `provider`s left are the OAuth sense (`@cloudflare/workers-oauth-provider`),
FHIR's `serviceProvider`, the frozen `providers.*` AAD strings, and a patient
portal's own JSON field names for the clinician.

## Where secrets live

- **Worker secrets** (`wrangler secret put`): the full list is in the README's
  setup table. `npm run set-password` rotates `PASSWORD_HASH`;
  `npm run gen-data-key -- --put` mints `DATA_KEY`.
- **Local development**: `worker/.dev.vars` — gitignored, never committed.
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

`npm run check` is what CI runs and what the pre-push hook runs. It is the only
definition of "done".

Also worth knowing:

- The pre-commit hook runs eslint and Prettier on staged files, the unit suite,
  and `gitleaks git --pre-commit --staged`. gitleaks must be on PATH.
- Integration tests run in real workerd against real D1 and Durable Objects,
  driven from `worker/wrangler.jsonc`, so schema and config changes are exercised.
- `worker/worker-configuration.d.ts` is generated by `wrangler types` at the head of
  `npm run typecheck` and is gitignored. Do not hand-edit or commit it.
- No eslint rule is disabled without a comment saying why. Keep it that way.
- `worker/src/**` must not import `worker/ui/**`, and `worker/ui/**` must not
  import `worker/src/**`; shared code goes in `worker/shared/`. eslint enforces this.
- `agents` and `@modelcontextprotocol/sdk` are pinned to exact versions on
  purpose — their APIs churn between releases. Check the pinned version's own
  types before writing against them. `.github/dependabot.yml` tells Dependabot to
  ignore their minor and patch bumps, and never to propose `jq-wasm` at all; keep
  it that way.
- `jq-wasm` is pinned exactly too: `worker/src/mcp/jq/vendor/` (the fuel-metered
  jq wasm plus its glue) is generated from it by `node worker/scripts/build-jq-wasm.mjs`
  and checked in. After bumping it, re-run that script; a unit test fails until
  you do.
- The brands data pipeline (`worker/scripts/slim-brands.mjs`, `worker/scripts/lib/**`,
  `worker/data/**`, `.github/workflows/brands.yml`) is owned separately and has a
  temporary lint carve-out at the bottom of `worker/eslint.config.js`.

## Browser automation in this repository

For this project the owner's instruction is that browser automation uses the
`mcp__claude-in-chrome__*` tools, driving the owner's real Chrome so existing
logins (Cloudflare, Google, the Epic developer portal) work. This deliberately
overrides the owner's global "use /browse, never claude-in-chrome" rule, for
this repository only. Patient-portal logins are never automated; only the owner
types those.
