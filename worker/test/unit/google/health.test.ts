// The Google Health client: what it asks for, how it reads the answers, and
// how it names a failure. Every response here is synthetic, shaped from the
// API's published discovery document.

import { describe, expect, it } from "vitest";

import {
  GH_DAILY_TYPES,
  GH_ROLLUP_TYPES,
  GH_TYPE_NAMES,
  GOOGLE_HEALTH_ACTIVITY_SCOPE,
  GOOGLE_HEALTH_METRICS_SCOPE,
  GOOGLE_HEALTH_SCOPES,
  addDays,
  civilDate,
  createGoogleHealthClient,
  googleHealthErrorCode,
  grantedTypes,
  hasHealthScope,
  num,
  parseGoogleError,
} from "../../../src/google/health.ts";
import { AppError } from "../../../src/lib/errors.ts";
import { noopLogger } from "../../../src/lib/log.ts";

import { appErrorFrom, jsonResponse, recordingFetch } from "./helpers.ts";

import type { RecordedCall } from "./helpers.ts";
import type { GhDailyType, GhRollupType } from "../../../src/google/health.ts";

function daily(type: string): GhDailyType {
  const spec = GH_DAILY_TYPES.find((entry) => entry.type === type);
  if (spec === undefined) throw new Error(`no daily type ${type}`);
  return spec;
}

function rollup(type: string): GhRollupType {
  const spec = GH_ROLLUP_TYPES.find((entry) => entry.type === type);
  if (spec === undefined) throw new Error(`no rollup type ${type}`);
  return spec;
}

function client(
  responder: (call: RecordedCall, index: number) => Response,
  given?: { forced: number },
) {
  const tokens = given ?? { forced: 0 };
  const recorded = recordingFetch(responder);
  const made = createGoogleHealthClient({
    getAccessToken: (options) => {
      if (options?.forceRefresh === true) tokens.forced += 1;
      return Promise.resolve(tokens.forced > 0 ? "token-2" : "token-1");
    },
    fetchImpl: recorded.fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  return { client: made, calls: recorded.calls, tokens };
}

const date = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
};

describe("values", () => {
  it("reads int64 strings and doubles, and nothing else", () => {
    expect(num("61")).toBe(61);
    expect(num(95.5)).toBe(95.5);
    expect(num("")).toBeUndefined();
    expect(num("x")).toBeUndefined();
    expect(num(NaN)).toBeUndefined();
    expect(num(null)).toBeUndefined();
  });

  it("writes a civil date, and refuses a partial one", () => {
    expect(civilDate({ year: 2026, month: 3, day: 7 })).toBe("2026-03-07");
    expect(civilDate({ year: 2026, month: 13, day: 7 })).toBeNull();
    expect(civilDate({ year: 2026, month: 3 })).toBeNull();
    expect(civilDate("2026-03-07")).toBeNull();
  });

  it("adds days across a month end", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("scopes", () => {
  it("names a metric readable only when its own scope is granted", () => {
    expect(grantedTypes(null)).toStrictEqual([]);
    expect(hasHealthScope("https://www.googleapis.com/auth/calendar.events.owned")).toBe(false);
    const metrics = grantedTypes(`calendar ${GOOGLE_HEALTH_METRICS_SCOPE}`).map(
      (spec) => spec.type,
    );
    expect(metrics).toContain("DailyOxygenSaturation");
    expect(metrics).not.toContain("DailyVo2Max");
    const activity = grantedTypes(GOOGLE_HEALTH_ACTIVITY_SCOPE).map((spec) => spec.type);
    expect(activity).toStrictEqual(["DailyVo2Max", "ActiveZoneMinutes", "TimeInHeartRateZone"]);
    expect(grantedTypes(GOOGLE_HEALTH_SCOPES.join(" ")).map((spec) => spec.type)).toStrictEqual(
      GH_TYPE_NAMES,
    );
  });
});

describe("listDaily", () => {
  it("filters by date, pages to the end, and keeps one point per day", async () => {
    const pageOne = {
      dataPoints: [
        {
          dailyOxygenSaturation: {
            date: date("2026-03-02"),
            averagePercentage: 95.4,
            lowerBoundPercentage: 91,
            upperBoundPercentage: 98.2,
            standardDeviationPercentage: 1.1,
          },
        },
        // A second source for the same day: the first one listed is kept.
        { dailyOxygenSaturation: { date: date("2026-03-02"), averagePercentage: 80 } },
        { somethingElse: {} },
      ],
      nextPageToken: "page-2",
    };
    const pageTwo = {
      dataPoints: [
        { dailyOxygenSaturation: { date: date("2026-03-01"), averagePercentage: 96 } },
        // No value at all: not a day.
        { dailyOxygenSaturation: { date: date("2026-02-28") } },
      ],
    };
    const { client: made, calls } = client((_call, index) =>
      jsonResponse(200, index === 0 ? pageOne : pageTwo),
    );

    const days = await made.listDaily(daily("DailyOxygenSaturation"), {
      start: "2026-03-01",
      endExclusive: "2026-03-03",
    });

    expect(days).toStrictEqual([
      { date: "2026-03-01", values: { averagePct: 96 } },
      {
        date: "2026-03-02",
        values: { averagePct: 95.4, lowerBoundPct: 91, upperBoundPct: 98.2, stdDevPct: 1.1 },
      },
    ]);
    expect(calls).toHaveLength(2);
    const first = calls[0];
    expect(first?.url.pathname).toBe("/v4/users/me/dataTypes/daily-oxygen-saturation/dataPoints");
    expect(first?.url.searchParams.get("filter")).toBe(
      'daily_oxygen_saturation.date >= "2026-03-01" AND daily_oxygen_saturation.date < "2026-03-03"',
    );
    expect(first?.url.searchParams.get("dataSourceFamily")).toBe(
      "users/me/dataSourceFamilies/google-wearables",
    );
    expect(first?.headers.authorization).toBe("Bearer token-1");
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("page-2");
  });

  it("asks for the whole history with no lower bound", async () => {
    const { client: made, calls } = client(() => jsonResponse(200, {}));

    await made.listDaily(daily("DailyHeartRateVariability"), {
      start: null,
      endExclusive: "2026-03-03",
    });

    expect(calls[0]?.url.searchParams.get("filter")).toBe(
      'daily_heart_rate_variability.date < "2026-03-03"',
    );
  });

  it("normalizes every daily metric's fields", async () => {
    const points = [
      {
        dailyHeartRateVariability: {
          date: date("2026-03-01"),
          averageHeartRateVariabilityMilliseconds: 41.2,
          deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 48.9,
          nonRemHeartRateBeatsPerMinute: "54",
          entropy: 2.3,
        },
        dailyVo2Max: {
          date: date("2026-03-01"),
          vo2Max: 44.5,
          vo2MaxCovariance: 0.8,
          cardioFitnessLevel: "VERY_GOOD",
          estimated: false,
        },
        dailySleepTemperatureDerivations: {
          date: date("2026-03-01"),
          nightlyTemperatureCelsius: 34.21,
          baselineTemperatureCelsius: 34.05,
          relativeNightlyStddev30dCelsius: 0.3,
        },
        dailyHeartRateZones: {
          date: date("2026-03-01"),
          heartRateZones: [
            { heartRateZoneType: "LIGHT", minBeatsPerMinute: "97", maxBeatsPerMinute: "121" },
            { heartRateZoneType: "HEART_RATE_ZONE_TYPE_UNSPECIFIED", minBeatsPerMinute: "1" },
            "not a zone",
          ],
        },
      },
    ];
    const { client: made } = client(() => jsonResponse(200, { dataPoints: points }));
    const range = { start: null, endExclusive: "2026-03-02" };

    const [hrv] = await made.listDaily(daily("DailyHeartRateVariability"), range);
    const [vo2] = await made.listDaily(daily("DailyVo2Max"), range);
    const [temp] = await made.listDaily(daily("DailySleepTemperatureDerivations"), range);
    const [zones] = await made.listDaily(daily("DailyHeartRateZones"), range);

    expect(hrv?.values).toStrictEqual({
      averageRmssdMs: 41.2,
      deepSleepRmssdMs: 48.9,
      nonRemHeartRateBpm: 54,
      entropy: 2.3,
    });
    expect(vo2?.values).toStrictEqual({
      vo2Max: 44.5,
      vo2MaxCovariance: 0.8,
      cardioFitnessLevel: "very_good",
      estimated: false,
    });
    expect(temp?.values).toStrictEqual({
      nightlyTempC: 34.21,
      baselineTempC: 34.05,
      nightlyDeltaC: 0.16,
      relativeNightlyStddev30dC: 0.3,
    });
    expect(zones?.values).toStrictEqual({ zones: [{ zone: "light", minBpm: 97, maxBpm: 121 }] });
  });

  it("refuses a page token handed back twice", async () => {
    const { client: made } = client(() => jsonResponse(200, { nextPageToken: "again" }));

    const error = await appErrorFrom(
      made.listDaily(daily("DailyVo2Max"), { start: null, endExclusive: "2026-03-02" }),
    );

    expect(error.code).toBe("upstream_error");
  });
});

describe("rollUpDaily", () => {
  it("asks 90 days at a time and reads each day's sums", async () => {
    const { client: made, calls } = client((_call, index) =>
      jsonResponse(200, {
        rollupDataPoints:
          index === 0
            ? [
                {
                  civilStartTime: { date: date("2026-01-01") },
                  activeZoneMinutes: {
                    sumInFatBurnHeartZone: "12",
                    sumInCardioHeartZone: "8",
                    sumInPeakHeartZone: "2",
                  },
                },
                { civilStartTime: { date: date("2026-01-02") } },
              ]
            : [],
      }),
    );

    const days = await made.rollUpDaily(rollup("ActiveZoneMinutes"), "2026-01-01", "2026-05-01");

    expect(days).toStrictEqual([
      {
        date: "2026-01-01",
        values: { fatBurnMin: 12, cardioMin: 8, peakMin: 2, totalMin: 22 },
      },
    ]);
    const ranges = calls.map((call) => (JSON.parse(call.body ?? "{}") as { range: unknown }).range);
    expect(ranges).toStrictEqual([
      { start: { date: date("2026-01-01") }, end: { date: date("2026-04-01") } },
      { start: { date: date("2026-04-01") }, end: { date: date("2026-05-01") } },
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(
      "/v4/users/me/dataTypes/active-zone-minutes/dataPoints:dailyRollUp",
    );
  });

  it("turns zone durations into minutes", async () => {
    const { client: made } = client(() =>
      jsonResponse(200, {
        rollupDataPoints: [
          {
            civilStartTime: { date: date("2026-01-01") },
            timeInHeartRateZone: {
              timeInHeartRateZones: [
                { heartRateZone: "LIGHT", duration: "1800s" },
                { heartRateZone: "PEAK", duration: "90.5s" },
                { heartRateZone: "HEART_RATE_ZONE_TYPE_UNSPECIFIED", duration: "60s" },
                { heartRateZone: "MODERATE", duration: "soon" },
              ],
            },
          },
        ],
      }),
    );

    const days = await made.rollUpDaily(rollup("TimeInHeartRateZone"), "2026-01-01", "2026-01-02");

    expect(days[0]?.values).toStrictEqual({ lightMin: 30, peakMin: 1.51 });
  });
});

describe("failures", () => {
  const range = { start: null, endExclusive: "2026-03-02" };

  it("refreshes the token once after a 401", async () => {
    const tokens = { forced: 0 };
    const { client: made, calls } = client(
      (_call, index) => jsonResponse(index === 0 ? 401 : 200, {}),
      tokens,
    );

    await made.listDaily(daily("DailyVo2Max"), range);

    expect(tokens.forced).toBe(1);
    expect(calls[1]?.headers.authorization).toBe("Bearer token-2");
  });

  it("gives up on a second 401", async () => {
    const { client: made } = client(() => jsonResponse(401, {}));

    const error = await appErrorFrom(made.listDaily(daily("DailyVo2Max"), range));

    expect(googleHealthErrorCode(error)).toBe("google_health_unauthorized");
  });

  it("backs off on a 503 and then succeeds", async () => {
    const { client: made, calls } = client((_call, index) =>
      index < 2 ? jsonResponse(503, {}, { "retry-after": "1" }) : jsonResponse(200, {}),
    );

    await made.listDaily(daily("DailyVo2Max"), range);

    expect(calls).toHaveLength(3);
  });

  it("says unavailable once the retries are spent", async () => {
    const { client: made, calls } = client(() => jsonResponse(500, {}));

    const error = await appErrorFrom(made.listDaily(daily("DailyVo2Max"), range));

    expect(error.code).toBe("upstream_unavailable");
    expect(calls).toHaveLength(4);
  });

  it("retries a network failure and then says unavailable", async () => {
    let attempts = 0;
    const made = createGoogleHealthClient({
      getAccessToken: () => Promise.resolve("t"),
      fetchImpl: () => {
        attempts += 1;
        return Promise.reject(new TypeError("network down"));
      },
      sleep: () => Promise.resolve(),
    });

    const error = await appErrorFrom(made.listDaily(daily("DailyVo2Max"), range));

    expect(error.code).toBe("upstream_unavailable");
    expect(attempts).toBe(4);
  });

  it("names an account that was never moved to Google Health", async () => {
    const { client: made, calls } = client(() =>
      jsonResponse(400, {
        error: {
          code: 400,
          status: "FAILED_PRECONDITION",
          details: [{ reason: "ACCOUNT_NOT_LINKED" }],
        },
      }),
    );

    const error = await appErrorFrom(made.listDaily(daily("DailyVo2Max"), range));

    expect(googleHealthErrorCode(error)).toBe("google_health_not_linked");
    // Not retried: signing in to the app is the fix.
    expect(calls).toHaveLength(1);
  });

  it("names a missing scope, a disabled API and any other refusal", async () => {
    const scope = client(() =>
      jsonResponse(403, {
        error: {
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            },
          ],
        },
      }),
    );
    const scopeByMessage = client(() =>
      jsonResponse(403, {
        error: {
          status: "PERMISSION_DENIED",
          message: "Request had insufficient authentication scopes.",
        },
      }),
    );
    const forbidden = client(() =>
      jsonResponse(403, {
        error: {
          status: "PERMISSION_DENIED",
          details: [{ reason: "CONSUMER_INVALID", metadata: { service: "health.googleapis.com" } }],
        },
      }),
    );
    const bare403 = client(() => jsonResponse(403, { error: { status: "PERMISSION_DENIED" } }));
    const empty403 = client(() => new Response("forbidden", { status: 403 }));
    const disabled = client(() =>
      jsonResponse(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } }),
    );
    const other = client(() => jsonResponse(404, {}));
    const notJson = client(() => new Response("<html>", { status: 200 }));

    const codeOf = async (made: ReturnType<typeof client>): Promise<string> => {
      const pending = made.client.listDaily(daily("DailyVo2Max"), range);
      return googleHealthErrorCode(await appErrorFrom(pending));
    };

    expect(await codeOf(scope)).toBe("google_health_scope_missing");
    expect(await codeOf(scopeByMessage)).toBe("google_health_scope_missing");
    // Any other 403 carries Google's own word, so the real reason is visible.
    expect(await codeOf(forbidden)).toBe("google_health_forbidden:CONSUMER_INVALID");
    expect(await codeOf(bare403)).toBe("google_health_forbidden:PERMISSION_DENIED");
    expect(await codeOf(empty403)).toBe("google_health_forbidden");
    expect(await codeOf(disabled)).toBe("google_health_api_disabled");
    expect(await codeOf(other)).toBe("upstream_error");
    expect(await codeOf(notJson)).toBe("upstream_error");
  });

  it("logs Google's status, reason and metadata, never the body or an echoed value", async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const record = (event: string, fields?: Record<string, unknown>): void => {
      lines.push({ event, fields: fields ?? {} });
    };
    const logger = { ...noopLogger, warn: record };
    const recorded = recordingFetch(() =>
      jsonResponse(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: 'Permission denied on filter "daily_vo2_max.date < 2026-03-02".',
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "SOME_NEW_REASON",
              metadata: {
                service: "health.googleapis.com",
                consumer: "projects/123456",
                method: "google.example.health.v4.DataPointService.ListDataPoints",
                email: "person@example.test",
              },
            },
            {
              "@type": "type.googleapis.com/google.rpc.Help",
              reason: "lower case is not a reason",
            },
          ],
        },
      }),
    );
    const made = createGoogleHealthClient({
      getAccessToken: () => Promise.resolve("t"),
      fetchImpl: recorded.fetchImpl,
      logger,
      sleep: () => Promise.resolve(),
    });

    const error = await appErrorFrom(made.listDaily(daily("DailyVo2Max"), range));

    expect(googleHealthErrorCode(error)).toBe("google_health_forbidden:SOME_NEW_REASON");
    expect(error.details).toMatchObject({
      status: 403,
      googleStatus: "PERMISSION_DENIED",
      googleReason: "SOME_NEW_REASON",
    });
    const failed = lines.find((line) => line.event === "google.health.request_failed");
    expect(failed?.fields).toStrictEqual({
      operation: "list daily-vo2-max",
      status: 403,
      errorCode: "google_health_forbidden:SOME_NEW_REASON",
      googleStatus: "PERMISSION_DENIED",
      googleReason: "SOME_NEW_REASON",
      googleMetadata:
        "service=health.googleapis.com method=DataPointService.ListDataPoints consumer=projects/123456",
      googleMessage: 'Permission denied on filter "...".',
    });
    expect(JSON.stringify(lines)).not.toContain("person@example.test");
    expect(JSON.stringify(lines)).not.toContain("2026-03-02");
  });

  it("reads what it can of an error body and never throws", () => {
    expect(parseGoogleError("not json")).toStrictEqual({ googleReasons: [], googleMetadata: [] });
    expect(parseGoogleError('{"error": "flat"}')).toStrictEqual({
      googleReasons: [],
      googleMetadata: [],
    });
    const long = parseGoogleError(JSON.stringify({ error: { message: "x".repeat(500) } }));
    expect(long.googleMessage).toHaveLength(200);
  });

  it("codes anything that is not an AppError as internal", () => {
    expect(googleHealthErrorCode(new Error("x"))).toBe("internal");
    expect(googleHealthErrorCode(new AppError("needs_reauth"))).toBe("needs_reauth");
  });
});
