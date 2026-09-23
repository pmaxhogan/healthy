// The 0007 backfill, end to end: rows written in the pre-blinding shape, a fake
// Google calendar holding events that carry the old keys, then the backfill and
// the sync that follows it.
//
// What has to hold: every row is rewritten (blinded, sealed, padded) without
// losing what it pointed at; every Google event keeps its id and gains the new
// key; the sync afterwards pairs each row with its event and inserts nothing; a
// second run finds nothing to do; a run cut off half-way finishes on the next
// one; and the sync touches nothing at all until the backfill has finished.
// Every value is synthetic.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { BLIND_BACKFILL, runBlindBackfill } from "../../../worker/db/backfill.ts";
import { isBlindedEventKey } from "../../../worker/db/blind.ts";
import { aadFor, seal } from "../../../worker/db/crypto.ts";
import { fromIso } from "../../../worker/lib/time.ts";
import { runCalendarSync } from "../../../worker/sync/calendar-sync.ts";
import { getGoogleCalendarFor } from "../../../worker/sync/google-tokens.ts";

import {
  clock,
  encounter,
  fhirServer,
  referencePool,
  resetSyncDb,
  searchBundle,
  seedConnectedProvider,
  seedGoogle,
  seedSettings,
  sk,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { SeededProvider, Upstreams } from "./helpers.ts";
import type { BackfillCounts } from "../../../worker/db/backfill.ts";
import type { Ctx } from "../../../worker/db/client.ts";

beforeEach(resetSyncDb);

const HOST = "fhir.a.example.test";
/** Two weeks after the suite's T0: upcoming. */
const UPCOMING = "2026-06-29T15:30:00Z";
/** Ten days before T0: over. */
const PAST = "2026-06-05T14:00:00Z";

interface Harness {
  ctx: Ctx;
  upstreams: Upstreams;
  provider: SeededProvider;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A `v1:` seal: what every sealed column held before padding existed. */
function sealV1(ctx: Ctx, plaintext: string, aad: string): Promise<string> {
  return seal(ctx.env, plaintext, aad);
}

async function setup(options: { google?: boolean } = {}): Promise<Harness> {
  const time = clock();
  const ctx = syncCtx({ now: time.now });
  const provider = await seedConnectedProvider(ctx, { host: HOST });
  if (options.google !== false) await seedGoogle(ctx);
  await seedSettings(ctx);
  const server = fhirServer({ resources: referencePool() });
  server.encounters = searchBundle([encounter({ id: "enc-1", start: UPCOMING })]);
  const upstreams = stubUpstreams({ [HOST]: server });
  return { ctx, upstreams, provider };
}

/** Plant an event this app wrote before 0007, and return its Google id. */
function plantLegacyEvent(h: Harness, key: string, start: string): string {
  h.upstreams.calendar.plant({
    summary: "Office Visit",
    start: { dateTime: start },
    end: { dateTime: start },
    extendedProperties: {
      private: { healthy: "1", key, fp: "legacy-fp", provider: h.provider.providerId },
    },
  });
  const planted = h.upstreams.calendar.events().at(-1);
  if (planted === undefined) throw new Error("nothing planted");
  return planted.id;
}

async function insertLegacyRow(
  h: Harness,
  row: {
    encounterId: string;
    googleEventId: string;
    start: string;
    source: "fhir" | "portal";
    portalCsn?: string;
  },
): Promise<void> {
  const providerId = h.provider.providerId;
  const at = h.ctx.now();
  await env.DB.prepare(
    `INSERT INTO calendar_events
       (event_key, provider_id, encounter_id, calendar_id, google_event_id, fingerprint,
        state, start_at, first_seen_at, last_seen_at, ghosted_at, updated_at, source, portal_csn)
     VALUES (?, ?, ?, 'primary', ?, 'legacy-fp', 'active', ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      `${providerId}:${row.encounterId}`,
      providerId,
      row.encounterId,
      row.googleEventId,
      fromIso(row.start),
      at,
      at,
      at,
      row.source,
      row.portalCsn ?? null,
    )
    .run();
}

/**
 * Put the database back into the shape the previous deploy left it in: plaintext
 * settings and identities, `v1:` short seals, cache and visit rows keyed by the
 * upstream ids with plain sha256 digests, and calendar rows (and their events)
 * carrying the old keys.
 */
async function legacyDatabase(h: Harness): Promise<{ upcomingEventId: string }> {
  const { ctx } = h;
  const providerId = h.provider.providerId;
  const db = env.DB;

  await db
    .prepare("UPDATE settings SET value_json = ? WHERE key = 'calendar_id'")
    .bind(JSON.stringify("primary"))
    .run();
  await db
    .prepare("UPDATE settings SET value_json = ? WHERE key = 'timezone'")
    .bind(JSON.stringify("UTC"))
    .run();
  await db
    .prepare(
      `UPDATE providers SET display_name = 'A Example Health', fhir_base_url = ?,
              portal_url = 'https://portal.a.example.test',
              config_json = '{"arrival_offsets_by_visit_type":{},"enabled":true}'
        WHERE id = ?`,
    )
    .bind(h.provider.fhirBaseUrl, providerId)
    .run();
  await db
    .prepare("UPDATE google_account SET email_enc = ? WHERE id = 1")
    .bind(await sealV1(ctx, "owner@example.test", aadFor("google_account", "email_enc", 1)))
    .run();
  await db
    .prepare(
      `INSERT INTO portal_accounts
         (provider_id, base_url, mount_path, username_enc, password_enc, session_state, updated_at)
       VALUES (?, 'https://portal.a.example.test', '/Portal/', ?, ?, 'none', ?)`,
    )
    .bind(
      providerId,
      await sealV1(ctx, "legacy-user", aadFor("portal_accounts", "username_enc", providerId)),
      await sealV1(ctx, "legacy-pass", aadFor("portal_accounts", "password_enc", providerId)),
      ctx.now(),
    )
    .run();

  const cached = JSON.stringify(encounter({ id: "enc-1", start: UPCOMING }));
  await db
    .prepare(
      `INSERT INTO fhir_cache
         (provider_id, resource_type, resource_id, payload_enc, content_hash,
          last_updated, fetched_at, expires_at)
       VALUES (?, 'Encounter', 'enc-1', ?, ?, NULL, ?, ?)`,
    )
    .bind(
      providerId,
      await sealV1(ctx, cached, aadFor("fhir_cache", "payload", `${providerId}:Encounter:enc-1`)),
      await sha256Hex(cached),
      ctx.now(),
      ctx.now() + 8 * 86_400,
    )
    .run();

  const visit = JSON.stringify({
    csn: "csn-9",
    start: UPCOMING,
    timeZone: "UTC",
    visitType: "Follow-up",
    isVideo: false,
    status: "scheduled",
  });
  const visitExpiry = fromIso(UPCOMING) + 365 * 86_400;
  await db
    .prepare(
      `INSERT INTO portal_visits
         (provider_id, csn, payload_enc, content_hash, start_at, status, state,
          missing_since, fetched_at, expires_at)
       VALUES (?, 'csn-9', ?, ?, ?, 'scheduled', 'active', NULL, ?, ?)`,
    )
    .bind(
      providerId,
      await sealV1(ctx, visit, aadFor("portal_visits", "payload_enc", `${providerId}:csn-9`)),
      await sha256Hex(visit),
      fromIso(UPCOMING),
      ctx.now(),
      visitExpiry,
    )
    .run();

  const upcomingEventId = plantLegacyEvent(h, `${providerId}:enc-1`, UPCOMING);
  await insertLegacyRow(h, {
    encounterId: "enc-1",
    googleEventId: upcomingEventId,
    start: UPCOMING,
    source: "fhir",
  });
  const portalEventId = plantLegacyEvent(h, `${providerId}:csn:csn-7`, PAST);
  await insertLegacyRow(h, {
    encounterId: "csn:csn-7",
    googleEventId: portalEventId,
    start: PAST,
    source: "portal",
    portalCsn: "csn-7",
  });
  // An event carrying an old key and no row at all.
  plantLegacyEvent(h, `${providerId}:enc-orphan`, UPCOMING);
  return { upcomingEventId };
}

async function progress(): Promise<{ completed_at: number | null; counts: BackfillCounts }> {
  const row = await env.DB.prepare(
    "SELECT completed_at, progress_json FROM data_migrations WHERE name = ?",
  )
    .bind(BLIND_BACKFILL)
    .first<{ completed_at: number | null; progress_json: string }>();
  return {
    completed_at: row?.completed_at ?? null,
    counts: JSON.parse(row?.progress_json ?? "{}") as BackfillCounts,
  };
}

/**
 * Every row of every table, as one string: what a D1 snapshot would hold.
 * `except` leaves tables out, for comparing two snapshots around bookkeeping.
 */
async function snapshot(except: readonly string[] = []): Promise<string> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const dump: Record<string, unknown[]> = {};
  for (const { name } of tables.results) {
    if (except.includes(name)) continue;
    const rows = await env.DB.prepare(`SELECT * FROM ${name}`).all();
    dump[name] = rows.results;
  }
  return JSON.stringify(dump);
}

function backfillOf(h: Harness) {
  return runBlindBackfill(h.ctx, {
    calendar: () => getGoogleCalendarFor(h.ctx, h.upstreams.deps),
  });
}

describe("the 0007 backfill", () => {
  it("rewrites every legacy row and re-keys the events, and the sync after it inserts nothing", async () => {
    const h = await setup();
    const { upcomingEventId } = await legacyDatabase(h);
    const providerId = h.provider.providerId;

    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.errors).toStrictEqual([]);
    // One visit, one event: the existing event was found under its new key and
    // patched (its fingerprint is keyed now), never duplicated.
    expect(summary.eventsInserted).toBe(0);
    expect(h.upstreams.calendar.inserts).toBe(0);
    expect(h.upstreams.calendar.events()).toHaveLength(3);
    // Iterator#toArray needs the esnext.iterator lib; the test tsconfig is ES2022 only.
    // eslint-disable-next-line unicorn/prefer-iterator-to-array
    const keys = [...h.upstreams.calendar.byKey().keys()];
    expect(keys.every((key) => isBlindedEventKey(key))).toBe(true);
    const upcoming = h.upstreams.calendar.byKey().get(await sk(`${providerId}:enc-1`));
    expect(upcoming?.id).toBe(upcomingEventId);

    const { completed_at: completedAt, counts } = await progress();
    expect(completedAt).not.toBeNull();
    expect(counts).toStrictEqual({
      settingsSealed: 2,
      providerColumnsSealed: 4,
      portalColumnsSealed: 2,
      shortSealsPadded: 3,
      cacheRowsRekeyed: 1,
      visitsRekeyed: 1,
      calendarRowsRekeyed: 2,
      googleEventsRekeyed: 2,
      googleOrphansRekeyed: 1,
    });

    // The rows still say what they said, through the repos.
    const repos = syncRepos(h.ctx);
    const row = await repos.calendarEvents.getByKey(await sk(`${providerId}:enc-1`));
    expect(row).toMatchObject({
      google_event_id: upcomingEventId,
      calendar_id: "primary",
      start_at: fromIso(UPCOMING),
      state: "active",
    });
    const portalRow = await repos.calendarEvents.getByKey(await sk(`${providerId}:csn:csn-7`));
    expect(portalRow).toMatchObject({ source: "portal", start_at: fromIso(PAST) });
    await expect(repos.fhirCache.get(providerId, "Encounter", "enc-1")).resolves.not.toBeNull();
    const [visit] = await repos.portalVisits.list(providerId);
    expect(visit?.csn).toBe("csn-9");
    await expect(repos.providers.get(providerId)).resolves.toMatchObject({
      display_name: "A Example Health",
    });
    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toMatchObject({
      username: "legacy-user",
      password: "legacy-pass",
    });
    await expect(repos.portalAccounts.get(providerId)).resolves.toMatchObject({
      base_url: "https://portal.a.example.test",
      mount_path: "/Portal/",
    });

    // And a snapshot no longer carries any of it.
    const dump = await snapshot();
    for (const secret of [
      "enc-1",
      "csn-7",
      "csn-9",
      "enc-orphan",
      "owner@example",
      "Example Health",
      "portal.a.example.test",
      HOST,
      '"primary"',
    ]) {
      expect(dump, secret).not.toContain(secret);
    }
    // Every short, human-chosen seal is padded now.
    const unpadded = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM google_account WHERE email_enc LIKE 'v1:%')
            + (SELECT COUNT(*) FROM portal_accounts
                WHERE username_enc LIKE 'v1:%' OR password_enc LIKE 'v1:%') AS n`,
    ).first<{ n: number }>();
    expect(unpadded?.n).toBe(0);
  });

  it("is idempotent: a second pass over a finished database changes nothing", async () => {
    const h = await setup();
    await legacyDatabase(h);
    await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    const before = await snapshot(["data_migrations"]);
    const patches = h.upstreams.calendar.patches;

    // Forget that it finished, so every step runs again over migrated rows.
    await env.DB.prepare("UPDATE data_migrations SET completed_at = NULL").run();
    const again = await backfillOf(h);

    expect(again.complete).toBe(true);
    expect(Object.values(again.counts).every((count) => count === 0)).toBe(true);
    expect(h.upstreams.calendar.patches).toBe(patches);
    // Only the bookkeeping row moved.
    expect(await snapshot(["data_migrations"])).toBe(before);
  });

  it("finishes a run that died between the Google patch and the row", async () => {
    const h = await setup();
    const { upcomingEventId } = await legacyDatabase(h);
    const providerId = h.provider.providerId;
    // The event already carries its new key; the row does not.
    const event = h.upstreams.calendar.events().find((stored) => stored.id === upcomingEventId);
    Object.assign(event ?? {}, {
      extendedProperties: {
        private: {
          healthy: "1",
          key: await sk(`${providerId}:enc-1`),
          fp: "legacy-fp",
          provider: providerId,
        },
      },
    });

    const result = await backfillOf(h);

    expect(result.complete).toBe(true);
    expect(result.counts.calendarRowsRekeyed).toBe(2);
    // Only the portal row's event still needed its key.
    expect(result.counts.googleEventsRekeyed).toBe(1);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });
    expect(summary.eventsInserted).toBe(0);
    expect(h.upstreams.calendar.events()).toHaveLength(3);
  });

  it("keeps the fresher blinded cache row when a legacy twin is still there", async () => {
    const h = await setup();
    await legacyDatabase(h);
    const providerId = h.provider.providerId;
    const repos = syncRepos(h.ctx);
    const fresh = {
      ...encounter({ id: "enc-1", start: UPCOMING }),
      id: "enc-1",
      status: "arrived" as const,
    };
    await repos.fhirCache.upsertMany(providerId, [fresh], 86_400_000);

    await backfillOf(h);

    const rows = await env.DB.prepare(
      "SELECT resource_id FROM fhir_cache WHERE provider_id = ? AND resource_type = 'Encounter'",
    )
      .bind(providerId)
      .all<{ resource_id: string }>();
    expect(rows.results).toHaveLength(1);
    await expect(repos.fhirCache.get(providerId, "Encounter", "enc-1")).resolves.toMatchObject({
      resource: { status: "arrived" },
    });
  });

  it("holds every sync back until it can finish, and touches nothing meanwhile", async () => {
    // No Google account: the calendar step cannot re-key the events.
    const h = await setup({ google: false });
    await legacyDatabase(h);
    const providerId = h.provider.providerId;

    const blocked = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(blocked.errors.map((error) => error.providerId)).toStrictEqual(["backfill"]);
    expect(blocked.encountersSeen).toBe(0);
    expect(h.upstreams.calendar.inserts + h.upstreams.calendar.patches).toBe(0);
    const pending = await progress();
    expect(pending.completed_at).toBeNull();
    // The legacy calendar rows are untouched, so the next run can still pair them.
    const legacy = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM calendar_events WHERE detail_enc IS NULL",
    ).first<{ n: number }>();
    expect(legacy?.n).toBe(2);

    await seedGoogle(h.ctx);
    const summary = await runCalendarSync(h.ctx, { deps: h.upstreams.deps });

    expect(summary.errors).toStrictEqual([]);
    expect(summary.eventsInserted).toBe(0);
    expect(h.upstreams.calendar.events()).toHaveLength(3);
    expect(h.upstreams.calendar.byKey().has(await sk(`${providerId}:enc-1`))).toBe(true);
  });

  it("refuses to run twice at once", async () => {
    const h = await setup();
    await legacyDatabase(h);
    await env.DB.prepare(
      "INSERT INTO data_migrations (name, lease_until, updated_at) VALUES (?, ?, 0)",
    )
      .bind(BLIND_BACKFILL, h.ctx.now() + 600)
      .run();

    const result = await backfillOf(h);

    expect(result).toMatchObject({ complete: false, errorCode: "backfill_busy" });
    expect(h.upstreams.calendar.patches).toBe(0);
  });
});
