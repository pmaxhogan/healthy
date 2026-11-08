/**
`google_health_daily`: the owner's wearable metrics from the Google Health API.

A third kind of source beside the health systems and the paired phone: what a
Fitbit or Pixel Watch measures that Health Connect never receives (blood-oxygen
saturation above all), read hourly by `worker/src/sync/google-health-sync.ts`
into a sealed store. One row per metric per day, tagged `resourceType:
gh:<Type>` and `healthSystemId: google_health`, so the exposure policy treats
it like every other source: a `resource` rule on `gh:DailyOxygenSaturation`
withholds that metric, a `health_system` rule on `google_health` the whole
source, and a `field` rule reaches any field (each declared in
`worker/src/policy/tree.ts`). A metric or a source the policy withholds is not
read at all, and gets no coverage entry.

Like every reading tool, this reads only what the sync stored. Every row is
whole: there is no byte budget, so a long range is a long answer; `jq` and
`limit` are how a caller keeps it short.
*/

import { z } from "zod";

import {
  GH_TYPE_NAMES,
  GOOGLE_HEALTH_SOURCE_ID,
  GOOGLE_HEALTH_SOURCE_NAME,
  GOOGLE_HEALTH_TYPE_PREFIX,
  addDays,
  grantedTypes,
} from "../../google/health.ts";
import { toIso } from "../../lib/time.ts";
import { isHealthSystemDenied } from "../../policy/rules.ts";
import { explainSyncCode } from "../../sync/sync-state-codes.ts";
import { jqArg } from "../args.ts";
import { effectiveLimit } from "../collect.ts";
import { isCalendarDate } from "../hc/time.ts";
import { respond, toolError } from "../respond.ts";

import { readTool } from "./register.ts";

import type { PolicyRules } from "../../policy/rules.ts";
import type { CoverageEntry } from "../coverage.ts";
import type { GoogleHealthState, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TOOL = "google_health_daily";

/** How many days an answer covers when the caller names none. */
const DEFAULT_DAYS = 30;
/** The sync runs hourly; a metric not read in this long is `stale`. */
const STALE_AFTER_SECONDS = 3 * 3600;

/** The warning for a metric the owner's Google grant does not cover. */
const SCOPE_WARNING = "google_health_scope_not_granted";

const CALENDAR_DATE = z
  .string()
  .refine(isCalendarDate, { message: "must be a calendar date (2026-01-31)" });

const SCHEMA = z.strictObject({
  date: CALENDAR_DATE.optional().describe("One day. Not together with `start`/`end`."),
  start: CALENDAR_DATE.optional().describe("The first day of the range, inclusive."),
  end: CALENDAR_DATE.optional().describe(
    "The last day of the range, inclusive. Needs `start`. Omitted: through the newest stored day.",
  ),
  types: z
    .array(z.enum(GH_TYPE_NAMES as [string, ...string[]]))
    .min(1)
    .optional()
    .describe("Only these metrics. Omit for all of them."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Return at most this many rows, after `jq`. Omitted: every row."),
  ...jqArg(TOOL, "plain"),
});

type Args = z.output<typeof SCHEMA>;

const DESCRIPTION =
  "The owner's wearable metrics from Google Health (a Fitbit or Pixel Watch, read " +
  "hourly): what Health Connect never receives. One row per metric per day, " +
  "`resourceType` `gh:<Type>`, `healthSystemId` `google_health`, `date` the calendar " +
  "date Google gives the value. Metrics (`types`): " +
  "`DailyOxygenSaturation` (SpO2 while asleep: `averagePct`, `lowerBoundPct`, " +
  "`upperBoundPct`, `stdDevPct`); " +
  "`DailyHeartRateVariability` (`averageRmssdMs`, `deepSleepRmssdMs`, " +
  "`nonRemHeartRateBpm`, `entropy`); " +
  "`DailyVo2Max` (`vo2Max` in ml/kg/min, `vo2MaxCovariance`, `cardioFitnessLevel`, " +
  "`estimated`); " +
  "`DailySleepTemperatureDerivations` (`nightlyTempC`, `baselineTempC`, `nightlyDeltaC` " +
  "-- nightly minus baseline, what Fitbit showed as the nightly variation -- and " +
  "`relativeNightlyStddev30dC`); " +
  "`DailyHeartRateZones` (`zones`: each `zone` with its `minBpm` and `maxBpm`); " +
  "`ActiveZoneMinutes` (`fatBurnMin`, `cardioMin`, `peakMin`, `totalMin`, as the " +
  "tracker counts them); " +
  "`TimeInHeartRateZone` (`lightMin`, `moderateMin`, `vigorousMin`, `peakMin`). " +
  "A metric with no value on a day has no row that day. Pass `date` for one day or " +
  "`start` (and `end`) for a range, both inclusive; with neither, the " +
  `${String(DEFAULT_DAYS)} days ending on the newest stored day. \`coverage\` says per ` +
  "metric whether it is `ok`, `stale`, `failed` (with `errorCode` and `errorMeaning`) " +
  "or `never` read, with `recordCount` (days stored); a metric the owner's Google grant " +
  `does not cover is \`never\` and warned as \`${SCOPE_WARNING}:<Type>\`.`;

interface Range {
  from: string;
  to: string;
}

/** The days asked for, or why the arguments mean nothing. */
function rangeOf(
  args: Args,
  newest: string | null,
  today: string,
): { range: Range } | { refused: string } {
  if (args.date !== undefined) {
    return args.start === undefined && args.end === undefined
      ? { range: { from: args.date, to: args.date } }
      : { refused: "pass either `date` or `start`/`end`, not both" };
  }
  const last = newest ?? today;
  if (args.start === undefined) {
    return args.end === undefined
      ? { range: { from: addDays(last, 1 - DEFAULT_DAYS), to: last } }
      : { refused: "`end` needs `start`: pass both, or `date` for one day" };
  }
  // ISO dates compare correctly as text.
  const to = args.end ?? (last.localeCompare(args.start) > 0 ? last : args.start);
  return to >= args.start
    ? { range: { from: args.start, to } }
    : { refused: "`end` is before `start`" };
}

/** One metric's coverage entry, from the sync bookkeeping. */
function coverageOf(type: string, state: GoogleHealthState, now: number): CoverageEntry {
  const base = {
    healthSystemId: GOOGLE_HEALTH_SOURCE_ID,
    healthSystem: GOOGLE_HEALTH_SOURCE_NAME,
    resourceType: `${GOOGLE_HEALTH_TYPE_PREFIX}${type}`,
  };
  const days = state.extents.find((extent) => extent.dataType === type)?.days ?? 0;
  const failed = (errorCode: string): CoverageEntry => ({
    ...base,
    status: "failed",
    errorCode,
    errorMeaning: explainSyncCode(errorCode).meaning,
    recordCount: days,
  });
  if (state.googleStatus === "needs_reauth") return failed("needs_reauth");
  if (state.googleStatus !== "connected") return failed("not_connected");
  if (grantedTypes(state.scope).every((spec) => spec.type !== type)) {
    return { ...base, status: "never", recordCount: days };
  }
  const row = state.sync.find((entry) => entry.data_type === type);
  if (row?.last_ok_at === null || row?.last_ok_at === undefined) {
    return row?.last_error_code === null || row?.last_error_code === undefined
      ? { ...base, status: "never", recordCount: days }
      : failed(row.last_error_code);
  }
  if (row.last_error_code !== null && (row.last_attempt_at ?? 0) > row.last_ok_at) {
    return { ...failed(row.last_error_code), lastOkAt: toIso(row.last_ok_at) };
  }
  const age = now - row.last_ok_at;
  return age > STALE_AFTER_SECONDS
    ? {
        ...base,
        status: "stale",
        lastOkAt: toIso(row.last_ok_at),
        ageHours: Math.floor(age / 3600),
        recordCount: days,
      }
    : { ...base, status: "ok", lastOkAt: toIso(row.last_ok_at), recordCount: days };
}

/** The metrics this call may read: asked for, and not withheld by a `resource` rule. */
function readableTypes(args: Args, rules: PolicyRules): string[] {
  const asked = args.types ?? GH_TYPE_NAMES;
  return GH_TYPE_NAMES.filter(
    (type) => asked.includes(type) && !rules.resources.has(`${GOOGLE_HEALTH_TYPE_PREFIX}${type}`),
  );
}

export function registerGoogleHealthTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    { name: TOOL, description: DESCRIPTION, schema: SCHEMA },
    async (args, run) => {
      const healthSystemIds = [GOOGLE_HEALTH_SOURCE_ID];
      // A source the policy withholds is not read at all.
      if (isHealthSystemDenied(run.rules, GOOGLE_HEALTH_SOURCE_ID)) {
        return respond({
          tool: TOOL,
          rules: run.rules,
          items: [],
          healthSystemIds: [],
          warnings: [`policy_health_system_denied:${GOOGLE_HEALTH_SOURCE_ID}`],
          coverage: [],
          now: run.now,
        });
      }
      const types = readableTypes(args, run.rules);
      const state = await deps.googleHealth.state();
      let newest: string | null = null;
      for (const extent of state.extents) {
        if (!types.includes(extent.dataType)) continue;
        if (newest === null || extent.lastDate > newest) newest = extent.lastDate;
      }
      const asked = rangeOf(args, newest, toIso(run.now).slice(0, 10));
      if ("refused" in asked) {
        return toolError("invalid_range", { healthSystemIds, detail: asked.refused });
      }
      const { from, to } = asked.range;
      const order = new Map(GH_TYPE_NAMES.map((type, index) => [type, index]));
      const stored = await deps.googleHealth.days(types, from, to);
      stored.sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          (order.get(left.dataType) ?? 0) - (order.get(right.dataType) ?? 0),
      );
      const items = stored.map((day) => ({
        ...day.values,
        resourceType: `${GOOGLE_HEALTH_TYPE_PREFIX}${day.dataType}`,
        healthSystemId: GOOGLE_HEALTH_SOURCE_ID,
        healthSystem: GOOGLE_HEALTH_SOURCE_NAME,
        date: day.date,
      }));
      const granted = new Set(grantedTypes(state.scope).map((spec) => spec.type));
      const ungranted =
        state.googleStatus === "connected" ? types.filter((type) => !granted.has(type)) : [];
      return respond({
        tool: TOOL,
        rules: run.rules,
        items,
        limit: effectiveLimit(args.limit),
        jq: args.jq,
        healthSystemIds,
        warnings: ungranted.map((type) => `${SCOPE_WARNING}:${type}`),
        coverage: types.map((type) => coverageOf(type, state, run.now)),
        extra: { range: { start: from, end: to } },
        now: run.now,
      });
    },
  );
}
