// The Google Health sync against the real D1 schema: what it asks Google for,
// what it stores (sealed), how a later read replaces its window, and how a
// failure is recorded. Google is a stub; every value is synthetic.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { GOOGLE_HEALTH_SCOPES, addDays } from "../../../src/google/health.ts";
import { RECENT_DAYS, runGoogleHealthSync } from "../../../src/sync/google-health-sync.ts";

import { T0, resetSyncDb, seedGoogle, syncCtx, syncRepos } from "./helpers.ts";

import type { Ctx } from "../../../src/db/client.ts";

beforeEach(resetSyncDb);

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

/** The test clock's UTC day, and the ends of the windows a read asks for. */
const TODAY = new Date(T0 * 1000).toISOString().slice(0, 10);
const END = addDays(TODAY, 2);
const RECENT = addDays(TODAY, -14);
const YESTERDAY = addDays(TODAY, -1);
const WEEK_AGO = addDays(TODAY, -6);
const OLD = "2026-03-01";

interface Seen {
  method: string;
  path: string;
  filter: string | null;
  body: Record<string, unknown> | null;
  authorization: string | null;
}

/** The access token the stub's token endpoint mints for a narrowed refresh. */
const HEALTH_TOKEN = "minted-health-access";

const gdate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
};

/** What the stub answers: SpO2 days for a `list`, AZM for a rollup window, else nothing. */
interface StubData {
  spo2: string[];
  azm: string[];
  /** Data types whose `list` answers 400 ACCOUNT_NOT_LINKED. */
  unlinked?: Set<string>;
}

function googleStub(data: StubData): {
  fetchImpl: typeof fetch;
  seen: Seen[];
  tokenForms: URLSearchParams[];
} {
  const seen: Seen[] = [];
  const tokenForms: URLSearchParams[] = [];
  const respondTo = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "oauth2.googleapis.com") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      tokenForms.push(form);
      return Response.json({
        access_token: `${HEALTH_TOKEN}-${String(tokenForms.length)}`,
        expires_in: 3599,
        scope: form.get("scope") ?? "",
        token_type: "Bearer",
      });
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      filter: url.searchParams.get("filter"),
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const type = url.pathname.split("/", 6)[5] ?? "";
    if (data.unlinked?.has(type) === true) {
      return Response.json(
        { error: { status: "FAILED_PRECONDITION", details: [{ reason: "ACCOUNT_NOT_LINKED" }] } },
        { status: 400 },
      );
    }
    if (type === "daily-oxygen-saturation") {
      return Response.json({
        dataPoints: data.spo2.map((day, index) => ({
          dailyOxygenSaturation: { date: gdate(day), averagePercentage: 94 + index },
        })),
      });
    }
    if (type === "active-zone-minutes") {
      return Response.json({
        rollupDataPoints: data.azm.map((day) => ({
          civilStartTime: { date: gdate(day) },
          activeZoneMinutes: { sumInFatBurnHeartZone: "5", sumInCardioHeartZone: "2" },
        })),
      });
    }
    return Response.json(url.pathname.endsWith(":dailyRollUp") ? { rollupDataPoints: [] } : {});
  };
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(respondTo(input, init));
  return { fetchImpl: fetchImpl, seen, tokenForms };
}

async function grant(ctx: Ctx, scope: string): Promise<void> {
  await seedGoogle(ctx);
  await syncRepos(ctx).google.upsertTokens({ scope });
}

const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, sleep: () => Promise.resolve() });

describe("the Google Health access token", () => {
  it("is minted from the stored refresh token, narrowed to the Google Health scopes", async () => {
    const ctx = syncCtx();
    await grant(ctx, `${CALENDAR_SCOPE} ${GOOGLE_HEALTH_SCOPES.join(" ")}`);
    const stub = googleStub({ spo2: [], azm: [] });

    await runGoogleHealthSync(ctx, deps(stub.fetchImpl));

    expect(stub.tokenForms).toHaveLength(1);
    const form = stub.tokenForms[0];
    expect(form?.get("grant_type")).toBe("refresh_token");
    expect(form?.get("refresh_token")).toBe("seeded-google-refresh");
    // The calendar scope is not asked for: Google Health refuses a token carrying it.
    expect(form?.get("scope")).toBe(GOOGLE_HEALTH_SCOPES.join(" "));
    const reads = stub.seen.filter((call) => call.path.startsWith("/v4/"));
    // Five daily lists and one window of each of the two rollups.
    expect(reads).toHaveLength(7);
    expect(reads.every((call) => call.authorization === `Bearer ${HEALTH_TOKEN}-1`)).toBe(true);
  });

  it("asks only for the Google Health scopes the grant has", async () => {
    const ctx = syncCtx();
    const metrics = GOOGLE_HEALTH_SCOPES[0] ?? "";
    await grant(ctx, `${CALENDAR_SCOPE} ${metrics}`);
    const stub = googleStub({ spo2: [], azm: [] });

    await runGoogleHealthSync(ctx, deps(stub.fetchImpl));

    expect(stub.tokenForms[0]?.get("scope")).toBe(metrics);
  });

  it("leaves the calendar's access token, its expiry and the refresh token untouched", async () => {
    const ctx = syncCtx();
    await grant(ctx, `${CALENDAR_SCOPE} ${GOOGLE_HEALTH_SCOPES.join(" ")}`);
    const columns = "access_token_enc, access_expires_at, refresh_token_enc, scope";
    const before = await env.DB.prepare(
      `SELECT ${columns} FROM google_account WHERE id = 1`,
    ).first();

    await runGoogleHealthSync(ctx, deps(googleStub({ spo2: [YESTERDAY], azm: [] }).fetchImpl));

    const after = await env.DB.prepare(
      `SELECT ${columns} FROM google_account WHERE id = 1`,
    ).first();
    expect(after).toStrictEqual(before);
    const secrets = await syncRepos(ctx).google.getSecrets();
    expect(secrets.accessToken).toBe("seeded-google-access");
    expect(secrets.refreshToken).toBe("seeded-google-refresh");
  });

  it("mints a new one after a 401, and still never touches the calendar's", async () => {
    const ctx = syncCtx();
    await grant(ctx, GOOGLE_HEALTH_SCOPES.join(" "));
    const stub = googleStub({ spo2: [], azm: [] });
    let unauthorized = true;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (unauthorized && url.includes("daily-oxygen-saturation")) {
        unauthorized = false;
        return Promise.resolve(new Response("{}", { status: 401 }));
      }
      return stub.fetchImpl(input, init);
    }) as typeof fetch;

    const summary = await runGoogleHealthSync(ctx, deps(fetchImpl));

    expect(summary.errors).toStrictEqual([]);
    expect(stub.tokenForms).toHaveLength(2);
    expect(stub.tokenForms.every((form) => form.get("scope") !== null)).toBe(true);
    const secrets = await syncRepos(ctx).google.getSecrets();
    expect(secrets.accessToken).toBe("seeded-google-access");
  });
});

describe("runGoogleHealthSync", () => {
  it("reads every metric's whole history first, and stores it sealed", async () => {
    const ctx = syncCtx();
    await grant(ctx, `${CALENDAR_SCOPE} ${GOOGLE_HEALTH_SCOPES.join(" ")}`);
    const stub = googleStub({ spo2: [YESTERDAY, OLD], azm: [YESTERDAY] });

    const summary = await runGoogleHealthSync(ctx, deps(stub.fetchImpl));

    expect(summary.skipped).toBeNull();
    expect(summary.errors).toStrictEqual([]);
    expect(summary.synced).toHaveLength(7);
    const spo2 = stub.seen.find((call) => call.path.includes("daily-oxygen-saturation"));
    // No lower bound: the whole history.
    expect(spo2?.filter).toBe(`daily_oxygen_saturation.date < "${END}"`);
    // The interval types start at the oldest day a daily summary has.
    const azm = stub.seen.filter((call) => call.path.includes("active-zone-minutes"));
    expect(azm[0]?.body?.range).toStrictEqual({
      start: { date: gdate(OLD) },
      end: { date: gdate(addDays(OLD, 90)) },
    });
    expect(azm).toHaveLength(2);

    const repos = syncRepos(ctx);
    const stored = await repos.googleHealth.days(
      ["DailyOxygenSaturation", "ActiveZoneMinutes"],
      "2026-01-01",
      "2026-12-31",
    );
    expect(stored.map((day) => [day.dataType, day.date, day.values])).toStrictEqual([
      ["DailyOxygenSaturation", OLD, { averagePct: 95 }],
      ["DailyOxygenSaturation", YESTERDAY, { averagePct: 94 }],
      ["ActiveZoneMinutes", YESTERDAY, { fatBurnMin: 5, cardioMin: 2, totalMin: 7 }],
    ]);
    const raw = await env.DB.prepare(
      "SELECT payload_enc FROM google_health_daily WHERE data_type = 'DailyOxygenSaturation'",
    ).all<{ payload_enc: string }>();
    for (const row of raw.results) {
      expect(row.payload_enc.startsWith("v2:")).toBe(true);
      expect(row.payload_enc).not.toContain("averagePct");
    }
    const rows = await repos.googleHealth.syncRows();
    expect(rows.every((row) => row.backfilled_at !== null && row.last_error_code === null)).toBe(
      true,
    );
    const extents = await repos.googleHealth.extents();
    expect(extents.find((extent) => extent.dataType === "DailyOxygenSaturation")).toStrictEqual({
      dataType: "DailyOxygenSaturation",
      days: 2,
      firstDate: OLD,
      lastDate: YESTERDAY,
    });
  });

  it("then reads only the recent window, and drops a day Google no longer has there", async () => {
    const ctx = syncCtx();
    await grant(ctx, GOOGLE_HEALTH_SCOPES.join(" "));
    await runGoogleHealthSync(
      ctx,
      deps(googleStub({ spo2: [YESTERDAY, WEEK_AGO, OLD], azm: [] }).fetchImpl),
    );
    // Within the seeded access token's hour, so no refresh is needed.
    const later = syncCtx({ now: () => T0 + 600 });
    const stub = googleStub({ spo2: [YESTERDAY], azm: [] });

    await runGoogleHealthSync(later, deps(stub.fetchImpl));

    const spo2 = stub.seen.find((call) => call.path.includes("daily-oxygen-saturation"));
    expect(spo2?.filter).toBe(
      `daily_oxygen_saturation.date >= "${RECENT}" AND daily_oxygen_saturation.date < "${END}"`,
    );
    expect(RECENT_DAYS).toBe(14);
    const stored = await syncRepos(later).googleHealth.days(
      ["DailyOxygenSaturation"],
      "2026-01-01",
      "2026-12-31",
    );
    // 06-10 left the window's answer; 03-01 is outside the window and stays.
    expect(stored.map((day) => day.date)).toStrictEqual([OLD, YESTERDAY]);
  });

  it("reads the whole history again when asked for a full sync", async () => {
    const ctx = syncCtx();
    await grant(ctx, GOOGLE_HEALTH_SCOPES.join(" "));
    await runGoogleHealthSync(ctx, deps(googleStub({ spo2: [], azm: [] }).fetchImpl));
    const stub = googleStub({ spo2: [], azm: [] });

    await runGoogleHealthSync(ctx, deps(stub.fetchImpl), { full: true });

    const spo2 = stub.seen.find((call) => call.path.includes("daily-oxygen-saturation"));
    expect(spo2?.filter).toBe(`daily_oxygen_saturation.date < "${END}"`);
  });

  it("records a metric that fails, and carries on with the others", async () => {
    const ctx = syncCtx();
    await grant(ctx, GOOGLE_HEALTH_SCOPES.join(" "));
    const stub = googleStub({
      spo2: [YESTERDAY],
      azm: [],
      unlinked: new Set(["daily-vo2-max"]),
    });

    const summary = await runGoogleHealthSync(ctx, deps(stub.fetchImpl));

    expect(summary.errors).toStrictEqual([
      { type: "DailyVo2Max", code: "google_health_not_linked" },
    ]);
    expect(summary.synced).toHaveLength(6);
    const rows = await syncRepos(ctx).googleHealth.syncRows();
    const vo2 = rows.find((row) => row.data_type === "DailyVo2Max");
    expect(vo2?.last_error_code).toBe("google_health_not_linked");
    expect(vo2?.last_ok_at).toBeNull();
    expect(vo2?.backfilled_at).toBeNull();

    // The next success clears the code and keeps the attempt.
    await runGoogleHealthSync(ctx, deps(googleStub({ spo2: [], azm: [] }).fetchImpl));
    const after = await syncRepos(ctx).googleHealth.syncRows();
    expect(after.find((row) => row.data_type === "DailyVo2Max")?.last_error_code).toBeNull();
  });

  it("reads only the metrics the granted scopes cover", async () => {
    const ctx = syncCtx();
    await grant(ctx, `${CALENDAR_SCOPE} ${GOOGLE_HEALTH_SCOPES[0] ?? ""}`);
    const stub = googleStub({ spo2: [], azm: [] });

    const summary = await runGoogleHealthSync(ctx, deps(stub.fetchImpl));

    expect(summary.synced).toStrictEqual([
      "DailyOxygenSaturation",
      "DailyHeartRateVariability",
      "DailySleepTemperatureDerivations",
      "DailyHeartRateZones",
    ]);
  });

  it("skips, asking Google nothing, without a grant to ride on", async () => {
    const ctx = syncCtx();
    const stub = googleStub({ spo2: [], azm: [] });

    const disconnected = await runGoogleHealthSync(ctx, deps(stub.fetchImpl));
    await grant(ctx, CALENDAR_SCOPE);
    const calendarOnly = await runGoogleHealthSync(ctx, deps(stub.fetchImpl));
    await syncRepos(ctx).google.markNeedsReauth();
    const reauth = await runGoogleHealthSync(ctx, deps(stub.fetchImpl));

    expect(disconnected.skipped).toBe("not_connected");
    expect(calendarOnly.skipped).toBe("scope_not_granted");
    expect(reauth.skipped).toBe("needs_reauth");
    expect(stub.seen).toStrictEqual([]);
  });

  it("never throws, even when the token cannot be had", async () => {
    const ctx = syncCtx();
    await grant(ctx, GOOGLE_HEALTH_SCOPES.join(" "));
    // The token endpoint refuses the refresh token.
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      )) as unknown as typeof fetch;

    const summary = await runGoogleHealthSync(ctx, deps(fetchImpl));

    expect(summary.errors[0]?.code).toBe("needs_reauth");
    expect(summary.synced).toStrictEqual([]);
  });
});
