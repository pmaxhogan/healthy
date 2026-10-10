# Health Connect companion app: locked spec (ultraquest handoff)

Written 2026-10-10 by an ultraquest interview session. This file is the whole
brief for the session that executes it. Read it once, then work. Every answer
under **Locked decisions** was given by the owner in the interview and must
**not** be re-asked. Gaps are the executing session's calls: pick the option
most consistent with the locked answers, prefer the reversible one, and record
it in the final report under "judgment calls made without asking".

This file is tracked in a public repository. It therefore contains no personal
data, per `CLAUDE.md`: no real record values, no timezone name, no device
addresses. The source audit that does contain them is referenced by path only.

## 1. The quest

Replace the foreground-only Claude-app Health Connect connector with a
background pipeline the owner never has to babysit:

1. An Android companion app ("Healthy Companion", `dev.maxhogan.healthy.companion`)
   reads every Health Connect record type it is granted, in the background,
   incrementally via the Changes API, with a full-history backfill, and pushes
   gzipped JSON batches to the Healthy Worker.
2. The Worker authenticates the phone with a device token, stores every record
   losslessly (sealed) in D1 as hour chunks plus sealed rollups, and shows a
   "Phone" page in the admin UI.
3. The MCP server gains the full tool set from the audit's section 8.2, so an
   assistant can answer from the cloud copy with the phone off.
4. The repository becomes a proper monorepo: `worker/` and `android/`.

**Source audit** (read it first; it is the problem statement and the acceptance
oracle): the owner's upload at
`C:\Users\pmaxh\.claude\uploads\6f62845e-12a7-5b40-9e72-82779a031ee3\ff10a33a-health-connect-connector-audit-2026-10-09.md`.
First action of the executing session: copy it to
`.local/health-connect-audit-2026-10-09.md` (gitignored) and read it from there.
Its sections 5 (data-quality issues), 8.1 (hard requirements), 8.2 (tools),
8.3 (storage sketch, superseded by section 4 below where they differ) and 8.4
(acceptance tests) are normative for this quest. Its numbers never enter a
tracked file.

**Done when:** every wave below has landed on `main`, production serves the
restructured Worker unchanged, the phone has completed a full backfill, all
eleven new tools answer through the real MCP server and the admin tool-call
route, the ten acceptance tests in audit section 8.4 pass against the owner's
production data (phone in airplane mode for the staleness test), the APK is
published as a GitHub release installable through Obtainium, and the report
is delivered.

## 2. Locked decisions (do NOT re-ask any of these)

### Scope

- **Everything in the audit spec** ships in this quest: app, ingest, storage,
  Phone page, and all tools in audit section 8.2 (`hc_coverage`,
  `hc_sync_status`, `hc_records`, `hc_aggregate`, `hr_series`, `hr_events`,
  `sleep_sessions`, `exercise_sessions`, `blood_pressure`, `daily_summary`,
  `data_quality`). The optional `sql_readonly` tool is **out**.
- **Every record type the SDK knows**, whatever is granted. Ungranted types are
  reported as "not permitted", never silently absent. No caps anywhere
  (`CLAUDE.md` rule).
- **Full-history backfill, every type**, with the HISTORY permission.
- **Monorepo in this repo**: `worker/` + `android/` at the root. Owner's words:
  "move the worker-specific stuff to a worker/ folder, migrate docs, etc as is
  relevant, make it a proper monorepo".

### Monorepo layout and sequencing

- `worker/` holds the whole Cloudflare project: its `package.json`,
  `wrangler.jsonc`, `migrations/`, `src/` (today's `worker/`), `ui/` (today's
  `src/`, the Vue SPA), `shared/`, `test/`, `scripts/`, `data/`, vite and
  vitest configs, tsconfigs, `knip.json`, `eslint.config.js` if it stays
  per-project. `android/` is the Gradle project. Root keeps `README.md`,
  `CLAUDE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `docs/`,
  `.github/`, `lefthook.yml`, Prettier config, `.gitignore`, `.node-version`.
- **Root `package.json` with npm workspaces** (`"workspaces": ["worker"]`).
  Root `npm run check` fans out to the worker's check; root `npm run deploy`
  fans out too (`npm run check -w worker`, or `--workspace`). `npm run check`
  does **not** run Gradle (accepted inferred decision). The Android build has
  its own CI job.
- **Wave 0 is a pure-move PR-equivalent**: a behaviour-free restructure that
  lands on `main` first, deploys, and is verified unchanged in production
  before any Health Connect code starts.
- **Dashboard steps** (Workers Builds root directory if needed; the new Access
  bypass path) are done by an **Opus subagent driving claude-in-chrome** in the
  owner's signed-in Chrome, followed by a PushNotification telling the owner
  what changed. Hard rule from `CLAUDE.md`: this repository uses
  `mcp__claude-in-chrome__*`, not gstack `/browse`.
  - Sharpening (compatible with the answer, state it as a rule): write the
    root `package.json` so that Workers Builds keeps working with its current
    root-directory setting (`npm run check` and `npm run deploy` at the repo
    root fan into `worker/`). Then the Workers Builds repoint is optional and
    the only required dashboard change is the Access bypass entry for
    `/ingest/health-connect`. If the executing session repoints anyway, do it after wave 0
    is green on `main`, never before.

### Worker architecture

- **Ingest auth: device token minted in the admin UI.** The Phone page mints a
  long random bearer token, shows it once (plus a QR code), and stores only its
  SHA-256 hash in D1. The phone sends `Authorization: Bearer <token>` to
  `POST /ingest/health-connect`. That path is added to the Access bypass list.
  Many devices allowed, one token each, revocable and rotatable from the UI
  (accepted inferred decision).
- **Storage: seal everything, pre-aggregate at several granularities.** Owner's
  words: "seal everything, pre-aggregate at various granularities to reduce
  query overhead. workers paid (which im on) allows ~800M rows read per day,
  ~1M rows written per day, 5GB storage." No clinical value is ever a clear
  column. Aggregates are also sealed.
- **Raw layout: hour chunks per (type, origin package, UTC hour).** One sealed
  row holding every record of that hour as JSON, plus a small index table
  mapping record id to chunk (ids are blinded with the repo's keyed HMAC, as
  `fhir_cache.resource_id` is) so deletions and upserts find their chunk. A
  change rewrites one chunk.
- **Rollups maintained at ingest, all sealed:** hourly in UTC per type and
  origin (n, sum, min, max, mean, first, last); daily in the configured
  default timezone (rebuilt when the `timezone` setting changes); per-minute
  heart-rate stats; nightly sleep and per-session exercise summaries
  (stage minutes, overnight HR/HRV joins, overlap merges, left-running flags).
- **Duplicates and artefacts: store everything, dedupe and flag at query
  time, report counts.** Rules live in one module. No ingest-time
  `duplicate_of` marking.
- **Protocol: gzipped JSON batches, ack-then-commit, idempotent by record
  id.** Batches capped by bytes (about 1 MB compressed). The Worker upserts
  and deletes by id and returns accepted counts; only then does the app
  persist its new changes token. Retries are safe; order inside a batch is
  irrelevant.
- **Source model: a new "device source" concept** surfaced in the same MCP
  envelope. New tables, not a fake `health_systems` row. Coverage and warnings
  for Health Connect types join the existing `coverage[]` with a
  `healthSystemId` of the form `device:<id>` so the policy deny-list can
  withhold tools, types and fields exactly as it does for FHIR.
- **Default timezone comes from the existing sealed `timezone` setting**
  (`worker/db/settings.ts:7`, which already has no default in source). The
  audit's "default America/Chicago" is replaced by that setting. Never a zone
  name in source, tests, fixtures or docs.

### Android app

- **UI: a status screen plus a per-type coverage table.** Pairing state,
  permission grants with a "grant all" button, last sync, backlog, last
  error, "sync now", "full backfill", Wi-Fi-only toggle, and a table of record
  types with granted/not, first and last timestamps and uploaded counts.
- **Pairing: scan a QR code shown in the admin UI** (token plus Worker URL).
- **Cadence: every 15 minutes, any network, battery-not-low**, plus:
  a sync-now button, pull-to-refresh on the status screen, and the app
  **functions as a Tasker plugin** with a single action "trigger refresh".
  Owner: "skip if too hard". Accepted inferred decision: attempt it last and
  drop it if it costs more than about an hour. Also exempt from battery
  optimisation and sync on app open.
- **Backfill: foreground service, newest month first, resumable.** Progress
  persisted per (type, month); changes tokens are taken **before** the
  backfill starts so nothing is missed.
- **Build: release build signed with a gitignored keystore, built in CI,
  distributed through Obtainium**, copying the owner's `pmaxhogan/tapshim`
  convention exactly (section 5 below). Owner: "can target very modern
  android (>=17), please do that if it reduces code or bundle size". So
  `minSdk` is the highest value that still compiles with the Health Connect
  client; `compileSdk 37`. Minify on, with keep rules for the reflection
  fallback serializer (accepted inferred decision).
- **Serializer: hand-mapped for every stable Record type plus a reflection
  fallback**, units normalised (mmHg, bpm, metres, kcal, kg, celsius), int
  enums rendered as names, with a unit test asserting every Record subclass
  has a mapper.
- **Identity:** application id `dev.maxhogan.healthy.companion`, name
  "Healthy Companion".
- **Failure UX:** phone notification after 3 consecutive failed syncs, and
  server-side staleness (coverage says `stale` when no upload has arrived for
  6 hours).

### MCP tools

- **Names as in the audit** (`hc_coverage`, `hc_sync_status`, `hc_records`,
  `hc_aggregate`, `hr_series`, `hr_events`, `sleep_sessions`,
  `exercise_sessions`, `blood_pressure`, `daily_summary`, `data_quality`).
- **Sources stay separate.** `get_vitals` remains FHIR-only. `daily_summary`
  is the join point; `get_health_summary` gains a short Health Connect
  section (last sync, latest BP, last night's sleep).
- **Formats:** default JSON items with units declared once per field; a
  **soft byte budget** (default 25 KB) that cuts at a row boundary with
  `truncated: true` and a cursor unless the caller raises `max_bytes`; the
  existing shared **`jq` argument replaces any columnar or CSV option**
  (owner's words: "default json items, soft budget, `jq` column").
  `hr_series` defaults to 1-minute resolution with `max_points=2000`.
  Document the byte budget as a caller-liftable exception to the "never cap"
  rule in `CLAUDE.md` when you touch it.
- **No `sql_readonly` tool.**

### Testing

- **Worker:** vitest unit tests for all logic (serializers, chunking, rollups,
  dedupe and flag rules, bucketing, byte budget, token hashing) **and**
  workerd integration tests that POST synthetic batches to
  `/ingest/health-connect` and call every new tool through the real Durable
  Object, including policy denials and audit rows. **Fixtures are synthetic,
  generated by an agent with no real data**, never derived from `.local/`
  captures by copying.
- **Android:** JVM unit tests for the JSON mappers (one synthetic record per
  type and the mapper-coverage assertion), batch splitting, ack-then-commit
  and retry logic, and the backfill cursor. No instrumented tests.
- **Local end-to-end before any deploy:** phone, `adb reverse tcp:8787
tcp:8787`, local `wrangler dev`; the app posts to `http://localhost:8787`.
  Real payloads are saved under `.local/hc-payloads/` (gitignored) to shape
  fixtures offline. Local D1 is inspected with `wrangler d1 execute --local`.

### Deploy and CI

- **Push straight to `main` per wave.** No PRs. Workers Builds gates on
  `npm run check` and deploys. Red CI after a push: fix forward, never revert
  (global standing answer).
- **Android release workflow: every push to `main`, like tapshim**, with the
  "is HEAD already tagged" check, daily cron and `workflow_dispatch`. Known
  consequence the owner accepted: a Worker-only push also cuts a new APK
  release. Do not add a path filter.
- **CI:** add an Android job to `.github/workflows/ci.yml` (unit tests, lint,
  `assembleDebug` artifact). Workers Builds is unaffected.

### Pre-grants (all four granted)

1. **Phone:** `adb install`, `uninstall`, launch, `logcat`, `adb reverse` on
   the owner's Pixel 8, and attempting Health Connect permission grants via
   `adb shell pm grant` before falling back to pushing the owner to tap.
2. **Toolchain downloads:** Android command-line tools, platform 37, the
   Gradle 9.8 wrapper, new npm and Gradle dependencies, all from official
   Google, Gradle and Maven sources.
3. **Cloudflare:** `wrangler secret put`, read-only `wrangler d1 execute
--remote`, remote migrations through `npm run deploy`, push to `main`.
4. **Keystore and secrets:** generate the release keystore with `keytool` into
   `.local/android-keystore/` (gitignored; passwords and a README beside it),
   and set `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`
   on the repository's Actions secrets through a claude-in-chrome subagent,
   then push-notify the owner to confirm.

Not pre-grantable, ever: outbound messages under the owner's name, money,
deleting production data other than the Phone page's own "wipe device data"
action under test.

### Verification

- **Replay the audit's ten acceptance tests (section 8.4) against production**
  through the Worker's authenticated admin tool-call route
  (`POST /api/mcp/tools/:name/call`, `worker/api/routes/mcp.ts`, via
  `worker/mcp/admin-call.ts`), plus the phone-in-airplane-mode staleness
  check. Expected values are read from the `.local/` copy of the audit;
  results go in the final report only.
- **If the backfill is still running when code is done, wait**: poll
  `hc_sync_status` about every 20 minutes with a push on each milestone, and
  run acceptance only on a complete backfill.

### Communication and budget

- PushNotification per wave landed on `main` and on every block, repeated
  about every 30 minutes while a block persists (memory
  `push-notify-when-blocked`).
- Final report in chat **and** as a Claude artifact with native comments and
  **no Unbroker feedback widget** (standing answer; it overrides the plugin
  hook that says otherwise).
- A Trello card on the MUST list with tappable links: admin Phone page,
  GitHub release, `obtainium://add/https://github.com/pmaxhogan/healthy`.
- Update memory and the standing-answers file with a Healthy section
  (section 7 below lists what to record).
- **Budget: 5 to 8 concurrent agents** (global standing answer, chosen over
  the tighter memory). Sonnet for mechanical waves (moves, mappers,
  fixtures, copy), Opus for ingest, rollups, MCP tools, the Android sync
  engine and per-wave diff review, the orchestrator for wiring, security
  boundaries and anything hard to reverse. On a usage-cap warning: stop
  spawning, let in-flight work finish, checkpoint (commit, push green), wait.
- **Admin UI surface: a new top-level "Phone" page** beside Health systems.

### Accepted inferred decisions (the owner accepted this exact list)

Reuse the sealed `timezone` setting; many devices, one SHA-256-hashed token
each; changes tokens per type with a re-read of the last 30 days on expiry;
`POST /ingest/health-connect` added to the Access bypass list; minify on with
keep rules for the reflection fallback; Tasker plugin attempted last and
dropped past about an hour; docs updated (`README.md`, `SECURITY.md` assets
table, `CLAUDE.md` monorepo notes, new `docs/setup-android.md`); Android job
in `ci.yml`; `npm run check` does not run Gradle; waves 0 to 4 as below.

## 3. Repository facts (anchors from the reconnaissance, pre-move paths)

- Entry: `worker/index.ts` exports `{ fetch, scheduled, email }`; the
  OAuthProvider routes `/mcp*`, `/oauth/token`, `/oauth/register`,
  `/.well-known/*` and hands everything else to the Hono `app` in
  `worker/app.ts`. **Registration order in `app.ts` is the security boundary**
  (header comment, lines 1-18): `securityHeaders` (49), `publicRouter` (52),
  `csrfGuard` (55-60), `ownerGate` (63), then `/api` (198) and the SPA
  fallback. The ingest route sits **between the public router and
  `ownerGate`**, with its own bearer check (constant-time compare of the
  SHA-256 of the presented token against the stored hash), a body size cap
  in the tens of megabytes, gzip decoding, and rate limiting by device id.
- Auth today: Access JWT (`worker/auth/access.ts`), password session
  (`worker/auth/session.ts`), CSRF header `x-healthy-csrf: 1`
  (`worker/auth/csrf.ts`), MCP OAuth (`worker/mcp/oauth-config.ts`). There is
  no machine-client bearer auth yet. The only inbound push is Email Routing
  (`worker/mail/handler.ts`, allowlist-then-classify).
- Crypto: `worker/db/crypto.ts` (`seal`, `open`, `sealShort`, `aadFor(table,
column, rowId)`), blinds in `worker/db/blind.ts`. Frozen AAD strings keep
  the old `providers.*` names; never rename them.
- Schema: migrations `0001` to `0015`; next is `0016`. `fhir_cache` is one
  sealed row per resource with a blinded id and a keyed `content_hash`.
  Settings: `worker/db/schemas.ts:103` (`SETTING_DEFAULTS`), sealed keys in
  `worker/db/settings.ts:54`; `timezone` has no default in source.
- Coverage: `worker/mcp/coverage.ts` (`STALE_AFTER_SECONDS` at 86, statuses
  `ok|partial|stale|failed|never|unsupported`, `INCOMPLETE_WARNING`), fed by
  `fhir_sync_state`. Extend it with device-source rows rather than forking it.
- MCP: `worker/mcp/server.ts` (`HealthyMcp extends McpAgent`, SQLite DO),
  `worker/mcp/tools/index.ts` registers tool groups, `worker/mcp/tool-names.ts`
  lists the 27 names, `worker/mcp/tools/register.ts` has `readTool` (50) and
  `collectionTool` (97), `worker/mcp/audit.ts` (`withAudit`),
  `worker/mcp/respond.ts` (`respond()` at 303: policy, reshape, jq, limit),
  `worker/mcp/args.ts` (`SHARED_ARGS`, `jqArg`, `windowArgs`). A new tool must
  also be added to `worker/mcp/jq-examples.ts`, `worker/policy/tree.ts`,
  `worker/api/tool-catalog.ts`, and the tests that pin the tool list
  (`test/unit/api/tool-catalog.test.ts`, `test/integration/mcp/wiring.test.ts`).
  Deps seam: `worker/mcp/deps.ts` (interface) and `worker/mcp/deps-d1.ts`;
  unit tests use `fakeDeps` in `test/unit/mcp/helpers.ts`.
- Durable Objects: `HealthyMcp`, `FullRefreshRunner` (`worker/sync/runner.ts`,
  alarm-driven chunks because `waitUntil` dies after about 30 s),
  `PortalSignInRunner`. Rollup rebuilds that outgrow a request belong in a
  new alarm-driven DO of the same shape.
- Admin UI: Vue 3, `src/router.ts` (`NAV`), `src/api/client.ts` (only
  `fetch`), `src/api/endpoints.ts`, `src/views/*View.vue`, settings flow in
  `worker/api/routes/settings.ts`, `worker/api/schemas.ts`, `worker/api/dto.ts`,
  `shared/types.ts`. SPA tests in `test/spa/**` with a fake `fetch` that 404s
  undeclared paths.
- Tests: `vitest.config.ts` has projects `unit`, `spa`, `integration`
  (workerd via `@cloudflare/vitest-pool-workers`, migrations read by
  `readD1Migrations`, dummy `TEST_SECRETS`). Integration tests call
  `app.fetch` with `testEnv`, not `SELF`. Copy `test/integration/mail/handler.test.ts`
  for the ingest route and `test/integration/mcp/tools.test.ts` for tools.
- Logging: `worker/lib/log.ts` is a redaction denylist plus a convention:
  counts, own-row ids, durations, statuses, stable error codes only. Use
  `errorCode`, never `code`. Mail logs `senderAllowed` as a boolean; log
  `deviceId` and counts for ingest, never a token or an origin package name
  in a message string.
- Secrets: adding one means `worker/env.ts`, `TEST_SECRETS` in
  `vitest.config.ts`, and the README setup table. This quest should need no
  new Worker secret: device tokens live hashed in D1.
- `run_log.kind` has a CHECK constraint (`calendar|full|refresh|manual`);
  ingest gets its own `hc_ingest_log` table rather than widening it.
- Docs to update: `README.md` (304 lines; architecture diagram and layout),
  `SECURITY.md` (assets table from line 161), `docs/development.md` (layout
  table, test projects), `docs/mcp.md` (new tools), `docs/operations.md`
  (staleness, wiping device data), `docs/setup-cloudflare.md` (bypass list,
  Workers Builds root), new `docs/setup-android.md`.

## 4. Workstreams

### Wave 0: monorepo restructure (pure move, no behaviour change)

Use `git mv` so history follows. Checklist of everything path-dependent:

- `wrangler.jsonc` moves to `worker/`: `main` becomes `src/index.ts`,
  `assets.directory` stays `./dist`, `migrations_dir` stays `migrations`
  (both relative to the config), DO class names unchanged.
- `package.json` moves to `worker/` with every script; root gets a new
  `package.json` (`private`, `workspaces: ["worker"]`, `engines.node >=26`,
  scripts `check`, `fix`, `deploy`, `dev`, `dev:worker`, `migrate:local`,
  `migrate:remote` fanning into `-w worker`). `package-lock.json` is
  regenerated at the root by `npm install` (workspaces hoist). The `prepare`
  script (`lefthook install && wrangler types`) must still run from the
  root `npm ci`: keep `lefthook install` at root, run `wrangler types` inside
  `worker/`.
- tsconfigs: `tsconfig.base.json` `paths["@shared/*"]`, and the `include`
  globs in `tsconfig.worker.json` (17), `tsconfig.app.json` (19),
  `tsconfig.test.json` (13-15), `tsconfig.node.json`. `worker-configuration.d.ts`
  is generated into `worker/` now; update `.gitignore` and `.prettierignore`.
- `vite.config.ts:27` and `vitest.config.ts:11,93,100,115,141` (`@shared`
  alias), `vite.sandbox.config.ts`, `index.html`, `tool-sandbox.html`.
- `eslint.config.js`: boundary globs at 115, 119, 208-234 become
  `worker/src/**` vs `worker/ui/**`; vendor ignores at 38-42; the brands
  carve-out at the bottom.
- `knip.json` entry/project globs; `.prettierignore` (`data/`, the jq vendor
  paths); `lefthook.yml` (`npm run test:unit` and `npm run check` must resolve
  from root; `npx eslint`/`prettier` on staged files need the configs
  discoverable, so either keep `eslint.config.js` and `.prettierrc` at root
  with adjusted globs or point lefthook at `worker/`).
- `.github/workflows/ci.yml` (`npm ci` + `npm run check` at root still
  works), `.github/workflows/brands.yml` (76-119: `data/epic-brands.json`,
  `scripts/slim-brands.mjs` paths), `.github/dependabot.yml` (`directory:
"/"` for npm becomes `"/worker"`, and add a `gradle` ecosystem entry for
  `/android` in wave 2).
- `scripts/*.ts` that import worker code (`set-password`, `gen-data-key`,
  `set-health-system-secret`, `epic-org-secret`, `set-portal-credentials`,
  `record-fixtures`, `build-jq-wasm.mjs`) and any `wrangler d1 execute`
  they shell out to.
- `worker/mcp/jq/vendor/` hash test (`manifest.json`) must still pass.
- `README.md`, `docs/development.md` layout table, `CLAUDE.md` paths
  (`worker/**` vs `src/**` rule, `.local/`, `scripts/slim-brands.mjs`),
  `SECURITY.md` path mentions, `CONTRIBUTING.md`.
- `.dev.vars` is gitignored and local. This worktree has no `.dev.vars` and
  no `.local/`; both exist only in the main checkout. Copy `.dev.vars` into
  `worker/` (read it from the main checkout; never edit anything there) before
  the first `wrangler dev`.

Gate: `npm run check` green at root; `npm run dev:worker` serves `/health`;
push to `main`; Workers Builds green; production `/health` returns `{"ok":true}`
and the admin UI loads with a clean console (memory `verify-ui-visually`);
one existing MCP tool call succeeds through the admin route.

### Wave 1: ingest, storage, Phone page (Worker)

- Migration `0016_health_connect.sql`: `devices` (id, name_enc, token_hash,
  created_at, revoked_at, last_seen_at, last_upload_at, app_version);
  `hc_chunks` (device_id, record_type, origin_pkg_hash, hour_utc, payload_enc,
  record_count, content_hash, updated_at; PK on the first four);
  `hc_record_index` (record_id_blind PK, device_id, record_type,
  origin_pkg_hash, hour_utc, deleted_at); `hc_rollup_hour`, `hc_rollup_day`,
  `hc_hr_minute`, `hc_sleep_night`, `hc_exercise_session` (all with
  `payload_enc`, clear only for keys and times); `hc_sync_state` (device_id,
  record_type, permission_state, first_ms, last_ms, record_count,
  last_upload_at, token_age_s, backlog); `hc_ingest_log`. Origin package
  names are stored blinded for grouping and sealed inside payloads for
  display, consistent with "seal everything".
- Route `POST /ingest/health-connect` above `ownerGate` (section 3). Body:
  `{ deviceId, appVersion, batchId, phoneTime, upserts: [...], deletes:
[ids], syncState: {...} }`, gzip. Response: `{ accepted, deleted,
rejected: [{id, errorCode}], serverTime }`. Idempotent by record id and
  `batchId`. Per-type upserts regroup into hour chunks (read-modify-write
  inside one D1 batch per chunk); rollups recomputed for touched hours and
  days; nightly and session summaries recomputed for touched nights and
  sessions.
- Admin API under `/api/phone`: list devices, mint token (returns the token
  once), revoke, wipe device data (two-step confirm), per-type coverage,
  sync status. Phone page in the SPA with the QR (a small pure-JS QR
  encoder; the dependency policy allows small pure-JS deps).
- Coverage integration: device rows join `coverage[]` as
  `healthSystemId: "device:<id>"`, with `permission_state` mapping to
  `unsupported` for "not permitted" plus a notice, and `stale` after 6 hours
  without an upload.
- Gate: unit and integration tests green, including a synthetic batch
  round-trip and the staleness transition; `npm run check`; push `main`;
  Workers Builds green; Access bypass entry added by the browser subagent
  and confirmed by a curl returning 401 (not an Access redirect) on the
  ingest path without a token.

### Wave 2: Android app and on-device end to end

- Location `android/`, Gradle project rooted there with an `app/` module,
  `VERSION` file (`0.1`), `obtainium.json`, version catalog. Copy tapshim's
  versioning block (patch = commit count, `versionCode = major*1_000_000 +
minor*10_000 + patch`), signing block reading `HEALTHY_KEYSTORE_PATH`,
  `HEALTHY_KEYSTORE_PASSWORD`, `HEALTHY_KEY_ALIAS`, `HEALTHY_KEY_PASSWORD`,
  `HEALTHY_PATCH`, and the release workflow shape (section 5). APK name
  `healthy-companion-<major>.<minor>.<patch>.apk`; Obtainium filter
  `healthy-companion-.*\.apk`. Note the monorepo: the workflow runs Gradle
  with `working-directory: android` and reads `android/VERSION`; the commit
  count is repo-wide, which is fine.
- Stack: Kotlin, Compose Material 3, `androidx.health.connect:connect-client:1.1.0`
  (stable 2025-10-08; 1.2.0-alpha adds `getChanges(token, pageSize)` and
  `ActivityIntensityRecord` but is alpha), WorkManager, kotlinx.serialization,
  OkHttp or `HttpURLConnection` with gzip, DataStore for state, CameraX or
  ML Kit for the QR scan. AGP 9.x needs Gradle 9.6+, JDK 17+ (this PC has
  JDK 21), build-tools 36, platform 37 (install via `sdkmanager`; this PC
  has platforms up to 36.1 and no `cmdline-tools` yet).
- Manifest: `<queries>` for `com.google.android.apps.healthdata`; one
  `android.permission.health.READ_*` per type; the rationale activity with
  `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE` and the Android 14+
  `activity-alias` (`android.intent.action.VIEW_PERMISSION_USAGE`, category
  `android.intent.category.HEALTH_PERMISSIONS`, permission
  `android.permission.START_VIEW_PERMISSION_USAGE`);
  `android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND` and
  `android.permission.health.READ_HEALTH_DATA_HISTORY`, gated at runtime by
  `HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND` and
  `FEATURE_READ_HEALTH_DATA_HISTORY`; `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_HEALTH`, `POST_NOTIFICATIONS`, `INTERNET`, camera.
- Sync engine: per-type changes tokens (`getChangesToken(ChangesTokenRequest(setOf(type)))`,
  `getChanges(token)` loop on `hasMore`, `UpsertionChange`/`DeletionChange`,
  `changesTokenExpired` => re-read last 30 days by `ReadRecordsRequest`
  paging and dedupe by id). Backfill: `ReadRecordsRequest` per type per month
  newest first, `pageToken` loop, cursor persisted. Quota errors surface as
  `IllegalStateException`; back off and resume. Rate limits are unpublished;
  prefer the changes API over raw reads after the backfill.
- Serializer: one mapper per Record subclass (42 in the client; `Planned
ExerciseSessionRecord` and `MindfulnessSessionRecord` need `@OptIn`), each
  emitting `{ id, type, origin: {packageName}, device: {type, manufacturer,
model}, recordingMethod, lastModifiedTime, clientRecordId,
clientRecordVersion, start/end or time, zone offsets as minutes, value
fields }` with nested `samples`, `stages`, `segments`, `laps`, `route`,
  `deltas` intact. Reflection fallback modelled on health-connect-gate's
  `ReflectiveJson` (MIT) for unknown classes; R8 keep rules for
  `androidx.health.connect.client.records.**`.
- Tasker plugin: the "trigger refresh" action as a plugin activity plus
  fire receiver (TaskerPluginLibrary or a hand-rolled `com.twofortyfouram`
  intent pair). Last task of the wave; drop past about an hour.
- On-device E2E: build, `adb install -r`, `adb reverse tcp:8787 tcp:8787`,
  local `wrangler dev` with migrations applied, pair with a token minted
  locally, try `adb shell pm grant` for the health permissions and, if that
  fails, PushNotification the owner to tap "Allow all" and keep the phone
  awake and charging for the backfill. Save payload captures under
  `.local/hc-payloads/`. Confirm the Phone page shows the device, coverage
  and first records; confirm a deletion propagates.
- Gate: Android unit tests green in CI; APK released by the workflow and
  installable via `obtainium://add/https://github.com/pmaxhogan/healthy`;
  the owner's phone paired against production (push the owner the QR step);
  backfill started.

### Wave 3: MCP tools

Implement all eleven tools per audit section 8.2 against the sealed store:

- `hc_coverage`, `hc_sync_status` from `hc_sync_state` and `devices`.
- `hc_records` (type, start, end, tz, origins, fields, order, limit, cursor,
  include_metadata) reading hour chunks, decrypting only the hours in range.
- `hc_aggregate` (metrics, bucket hour/day/week/month/year/N-minute,
  `origin_mode` hc_priority/origin/all_separately, `fill` zero/null,
  `bmr_fill=false`, `exclude_future=true`) composing from hourly UTC rollups
  and daily rollups; calendar buckets in a named IANA zone with correct DST
  boundaries; zero-filled buckets with `has_data`.
- `hr_series` (resolution raw/5s/1min/5min/1h, stats, max_points) from
  `hc_hr_minute` and raw chunks; `hr_events` (posture, wake, spikes) over the
  minute series.
- `sleep_sessions`, `exercise_sessions` from the nightly and session rollups
  with HR-checked wake, overlap merges and `likely_left_running`.
- `blood_pressure` with query-time dedupe, session grouping, duplicate count.
- `daily_summary`, `data_quality` per the audit.
- Every response says which origins it used and how many duplicates it
  dropped; "no data" and "not permitted" are distinct from `[]`; the byte
  budget sets `truncated` and a cursor. All go through `readTool`,
  `withAudit`, `respond()` and the policy filter; add them to the tool-name
  list, jq examples, policy tree, tool catalog and `docs/mcp.md`.
- Gate: unit tests for bucketing (DST, leap year, week starts), dedupe,
  flags, byte budget; integration tests calling every tool through the DO
  with a policy denial case each; `npm run check`; push `main`; Workers
  Builds green; each tool answers through the admin route in production.

### Wave 4: acceptance, docs, wrap-up

- Wait for the backfill to complete (poll `hc_sync_status`), then replay the
  ten acceptance tests from the `.local/` audit copy against production via
  the admin tool-call route; airplane-mode staleness check.
- Docs listed in section 3; `CLAUDE.md` gains the monorepo rules, the
  Android privacy notes (no personal data in fixtures or the app), and the
  byte-budget exception. `SECURITY.md` gains the device-token and sealed
  device-data assets.
- Trello card, memory updates, standing-answers section, artifact report,
  chat report, final PushNotification.

## 5. The tapshim convention to copy (verified 2026-10-10 from `pmaxhogan/tapshim`)

- Gradle project with `app/` module, `gradle/libs.versions.toml`, committed
  wrapper (tapshim: AGP 9.4.1, Kotlin 2.4.20, Gradle 9.8.0, Compose BOM
  2026.09.00, compileSdk 37 with `compileSdkMinor = 1`, JDK 21 Temurin in
  CI, Java 17 source/target).
- `VERSION` file holds `major.minor`; patch is `git rev-list --count HEAD`
  (`<APP>_PATCH` env in CI); `versionName = major.minor.patch`;
  `versionCode = major*1_000_000 + minor*10_000 + patch`.
- `signingConfigs.create("release")` reads `<APP>_KEYSTORE_PATH`,
  `<APP>_KEYSTORE_PASSWORD`, `<APP>_KEY_ALIAS`, `<APP>_KEY_PASSWORD`; the
  release build type attaches it only when the path var is set, so a local
  `assembleRelease` without secrets yields an unsigned APK.
- `release.yml`: `on: push: branches: [main]`, `schedule: "17 6 * * *"`,
  `workflow_dispatch`; `permissions: contents: write`; `concurrency: release`;
  job `check` skips when `git tag --points-at HEAD 'v*'` is non-empty; job
  `release`: checkout `fetch-depth: 0`, `setup-java` 21, `gradle/actions/setup-gradle@v4`,
  compute version, test gate, `echo "$KEYSTORE_BASE64" | base64 -d >
"$RUNNER_TEMP/release.jks"`, `assembleRelease`, copy to the versioned APK
  name, `apksigner verify --print-certs`, release notes from `git log
--no-merges` since the previous `v*` tag, `gh release create v<ver> <apk>
--title ... --notes-file notes.md --target "$GITHUB_SHA"`.
- Repository secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`,
  `KEY_PASSWORD`. Not documented upstream: generate with
  `keytool -genkeypair -v -keystore release.jks -alias healthy -keyalg RSA
-keysize 4096 -validity 10000`, keep it in `.local/android-keystore/`.
- `obtainium.json` at the Android project root with `id`, `url`, `author`,
  `name`, `preferredApkIndex: 0`, and an `additionalSettings` JSON string with
  `apkFilterRegEx`, `includePrereleases: false`,
  `fallbackToOlderReleases: true`, `versionDetection: true`; README gets the
  `obtainium://add/<repo url>` link.
- `ci.yml` (separate from release): `testDebugUnitTest`, `lintDebug`,
  `assembleDebug` artifact. Kover coverage gates are optional here.

## 6. Process rules for the executing session

- **Work only in a worktree.** Another live Claude session edits the main
  checkout of this repo. Enter the existing worktree
  `C:\Users\pmaxh\Documents\node-projects\healthy\.claude\worktrees\android-health-connect-uploader`
  (branch `worktree-android-health-connect-uploader`, `npm install` already
  done) with `EnterWorktree` by `path`, or create a new worktree from that
  branch. Never `cd` to the main checkout. Pushing: fast-forward `main` from
  the worktree branch (`git push origin HEAD:main`) after rebasing on
  `origin/main`.
- **Autonomy.** No questions to the owner except the ultraquest five:
  outbound communication (queue it), irreversible production writes beyond
  this spec, money, two locked answers that cannot both hold, or a departure
  from a locked answer (disclose, even after the fact). Everything else is a
  judgment call to make and report.
- **Blocked-on-owner moments** (PushNotification once, then every ~30 min
  while blocked; one line naming the exact action): Health Connect
  permission tap if `pm grant` fails; keeping the phone awake and charging
  during the backfill; confirming the Access bypass and any Workers Builds
  change the browser subagent made; confirming the four Actions secrets;
  scanning the QR against production; moving `.dev.vars` into `worker/`.
- **Delegation (hard rule).** Sonnet and Opus subagents implement; the
  orchestrator reviews diffs, wires modules, owns the ingest auth boundary,
  the migration, the Access change and the push to `main`. Browser work is
  always a subagent with `mcp__claude-in-chrome__*`. One Opus reviewer pass
  per wave, not per module.
- **Privacy (non-negotiable).** No personal data in any tracked file: no
  real record values (also not in test expectations), no timezone name, no
  device serials or wireless-debugging addresses, no app package names from
  the owner's phone in fixtures, no origin package names in log strings.
  Captures stay in `.local/`. The Android app ships no analytics.
- **Validate locally first** (`CLAUDE.md`, memory `validate-locally-first`):
  nothing is pushed to find out whether it works. UI changes are screenshot-
  verified under the production bundle and the real Worker CSP before
  deploying and rechecked on production (memory `verify-ui-visually`).
- **Stuck policy.** Park and document, keep shipping other waves; a parked
  item is listed in the report with what was tried. Red CI: fix forward.
- **Never cap** fetches or stores. The byte budget is the one documented,
  caller-liftable exception and always says `truncated`.
- **Naming.** "health system", never "provider"; "device" or "phone" for the
  companion source; "practitioner" for clinicians.
- **Conventional commits**, body explains why. Attribution trailers follow
  the executing harness's own rule; never put a model identifier in a commit,
  comment or tracked file.

## 7. Standing answers and memory to record (do it in wave 4, not before)

Append to `~/unbroker/.claude/ultraquest-standing-answers.md` under a new
`## Repo: pmaxhogan/healthy` heading, dated 2026-10-10:

- Deploy path: push straight to `main` per green wave; Workers Builds runs
  `npm run check` then `npm run deploy`. No PR flow.
- Pre-grants always on: adb install/uninstall/launch/logcat/reverse on the
  owner's phone and `pm grant` attempts; toolchain downloads from official
  sources; `wrangler secret put`, read-only remote D1 queries, remote
  migrations via deploy; keystore in `.local/` and Actions secrets via a
  claude-in-chrome subagent; dashboard changes via a claude-in-chrome
  subagent with a confirming push.
- Browser automation: `mcp__claude-in-chrome__*` for this repo (overrides
  the global `/browse` rule).
- Tests: vitest unit for all logic plus workerd integration for every route
  and tool; synthetic fixtures generated without real data; Android JVM unit
  tests, no instrumented tests; on-device E2E via `adb reverse` to local
  `wrangler dev`, captures in `.local/`.
- Android releases: tapshim convention (VERSION file, commit-count patch,
  `KEYSTORE_BASE64`/`KEYSTORE_PASSWORD`/`KEY_ALIAS`/`KEY_PASSWORD`,
  `gh release create`, `obtainium.json`), release on every `main` push.
- Storage posture: seal everything, pre-aggregate; never clear clinical
  columns.
- Budget: 5 to 8 concurrent agents, Sonnet mechanical, Opus logic and
  review.
- Comms: push per wave and per block; artifact report without the Unbroker
  widget; Trello MUST card with links; memory and standing-answers updates.

Memory files to write or update (project memory dir
`C:\Users\pmaxh\.claude\projects\C--Users-pmaxh-Documents-node-projects-healthy\memory\`):
a `project` memory for the Health Connect pipeline (decided 2026-10-10,
monorepo, device tokens, sealed hour chunks), and an update to
`parallelize-less` noting the owner chose 5 to 8 agents for this quest.

## 8. Current-state snapshot (2026-10-10, may be stale)

- Repo `pmaxhogan/healthy`, `main` at `f9c6559` ("docs(epic): describe how a
  derived secret is registered in the developer portal"), clean. Production
  `https://healthy.maxhogan.dev/health` answers `{"ok":true}`. Workers Builds
  deploys `main`; CI is `npm run check` plus gitleaks; Dependabot auto-merge
  is on.
- Worktree `.claude/worktrees/android-health-connect-uploader` on branch
  `worktree-android-health-connect-uploader`, created from `origin/main`,
  `npm install` done, no commits beyond `main` except this spec.
- Another live Claude Code session (pid 40888, "verify-healthy-confirm-
  modmed-fhir-app") is working in the main checkout.
- Owner's phone: Pixel 8, Android 17 (API 37), Health Connect module
  2026.09.03, reachable over wireless adb from this PC (`adb devices` lists
  it; a second, unrelated device is also attached, ignore it). Health Connect
  writers are identified by `dataOrigin` once data flows.
- This PC: Android SDK at `%LOCALAPPDATA%\Android\Sdk` with platforms 28, 33,
  34, 35, 36, 36.1, build-tools up to 37.0.0, emulator, system images for 34
  and 37; no `cmdline-tools`; JDK 21 (`C:\Program Files\Java\jdk-21`); adb on
  PATH via Chocolatey; no Gradle on PATH (use the wrapper). `ANDROID_HOME` is
  unset; set it or write `android/local.properties` (gitignored).
- Research notes with URLs: Jetpack Health Connect release page
  (`developer.android.com/jetpack/androidx/releases/health-connect`), the
  read-data, sync-data and rate-limiting guides under
  `developer.android.com/health-and-fitness/health-connect/`. Of the three
  exporters in the audit, none is worth forking; `alexandershalin/health-connect-gate`
  (MIT) is the one to borrow from (reflection encoder, monthly chunked
  backfill, changes-token fallback). Unverified: numeric rate-limit quotas,
  whether `pm grant` works for health permissions, whether a battery
  exemption is needed on this phone.
