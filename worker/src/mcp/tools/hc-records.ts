/**
 * `hc_records` and `hc_aggregate`: the two general doors onto phone data.
 *
 * `hc_records` is the raw one -- every stored record of one type with anything
 * in the range, as the phone serialised it. It opens only the hour chunks the
 * range touches, and a continued call (a `cursor`) opens only the hours from
 * the cursor on.
 *
 * `hc_aggregate` is the one to reach for first: calendar buckets in a named
 * zone, answered from the day and hour rollups wherever a bucket allows
 * (`../hc/parts.ts`), with duplicates between apps handled out loud
 * (`../hc/aggregate.ts`).
 *
 * Both take the record type from the caller, so both check it against the
 * exposure policy before reading (`typeAllowed`). A platform aggregate
 * (`Agg.Steps`) is checked as the type it is data of, and its rows are tagged
 * as that type: see `../hc/policy.ts`.
 *
 * Paging `hc_records`. Its rows are in a total order (start, phone, id), so a
 * continuation can resume by time instead of re-reading the range: the cursor
 * names the start of the next row, how many rows at that same instant have
 * gone out, and how many went out before them. Three things keep a paged read
 * identical to a single one:
 *
 *  - the continuation reads the ORIGINAL range, narrowed at one end only: a
 *    record that ended before the range began is not in it on any page;
 *  - the cursor is built from the rows actually sent (after the policy), and
 *    falls back to a plain offset when a rule has hidden the times it would
 *    anchor on;
 *  - `total` and `matched` count the whole answer on every page.
 */

import { z } from "zod";

import { recordEndMs, recordStartMs } from "../../hc/wire.ts";
import {
  METRICS,
  TYPE_BMR,
  TYPE_TOTAL_CALORIES,
  aggregate,
  defaultMetrics,
  parseOriginMode,
} from "../hc/aggregate.ts";
import { AVAILABILITY_NOTE, BUDGET_NOTE, hcArgs, rangeArgs } from "../hc/args.ts";
import { openStampedPage, writeCursor } from "../hc/page.ts";
import { fieldHidden, typeAllowed, typeDeniedWarning } from "../hc/policy.ts";
import { recordItem } from "../hc/records.ts";
import {
  beginHcCall,
  dayRollupsUsable,
  deviceCoverageFor,
  deviceSourceId,
  hcRespond,
  rowTags,
  storeState,
} from "../hc/sources.ts";
import { parseRange } from "../hc/time.ts";
import { unitsFor } from "../hc/units.ts";
import { sortedText } from "../hc/util.ts";
import { toolError } from "../respond.ts";

import { readTool } from "./register.ts";

import type { CalendarBucket } from "../../hc/rollup/day.ts";
import type { HcRecord } from "../../hc/wire.ts";
import type { ToolDeps } from "../deps.ts";
import type { Metric, OriginMode } from "../hc/aggregate.ts";
import type { StampedPage } from "../hc/page.ts";
import type { HcDevice } from "../hc/reads.ts";
import type { HcCall } from "../hc/sources.ts";
import type { Range } from "../hc/time.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A record type as the wire contract spells one (`RECORD_TYPE_PATTERN` in
 * `worker/src/hc/wire.ts`): what the phone may send is what a caller may ask for.
 */
const RECORD_TYPE = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u)
  .describe(
    "Health Connect record type, as `hc_coverage` lists it: `Steps`, `HeartRate`, " +
      "`SleepSession`, `Weight`, `BloodPressure`, ... (the SDK class name without `Record`).",
  );

const NAME = z.string().min(1);

const RECORD_ORIGINS = z
  .array(NAME)
  .max(50)
  .optional()
  .describe("Only records written by these apps (package names). Omit for every app.");

const RECORD_FIELDS = z
  .array(NAME)
  .max(100)
  .optional()
  .describe('Only these keys of `data` (e.g. `["systolic", "diastolic"]`). Omit for all.');

const RECORD_ORDER = z.enum(["asc", "desc"]).optional().describe("By start time. Default `asc`.");

const INCLUDE_METADATA = z
  .boolean()
  .optional()
  .describe(
    "Also return each record's `device` (type, manufacturer, model), " +
      "`recordingMethod`, `lastModified`, zone offsets and client ids. Default false.",
  );

const RECORDS_SCHEMA = hcArgs("hc_records", {
  type: RECORD_TYPE,
  ...rangeArgs("a record is returned when any part of it falls in the range"),
  origins: RECORD_ORIGINS,
  fields: RECORD_FIELDS,
  order: RECORD_ORDER,
  include_metadata: INCLUDE_METADATA,
});

const METRIC = z.enum(METRICS);

const METRICS_ARG = z
  .array(METRIC)
  .min(1)
  .optional()
  .describe(
    "What to compute per bucket. Default: `sum` for types that add up (steps, " +
      "distance, energy), `duration` and `records` for sleep and exercise sessions, " +
      "`mean`, `min`, `max`, `n` for measurements.",
  );

/** The longest `<N>min` bucket: a day. Anything wider is `day`, `week`, `month` or `year`. */
const MAX_BUCKET_MINUTES = 24 * 60;

const BUCKET_PATTERN = /^(?:hour|day|week|month|year|([1-9]\d{0,3})min)$/u;

/** True for a calendar unit, or `<N>min` with N from 1 to a day's minutes. */
function isBucket(value: string): boolean {
  const match = BUCKET_PATTERN.exec(value);
  const minutes = match?.[1];
  return match !== null && (minutes === undefined || Number(minutes) <= MAX_BUCKET_MINUTES);
}

const BUCKET_ARG = z
  .string()
  .refine(isBucket, {
    message: `must be hour, day, week, month, year, or <N>min with N from 1 to ${String(MAX_BUCKET_MINUTES)}`,
  })
  .optional()
  .describe(
    "`hour`, `day`, `week`, `month`, `year`, or `<N>min` (`15min`; at most " +
      `\`${String(MAX_BUCKET_MINUTES)}min\`). Default \`day\`.`,
  );

const ORIGIN_MODE_ARG = z
  .string()
  .refine((value) => parseOriginMode(value) !== null, {
    message: "must be hc_priority, all_separately or origin:<package>",
  })
  .optional()
  .describe("`hc_priority` (default), `origin:<package>`, or `all_separately`.");

const EXCLUDE_ARTEFACTS_ARG = z
  .boolean()
  .optional()
  .describe(
    "Leave measurement artefacts out of the numbers (default true): heart-rate samples " +
      "above 200 or below 20 bpm, speed samples above 15 m/s, and a weight typed into a " +
      "profile screen beside a height. Each row says how many values that removed " +
      "(`artefactsExcluded`). Pass false to aggregate every stored value.",
  );

const FILL_ARG = z
  .enum(["zero", "null"])
  .optional()
  .describe(
    "What an empty bucket's numbers are. `zero` (default) fills counts and sums " +
      "with 0; means and extremes of nothing are null either way.",
  );

const BMR_FILL_ARG = z
  .boolean()
  .optional()
  .describe(
    "`TotalCaloriesBurned` only: pad each bucket's unrecorded time with the newest " +
      "basal metabolic rate. Default false.",
  );

const EXCLUDE_FUTURE_ARG = z
  .boolean()
  .optional()
  .describe("Stop at now: no future bucket, no record dated after now. Default true.");

const AGGREGATE_SCHEMA = hcArgs("hc_aggregate", {
  type: RECORD_TYPE,
  ...rangeArgs("a record counts when its start falls in the range"),
  metrics: METRICS_ARG,
  bucket: BUCKET_ARG,
  origin_mode: ORIGIN_MODE_ARG,
  fill: FILL_ARG,
  bmr_fill: BMR_FILL_ARG,
  exclude_artefacts: EXCLUDE_ARTEFACTS_ARG,
  exclude_future: EXCLUDE_FUTURE_ARG,
});

interface Sourced {
  startMs: number;
  device: HcDevice;
  record: HcRecord;
}

/** By start, then phone, then id: a total order, so paging is stable. */
function ascending(left: Sourced, right: Sourced): number {
  if (left.startMs !== right.startMs) return left.startMs - right.startMs;
  if (left.device.id !== right.device.id) return left.device.id < right.device.id ? -1 : 1;
  if (left.record.id === right.record.id) return 0;
  return left.record.id < right.record.id ? -1 : 1;
}

function descending(left: Sourced, right: Sourced): number {
  return -ascending(left, right);
}

interface RecordsQuery {
  type: string;
  range: Range;
  origins: readonly string[] | undefined;
  descending: boolean;
  /** The cursor's resume point, or null to read the whole range. */
  anchorMs: number | null;
}

/**
 * True when a record has anything in the range: the store reader's own rule,
 * repeated here because a continuation asks the reader for a narrower window
 * and must still judge each record by the ORIGINAL one.
 */
function inRange(record: HcRecord, range: Range): boolean {
  const start = recordStartMs(record);
  return start < range.endMs && Math.max(recordEndMs(record), start + 1) > range.startMs;
}

/** Every record of the query, across the call's phones, in the order asked for. */
async function readRows(deps: ToolDeps, call: HcCall, query: RecordsQuery): Promise<Sourced[]> {
  const { anchorMs, range } = query;
  // A continued call reads from the cursor on -- forwards from it, or back from
  // it -- but never beyond the range itself: a row that spilled into the range
  // from before it can be the anchor, and reading from ITS start would let in
  // records that ended before the range began.
  const forwards = anchorMs !== null && !query.descending;
  const backwards = anchorMs !== null && query.descending;
  const startMs = forwards ? Math.max(anchorMs, range.startMs) : range.startMs;
  // Backwards, the window still has to reach into the range: a row that began
  // before the range is found by the part of it inside the range.
  const endMs = backwards
    ? Math.min(Math.max(anchorMs, range.startMs) + 1, range.endMs)
    : range.endMs;
  const rows: Sourced[] = [];
  for (const device of call.devices) {
    const records = await deps.hc.records({
      deviceId: device.id,
      type: query.type,
      startMs,
      endMs,
      origins: query.origins,
    });
    for (const record of records) {
      const at = recordStartMs(record);
      // Everything on the far side of the cursor went out in an earlier page.
      const sent = (forwards && at < anchorMs) || (backwards && at > anchorMs);
      if (!sent && inRange(record, range)) rows.push({ startMs: at, device, record });
    }
  }
  rows.sort(query.descending ? descending : ascending);
  return rows;
}

/** The instant a sent row starts at, read off the row itself; null when a rule has hidden it. */
function sentInstant(row: unknown): number | null {
  if (typeof row !== "object" || row === null) return null;
  const { start, time } = row as { start?: unknown; time?: unknown };
  const text = typeof start === "string" ? start : time;
  const ms = typeof text === "string" ? Date.parse(text) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The cursor for "continue at row `next`" of the rows that were sent: that
 * row's start, the rows at the same instant already sent, and the rows before
 * those. When the row's time cannot be read back (a field rule hides it), a
 * plain offset into the whole answer instead, which re-reads the range.
 */
function resumeCursor(page: StampedPage, sent: readonly unknown[], next: number): string {
  const absolute = page.before + next;
  const anchorMs = sentInstant(sent.at(next));
  if (anchorMs === null) return writeCursor(page.digest, absolute);
  let ties = 0;
  for (let index = next - 1; index >= 0 && sentInstant(sent.at(index)) === anchorMs; index -= 1) {
    ties += 1;
  }
  return writeCursor(page.digest, { offset: ties, anchorMs, before: absolute - ties });
}

/** The newest BasalMetabolicRate value a phone holds, kcal/day; null when it has none. */
async function latestBmr(deps: ToolDeps, deviceId: string): Promise<number | null> {
  const rows = await deps.hc.syncRows(deviceId);
  const lastMs = rows.find((row) => row.recordType === TYPE_BMR)?.lastMs ?? null;
  if (lastMs === null) return null;
  const records = await deps.hc.records({
    deviceId,
    type: TYPE_BMR,
    startMs: lastMs,
    endMs: lastMs + 1,
  });
  let value: number | null = null;
  for (const record of records) {
    const { bmr } = record.data;
    if (typeof bmr === "number" && Number.isFinite(bmr)) value = bmr;
  }
  return value;
}

interface AggregateQuery {
  type: string;
  range: Range;
  bucket: CalendarBucket;
  mode: OriginMode;
  metrics: readonly Metric[];
  fill: "zero" | "null";
  excludeFuture: boolean;
  /** `bmr_fill` was asked for, applies to this type, and the policy allows the BMR read. */
  bmrFill: boolean;
  excludeArtefacts: boolean;
}

interface AggregateAnswer {
  items: unknown[];
  warnings: string[];
  answeredFrom: Set<string>;
  duplicatesDropped: number;
  artefactsExcluded: number;
  /** Stable codes of artefact rules that could not run: their context type is withheld. */
  rulesNotApplied: Set<string>;
  bucketing: string;
  usedFallback: boolean;
}

/** Aggregate one phone into `answer`. */
async function aggregateDevice(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  query: AggregateQuery,
  answer: AggregateAnswer,
): Promise<void> {
  const source = deviceSourceId(device.id);
  const store = await storeState(deps, device);
  answer.warnings.push(...store.warnings);
  const bmr = query.bmrFill ? await latestBmr(deps, device.id) : null;
  if (bmr === null && query.bmrFill) answer.warnings.push(`bmr_fill_unavailable:${source}`);
  const result = await aggregate(deps.hc, {
    deviceId: device.id,
    type: query.type,
    range: query.range,
    bucket: query.bucket,
    mode: query.mode,
    metrics: query.metrics,
    fill: query.fill,
    excludeFuture: query.excludeFuture,
    nowMs: call.nowMs,
    clock: call.clock,
    dayRollupsUsable: await dayRollupsUsable(deps, call, device, {
      state: store,
      type: query.type,
      range: query.range,
    }),
    bmrKcalPerDay: bmr,
    excludeArtefacts: query.excludeArtefacts,
    // What a rule may read as context is the policy's to say, never the caller's.
    allowed: (type) => typeAllowed(call.rules, type),
  });
  for (const level of result.sources) answer.answeredFrom.add(level);
  answer.duplicatesDropped += result.duplicatesDropped;
  answer.artefactsExcluded += result.artefactsExcluded;
  for (const code of result.rulesNotApplied) answer.rulesNotApplied.add(code);
  answer.bucketing = result.bucketing;
  answer.usedFallback ||= result.usedFallback;
  const tags = rowTags(device, query.type);
  for (const row of result.rows) answer.items.push({ ...tags, ...row });
}

/**
 * The warnings `bmr_fill` earns before anything is read, and whether it
 * applies at all. The padding is folded into the bucket's total, where no
 * rule could pick it back out, so it is not computed at all when the policy
 * denies the basal-metabolic-rate type or hides its one field.
 */
function bmrFillPlan(
  call: HcCall,
  type: string,
  asked: boolean,
): { apply: boolean; warnings: string[] } {
  if (!asked) return { apply: false, warnings: [] };
  if (type !== TYPE_TOTAL_CALORIES) return { apply: false, warnings: ["bmr_fill_ignored"] };
  if (!typeAllowed(call.rules, TYPE_BMR)) {
    return { apply: false, warnings: [typeDeniedWarning(TYPE_BMR)] };
  }
  return fieldHidden(call.rules, "hc_aggregate", TYPE_BMR, "bmr")
    ? { apply: false, warnings: [`policy_field_removed:hc:${TYPE_BMR}.bmr`] }
    : { apply: true, warnings: [] };
}

export function registerHcRecordTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "hc_records",
      description:
        "Raw Health Connect records of one type with anything in `[start, end)`, exactly " +
        "as the phone stored them: `id`, `origin` (the app that wrote it), `time` (or " +
        "`start` and `end`) as ISO-8601 with offset, and `data` with the type's own " +
        "fields as numbers -- nested lists too (`samples`, `stages`, `segments`, `laps`, " +
        "`route`, `deltas`), their times converted the same way. Nothing is deduplicated " +
        "or dropped here; `blood_pressure`, `sleep_sessions` and `data_quality` apply the " +
        "rules. Prefer `hc_aggregate` or `hr_series` for anything over a few hours of a " +
        "dense type: a day of raw heart rate is tens of thousands of samples. An exercise " +
        "session's `route` can be megabytes on its own: leave it out with `fields`, or " +
        "project with a `jq` program that starts `.[] |`, which works however large the " +
        "records are. Ordered by " +
        "start time. Without `jq`, a `cursor` resumes reading where the last page ended " +
        "instead of re-reading the range; `total` counts the whole answer on every page. " +
        `${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: RECORDS_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "hc_records", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const range = parseRange({
        start: args.start,
        end: args.end,
        timeZone: call.clock.timeZone,
        nowMs: call.nowMs,
      });
      if (range.endMs < range.startMs) return toolError("invalid_range");
      const coverage = await deviceCoverageFor(deps, call, { named: [args.type] });
      const allowed = typeAllowed(call.rules, args.type);
      const rows = allowed
        ? await readRows(deps, call, {
            type: args.type,
            range,
            origins: args.origins,
            descending: args.order === "desc",
            anchorMs: page.anchorMs,
          })
        : [];
      const options = { fields: args.fields, metadata: args.include_metadata === true };
      const items = rows.map((row) => ({
        ...rowTags(row.device, args.type),
        ...recordItem(row.record, call.clock, options),
      }));
      // This is the one tool whose continuation hands over part of the
      // answer: `hcRespond` counts the rest from the page's `before`.
      return hcRespond({
        tool: "hc_records",
        call,
        args,
        page,
        items,
        coverage,
        named: [args.type],
        warnings: allowed ? [] : [typeDeniedWarning(args.type)],
        extra: { units: unitsFor(args.type), order: args.order ?? "asc" },
        // A `jq` program's output rows are not the records, so only an
        // unprojected answer can be resumed by time.
        cursorFor: (next, sent) =>
          args.jq === undefined
            ? resumeCursor(page, sent, next)
            : writeCursor(page.digest, page.before + next),
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "hc_aggregate",
      description:
        "One record type summed or summarised into calendar buckets: `hour`, `day`, " +
        "`week` (Monday first), `month`, `year` or `<N>min`, cut in the zone of `tz` (so a " +
        "day is a local day, 23 or 25 hours across a clock change). One row per bucket: " +
        "`bucket`, `start`, `end`, `hasData`, `origins`, `method`, and `values.<field>` " +
        "with the `metrics` asked for (`sum`, `mean`, `min`, `max`, `n`, `first`, `last`; " +
        "plus row-level `records` and `duration`). Empty buckets are still returned, " +
        'filled with zero (or null with `fill: "null"`) and `hasData: false`, so a gap is ' +
        "visible. A record counts in the bucket its start falls in; a night of sleep is " +
        "the exception and counts in the bucket it ENDED in, the day you woke up, which is " +
        "the date `sleep_sessions` and `daily_summary` give it (`bucketing` says which: " +
        "`start_time` or `end_time`). " +
        "`origin_mode` decides whose numbers count when several apps record the same " +
        "thing: `hc_priority` (default) uses Health Connect's own priority-merged hourly " +
        'aggregate where the phone uploaded one (row `method: "platform"`), and otherwise ' +
        "falls back by what the type is. A sensor's running count (steps, distance, " +
        "energy, floors) is decided hour by hour: in each UTC hour the one app with the " +
        "largest total is taken and the hours are summed (`max_origin`), so a month is " +
        "the sum of its days and of its hours, and only another app's records in an hour " +
        "the chosen app also recorded count in `duplicatesDropped`. Sleep and exercise are " +
        "answered from the stored sessions, overlapping copies of one session counted " +
        "once and different sessions each counted (`merged_sessions`); for exercise " +
        "`duration` comes from the platform where it has it, `records` always from the " +
        "stored sessions. Everything else -- a measurement, or an entry someone logs " +
        "such as a drink or a meal -- is every app merged (`all_origins`). A bucket the " +
        "platform covers only part of is composed hour by hour (`platform_and_max_origin`, " +
        "`platform_and_all_origins`). Artefacts are left out unless `exclude_artefacts` is " +
        "false, counted per row (`artefactsExcluded`) and in `hc_artefacts_excluded:<n>`; " +
        "the weight rule needs heights, and when the owner's policy withholds them it is " +
        "not applied and the answer warns `weight_artefact_rule_not_applied`. " +
        "`origin:<package>` takes one " +
        "app; `all_separately` returns a row per app. Nothing after now is counted unless " +
        "`exclude_future` is false, and a bucket the range or now cuts short says " +
        "`partial`. Total calories are what was recorded: no basal-metabolic padding " +
        "unless `bmr_fill` is true, and then it is shown per row as `bmrFillKcal`. " +
        `${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: AGGREGATE_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "hc_aggregate", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { type } = args;
      const range = parseRange({
        start: args.start,
        end: args.end,
        timeZone: call.clock.timeZone,
        nowMs: call.nowMs,
      });
      if (range.endMs < range.startMs) return toolError("invalid_range");
      const coverage = await deviceCoverageFor(deps, call, { named: [type] });
      const allowed = typeAllowed(call.rules, type);
      const fillPlan = bmrFillPlan(call, type, args.bmr_fill === true);
      const metrics = args.metrics ?? defaultMetrics(type);
      const query: AggregateQuery = {
        type,
        range,
        bucket: (args.bucket ?? "day") as CalendarBucket,
        mode: parseOriginMode(args.origin_mode ?? "hc_priority") ?? { kind: "hc_priority" },
        metrics,
        fill: args.fill ?? "zero",
        excludeFuture: args.exclude_future ?? true,
        bmrFill: fillPlan.apply,
        excludeArtefacts: args.exclude_artefacts !== false,
      };
      const answer: AggregateAnswer = {
        items: [],
        warnings: allowed ? fillPlan.warnings : [typeDeniedWarning(type)],
        answeredFrom: new Set(),
        duplicatesDropped: 0,
        artefactsExcluded: 0,
        rulesNotApplied: new Set(),
        bucketing: type === "SleepSession" ? "end_time" : "start_time",
        usedFallback: false,
      };
      const devices = allowed ? call.devices : [];
      for (const device of devices) await aggregateDevice(deps, call, device, query, answer);
      if (answer.duplicatesDropped > 0) {
        answer.warnings.push(`hc_duplicates_dropped:${String(answer.duplicatesDropped)}`);
      }
      if (answer.usedFallback) answer.warnings.push("hc_priority_fallback");
      if (answer.artefactsExcluded > 0) {
        answer.warnings.push(`hc_artefacts_excluded:${String(answer.artefactsExcluded)}`);
      }
      answer.warnings.push(...answer.rulesNotApplied);

      return hcRespond({
        tool: "hc_aggregate",
        call,
        args,
        page: opened.page,
        items: answer.items,
        coverage,
        warnings: answer.warnings,
        extra: {
          units: { ...unitsFor(type), durationMs: "ms", bmrFillKcal: "kcal" },
          bucket: query.bucket,
          bucketing: answer.bucketing,
          originMode: args.origin_mode ?? "hc_priority",
          metrics,
          answeredFrom: sortedText(answer.answeredFrom),
        },
      });
    },
  );
}
