// `google_health_daily`: the wearable metrics read from Google Health, served
// under the owner's exposure policy like every other source. Everything here is
// synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import {
  GH_TYPE_NAMES,
  GOOGLE_HEALTH_ACTIVITY_SCOPE,
  GOOGLE_HEALTH_METRICS_SCOPE,
} from "../../../src/google/health.ts";
import { EMPTY_RULES, buildRules } from "../../../src/policy/rules.ts";
import { resolveInShape, toolShapes } from "../../../src/policy/tree.ts";

import { NOW, callTool, connectTools, fakeDeps, fakeState } from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { GoogleHealthDay, GoogleHealthSyncRow } from "../../../src/db/rows.ts";
import type { GoogleHealthState } from "../../../src/mcp/deps.ts";
import type { PolicyRuleInput, PolicyRules } from "../../../src/policy/rules.ts";

const TOOL = "google_health_daily";
const TODAY = new Date(NOW * 1000).toISOString().slice(0, 10);
const BOTH_SCOPES = `${GOOGLE_HEALTH_METRICS_SCOPE} ${GOOGLE_HEALTH_ACTIVITY_SCOPE}`;

/** Every metric, every field, on two days. */
const VALUES: Record<string, Record<string, unknown>> = {
  DailyOxygenSaturation: { averagePct: 95, lowerBoundPct: 89, upperBoundPct: 99, stdDevPct: 1 },
  DailyHeartRateVariability: {
    averageRmssdMs: 40,
    deepSleepRmssdMs: 45,
    nonRemHeartRateBpm: 55,
    entropy: 2,
  },
  DailyVo2Max: { vo2Max: 44, vo2MaxCovariance: 1, cardioFitnessLevel: "good", estimated: false },
  DailySleepTemperatureDerivations: {
    nightlyTempC: 34.2,
    baselineTempC: 34,
    nightlyDeltaC: 0.2,
    relativeNightlyStddev30dC: 0.3,
  },
  DailyHeartRateZones: { zones: [{ zone: "light", minBpm: 97, maxBpm: 121 }] },
  ActiveZoneMinutes: { fatBurnMin: 10, cardioMin: 4, peakMin: 1, totalMin: 15 },
  TimeInHeartRateZone: { lightMin: 30, moderateMin: 10, vigorousMin: 5, peakMin: 1 },
};

const DATES = ["2026-03-01", "2026-03-02"];

function days(): GoogleHealthDay[] {
  return DATES.flatMap((date) =>
    Object.entries(VALUES).map(([dataType, values]) => ({
      dataType,
      date,
      fetchedAt: NOW,
      values,
    })),
  );
}

function syncRow(type: string, overrides: Partial<GoogleHealthSyncRow> = {}): GoogleHealthSyncRow {
  return {
    data_type: type,
    last_attempt_at: NOW - 600,
    last_ok_at: NOW - 600,
    last_error_code: null,
    backfilled_at: NOW - 86_400,
    updated_at: NOW - 600,
    ...overrides,
  };
}

function connected(overrides: Partial<GoogleHealthState> = {}): GoogleHealthState {
  return {
    googleStatus: "connected",
    scope: BOTH_SCOPES,
    sync: GH_TYPE_NAMES.map((type) => syncRow(type)),
    extents: GH_TYPE_NAMES.map((type) => ({
      dataType: type,
      days: DATES.length,
      firstDate: DATES[0] ?? "",
      lastDate: DATES.at(-1) ?? "",
    })),
    ...overrides,
  };
}

const world: { state: FakeState } = { state: fakeState() };

async function call(args: Record<string, unknown> = {}, rules: PolicyRules = EMPTY_RULES) {
  world.state.rules = rules;
  const client = await connectTools(fakeDeps(world.state));
  return callTool(client, TOOL, args);
}

/** The one coverage entry (and the warnings) of an SpO2 call over an empty store in `state`. */
async function coverageWith(
  state: GoogleHealthState,
): Promise<{ entry: Record<string, unknown>; warnings: string[] }> {
  world.state.googleHealth = { days: [], state };
  const answer = await call({ types: ["DailyOxygenSaturation"] });
  return { entry: answer.coverage?.[0] ?? {}, warnings: answer.warnings };
}

function rules(rows: PolicyRuleInput[]): PolicyRules {
  return buildRules(rows);
}

beforeEach(() => {
  world.state = fakeState({ googleHealth: { days: days(), state: connected() } });
});

describe("google_health_daily", () => {
  it("answers one row per metric per day, tagged as its own source", async () => {
    const answer = await call({ start: "2026-03-01", end: "2026-03-02" });

    expect(answer.isError).toBe(false);
    expect(answer.items).toHaveLength(DATES.length * GH_TYPE_NAMES.length);
    const first = answer.items[0];
    expect(first).toMatchObject({
      resourceType: "gh:DailyOxygenSaturation",
      healthSystemId: "google_health",
      healthSystem: "Google Health",
      date: "2026-03-01",
      averagePct: 95,
    });
    expect(answer.coverage?.every((entry) => entry.status === "ok")).toBe(true);
  });

  it("defaults to the thirty days ending on the newest stored day", async () => {
    world.state.googleHealth.days.push({
      dataType: "DailyOxygenSaturation",
      date: "2026-01-15",
      fetchedAt: NOW,
      values: { averagePct: 97 },
    });

    const answer = await call();

    expect(answer.items.map((item) => item.date)).not.toContain("2026-01-15");
    expect(answer.items).toHaveLength(DATES.length * GH_TYPE_NAMES.length);
  });

  it("reads one day, only the metrics asked for", async () => {
    const answer = await call({ date: "2026-03-02", types: ["DailyOxygenSaturation"] });

    expect(answer.items).toStrictEqual([
      expect.objectContaining({ resourceType: "gh:DailyOxygenSaturation", date: "2026-03-02" }),
    ]);
    expect(answer.coverage).toHaveLength(1);
  });

  it("reads from a start through the newest day, and runs jq and limit", async () => {
    const answer = await call({
      start: "2026-03-02",
      jq: '.[] | select(.resourceType == "gh:DailyOxygenSaturation") | {date, lowerBoundPct}',
      limit: 1,
    });

    expect(answer.items).toStrictEqual([{ date: "2026-03-02", lowerBoundPct: 89 }]);
  });

  it("refuses arguments that name no range", async () => {
    const both = await call({ date: "2026-03-01", start: "2026-03-01" });
    const endOnly = await call({ end: "2026-03-01" });
    const backwards = await call({ start: "2026-03-02", end: "2026-03-01" });

    for (const answer of [both, endOnly, backwards]) {
      expect(answer.isError).toBe(true);
      expect(answer.error).toBe("invalid_range");
    }
  });

  it("withholds a metric a resource rule names, and reads nothing for it", async () => {
    const answer = await call(
      { start: "2026-03-01", end: "2026-03-02" },
      rules([{ rule_type: "resource", target: "gh:DailyOxygenSaturation" }]),
    );

    expect(answer.items.some((item) => item.resourceType === "gh:DailyOxygenSaturation")).toBe(
      false,
    );
    expect(
      answer.coverage?.some((entry) => entry.resourceType === "gh:DailyOxygenSaturation"),
    ).toBe(false);
  });

  it("withholds the whole source under a health_system rule", async () => {
    const answer = await call({}, rules([{ rule_type: "health_system", target: "google_health" }]));

    expect(answer.items).toStrictEqual([]);
    expect(answer.coverage).toStrictEqual([]);
    expect(answer.warnings).toContain("policy_health_system_denied:google_health");
  });

  it("removes a field a field rule names", async () => {
    const answer = await call(
      { date: "2026-03-01", types: ["DailyOxygenSaturation"] },
      rules([
        {
          rule_type: "field",
          target: "spo2-low",
          effect: "hide",
          scope_resource: "gh:DailyOxygenSaturation",
          paths_json: JSON.stringify(["lowerBoundPct"]),
        },
      ]),
    );

    expect(answer.items[0]).not.toHaveProperty("lowerBoundPct");
    expect(answer.items[0]).toHaveProperty("averagePct", 95);
  });

  it("is denied outright by a tool rule", async () => {
    const answer = await call({}, rules([{ rule_type: "tool", target: TOOL }]));

    expect(answer.error).toBe("policy_denied");
  });

  it("says why there is nothing: not connected, needs reauth, not granted, failed, stale", async () => {
    const off = await coverageWith(connected({ googleStatus: "disconnected" }));
    expect(off.entry).toMatchObject({ status: "failed", errorCode: "not_connected" });

    const reauth = await coverageWith(connected({ googleStatus: "needs_reauth" }));
    expect(reauth.entry).toMatchObject({ status: "failed", errorCode: "needs_reauth" });

    const ungranted = await coverageWith(connected({ scope: GOOGLE_HEALTH_ACTIVITY_SCOPE }));
    expect(ungranted.entry).toMatchObject({ status: "never" });
    expect(ungranted.warnings).toContain("google_health_scope_not_granted:DailyOxygenSaturation");

    const never = await coverageWith(connected({ sync: [], extents: [] }));
    expect(never.entry).toMatchObject({ status: "never", recordCount: 0 });

    const firstFailed = await coverageWith(
      connected({
        sync: [
          syncRow("DailyOxygenSaturation", {
            last_ok_at: null,
            last_error_code: "google_health_not_linked",
          }),
        ],
      }),
    );
    expect(firstFailed.entry).toMatchObject({
      status: "failed",
      errorCode: "google_health_not_linked",
    });
    expect(String(firstFailed.entry.errorMeaning)).toContain("Google Health");

    const laterFailed = await coverageWith(
      connected({
        sync: [
          syncRow("DailyOxygenSaturation", {
            last_attempt_at: NOW - 60,
            last_error_code: "upstream_unavailable",
          }),
        ],
      }),
    );
    expect(laterFailed.entry).toMatchObject({
      status: "failed",
      errorCode: "upstream_unavailable",
    });
    expect(laterFailed.entry).toHaveProperty("lastOkAt");

    const stale = await coverageWith(
      connected({ sync: [syncRow("DailyOxygenSaturation", { last_ok_at: NOW - 5 * 3600 })] }),
    );
    expect(stale.entry).toMatchObject({ status: "stale", ageHours: 5 });
  });

  it("defaults to the thirty days ending today when nothing is stored", async () => {
    world.state.googleHealth = { days: [], state: connected({ extents: [] }) };

    const answer = await call();

    expect(answer.isError).toBe(false);
    expect(answer.text).toContain(`"end": "${TODAY}"`);
  });
});

describe("the field tree", () => {
  it("names every key the tool emits", async () => {
    const answer = await call({ start: "2026-03-01", end: "2026-03-02" });
    const shapes = toolShapes(TOOL) ?? [];
    const unnamed: string[] = [];
    const walk = (value: unknown, prefix: string[]): void => {
      if (Array.isArray(value)) {
        for (const entry of value as unknown[]) walk(entry, prefix);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        const path = [...prefix, key];
        if (shapes.every((shape) => !resolveInShape(shape, path).ok)) unnamed.push(path.join("."));
        walk(child, path);
      }
    };
    walk(answer.items, []);

    expect(shapes).toHaveLength(GH_TYPE_NAMES.length);
    expect(unnamed).toStrictEqual([]);
  });
});
