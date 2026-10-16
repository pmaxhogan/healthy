/**
`hr_series`, `hr_events` and `blood_pressure`.

The two heart-rate tools answer from the per-minute rows (`../hc/heart.ts`)
and open raw chunks only for a sub-minute resolution or to take an
implausible reading out of a minute. `blood_pressure` reads the readings
themselves -- there are a handful a day -- and applies the duplicate and
sitting rules of `worker/src/hc/rules.ts` when it answers, never before.

Two of them put a value on a row that was measured as another record type
-- an event's `context` comes from sleep and exercise sessions, a reading's
`pulse` from heart rate -- so every row goes out through `stripJoined`
(`../hc/policy.ts`), and the other type is not read at all when the policy
denies it.
*/

import { z } from "zod";

import { HR_RESOLUTION_MS, detectHrEvents } from "../../hc/rollup/hr.ts";
import {
  BP_SESSION_WINDOW_MIN,
  dedupeBloodPressure,
  groupBloodPressureSessions,
} from "../../hc/rules.ts";
import { recordStartMs } from "../../hc/wire.ts";
import { AVAILABILITY_NOTE, BUDGET_NOTE, RANGE_NOTE, hcArgs, rangeArgs } from "../hc/args.ts";
import {
  TYPE_HEART_RATE,
  readMinutes,
  readSamples,
  resampleMinutes,
  resampleSamples,
} from "../hc/heart.ts";
import { openStampedPage } from "../hc/page.ts";
import { deniedJoins, stripJoined } from "../hc/policy.ts";
import {
  beginHcCall,
  deviceCoverageFor,
  hcRespond,
  rowTags,
  typeAllowed,
  typeDeniedWarning,
} from "../hc/sources.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS, parseRange } from "../hc/time.ts";
import { distinctText, finite, meanOf } from "../hc/util.ts";
import { toolError } from "../respond.ts";

import { readTool } from "./register.ts";

import type { HrEventOptions, HrPoint, HrResolution } from "../../hc/rollup/hr.ts";
import type { HcRecord } from "../../hc/wire.ts";
import type { ToolDeps } from "../deps.ts";
import type { Resampled } from "../hc/heart.ts";
import type { HcDevice } from "../hc/reads.ts";
import type { HcCall } from "../hc/sources.ts";
import type { Range, ZoneClock } from "../hc/time.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TYPE_BLOOD_PRESSURE = "BloodPressure";
const TYPE_SLEEP = "SleepSession";
const TYPE_EXERCISE = "ExerciseSession";

const RESOLUTIONS = ["raw", "5s", "1min", "5min", "1h"] as const;
const STATS = ["mean", "min", "max", "n"] as const;
type Stat = (typeof STATS)[number];

const DEFAULT_RESOLUTION = "1min";
/** Points per series before `hr_series` makes the series coarser. The caller can raise it. */
const DEFAULT_MAX_POINTS = 2000;

/**
`hr_events` defaults: a rise of thirty beats a minute over the baseline of
the ten minutes before it, held for a minute. Standing up from rest is
commonly ten to twenty; thirty is the rise that is worth a look whatever
caused it. A slow climb never opens an event under these: at two beats a
minute the baseline of a ten-minute window climbs with it.
*/
const DEFAULT_MIN_DELTA_BPM = 30;
const DEFAULT_WINDOW_S = 600;
const DEFAULT_SUSTAIN_S = 60;

/** An event that starts this close to the end of a sleep session is the waking itself. */
const WAKE_PROXIMITY_MS = 15 * MINUTE_MS;

const NAME = z.string().min(1);

const ORIGINS_ARG = z
  .array(NAME)
  .max(20)
  .optional()
  .describe(
    "Apps (package names) whose heart rate to use, each as its own series. Omit for the " +
      "one app with the most samples in the range.",
  );

const RESOLUTION_ARG = z
  .enum(RESOLUTIONS)
  .optional()
  .describe(`\`raw\`, \`5s\`, \`1min\`, \`5min\` or \`1h\`. Default \`${DEFAULT_RESOLUTION}\`.`);

const STAT = z.enum(STATS);

const STATS_ARG = z
  .array(STAT)
  .min(1)
  .optional()
  .describe("Which of `mean`, `min`, `max`, `n` each point carries. Default all four.");

const MAX_POINTS_ARG = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    `Points per series before it is made coarser (default ${String(DEFAULT_MAX_POINTS)}). No maximum.`,
  );

const SERIES_SCHEMA = hcArgs("hr_series", {
  ...rangeArgs("heart-rate samples timed in the range"),
  resolution: RESOLUTION_ARG,
  stats: STATS_ARG,
  max_points: MAX_POINTS_ARG,
  origins: ORIGINS_ARG,
});

const MIN_DELTA_ARG = z
  .number()
  .positive()
  .optional()
  .describe(`Rise over baseline that opens an event (default ${String(DEFAULT_MIN_DELTA_BPM)}).`);

const WINDOW_ARG = z
  .number()
  .int()
  .min(180)
  .optional()
  .describe(
    `Seconds before a minute its baseline is taken from (default ${String(DEFAULT_WINDOW_S)}; at least 180).`,
  );

const SUSTAIN_ARG = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(`Shortest event reported, seconds (default ${String(DEFAULT_SUSTAIN_S)}).`);

const EVENTS_SCHEMA = hcArgs("hr_events", {
  ...rangeArgs("events that start in the range"),
  min_delta_bpm: MIN_DELTA_ARG,
  window_s: WINDOW_ARG,
  sustain_s: SUSTAIN_ARG,
  origins: ORIGINS_ARG,
});

const DEDUPE_ARG = z
  .boolean()
  .optional()
  .describe("Count a duplicated reading once. Default true.");

const GROUP_ARG = z
  .boolean()
  .optional()
  .describe("Group readings into sittings with their means. Default true.");

const WINDOW_MIN_ARG = z
  .number()
  .positive()
  .optional()
  .describe(
    `Longest gap, in minutes, between two readings of one sitting (default ${String(BP_SESSION_WINDOW_MIN)}).`,
  );

const PRESSURE_SCHEMA = hcArgs("blood_pressure", {
  ...rangeArgs("readings taken in the range"),
  dedupe: DEDUPE_ARG,
  group_sessions: GROUP_ARG,
  window_min: WINDOW_MIN_ARG,
});

function pointItem(point: HrPoint, stats: readonly Stat[], clock: ZoneClock) {
  return {
    t: clock.iso(point.t),
    ...(stats.includes("mean") && { mean: point.bpm }),
    ...(stats.includes("min") && { min: point.min }),
    ...(stats.includes("max") && { max: point.max }),
    ...(stats.includes("n") && { n: point.n }),
  };
}

/** How one series of an `hr_series` answer was resampled. Names no app: see the handler. */
interface SeriesShape {
  bucketMs: number | null;
  decimated: boolean;
  decimation: number;
  totalPoints: number;
  points: number;
}

/** The value every series shares, or null when they differ (or there are none). */
function shared<Value>(values: readonly Value[]): Value | null {
  const [first] = values;
  return first !== undefined && values.every((value) => value === first) ? first : null;
}

/** Runs of consecutive UTC hours holding the given instants, as windows. */
function hourWindows(times: readonly number[]): Range[] {
  const hours = [...new Set(times.map((time) => Math.floor(time / HOUR_MS)))];
  hours.sort((left, right) => left - right);
  const runs: Range[] = [];
  for (const hour of hours) {
    const last = runs.at(-1);
    if (last?.endMs === hour * HOUR_MS) last.endMs += HOUR_MS;
    else runs.push({ startMs: hour * HOUR_MS, endMs: (hour + 1) * HOUR_MS });
  }
  return runs;
}

interface SeriesQuery {
  range: Range;
  resolution: HrResolution;
  maxPoints: number;
  origins: readonly string[] | undefined;
}

interface SeriesRead {
  series: { origin: string; result: Resampled }[];
  artefactsDropped: number;
  otherOrigins: number;
}

/** One phone's heart rate at the resolution asked for, from the cheapest level that has it. */
async function readSeries(
  deps: ToolDeps,
  deviceId: string,
  query: SeriesQuery,
): Promise<SeriesRead> {
  const { range, resolution, maxPoints, origins } = query;
  if (resolution === "raw" || resolution === "5s") {
    const read = await readSamples(deps.hc, deviceId, range, origins);
    return {
      ...read,
      series: read.series.map((series) => ({
        origin: series.origin,
        result: resampleSamples(series.points, resolution, maxPoints),
      })),
    };
  }
  const widthMs = HR_RESOLUTION_MS[resolution];
  const read = await readMinutes(deps.hc, deviceId, range, origins);
  return {
    ...read,
    series: read.series.map((series) => ({
      origin: series.origin,
      result: resampleMinutes(series.points, widthMs, maxPoints),
    })),
  };
}

interface Span {
  startMs: number;
  endMs: number;
}

/** Where an event falls: in a workout, at a waking, asleep, or none of those. */
function contextOf(
  event: Span,
  sleeps: readonly Span[],
  exercises: readonly Span[],
): "exercise" | "wake" | "sleep" | "other" {
  const overlaps = (span: Span): boolean =>
    event.startMs < span.endMs && span.startMs < event.endMs;
  if (exercises.some((span) => overlaps(span))) return "exercise";
  if (sleeps.some((span) => Math.abs(event.startMs - span.endMs) <= WAKE_PROXIMITY_MS)) {
    return "wake";
  }
  return sleeps.some((span) => overlaps(span)) ? "sleep" : "other";
}

/** The sleep and exercise spans around a range. Read only when the policy allows both. */
async function sessionSpans(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  range: Range,
): Promise<{ sleeps: Span[]; exercises: Span[] }> {
  // `context` needs both types to mean anything, and `stripJoined` removes it
  // when either is denied -- so neither is read unless both are allowed.
  if (!typeAllowed(call.rules, TYPE_SLEEP) || !typeAllowed(call.rules, TYPE_EXERCISE)) {
    return { sleeps: [], exercises: [] };
  }
  const window = {
    deviceId: device.id,
    startMs: range.startMs - WAKE_PROXIMITY_MS,
    endMs: range.endMs,
  };
  const nights = await deps.hc.sleepNights(window);
  const sessions = await deps.hc.exerciseSessions(window);
  return {
    sleeps: nights.map(({ night }) => night),
    exercises: sessions.map(({ session }) => session),
  };
}

/** One phone's events in the range, as rows. */
async function eventRows(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  query: { range: Range; options: HrEventOptions; origins: readonly string[] | undefined },
): Promise<{ rows: Record<string, unknown>[]; artefactsDropped: number }> {
  const { range, options } = query;
  const { clock } = call;
  // The first minute of the range needs the minutes before it for a baseline.
  const read = await readMinutes(
    deps.hc,
    device.id,
    { startMs: range.startMs - options.windowS * SECOND_MS, endMs: range.endMs },
    query.origins,
  );
  const spans = await sessionSpans(deps, call, device, range);
  const tags = rowTags(device, TYPE_HEART_RATE);
  const rows: Record<string, unknown>[] = [];
  for (const series of read.series) {
    const events = detectHrEvents(series.points, options);
    for (const event of events) {
      if (event.startMs < range.startMs || event.startMs >= range.endMs) continue;
      rows.push(
        stripJoined(call.rules, "hr_events", {
          ...tags,
          origin: series.origin,
          start: clock.iso(event.startMs),
          end: clock.iso(event.endMs),
          peakAt: clock.iso(event.peakMs),
          baselineBpm: event.baselineBpm,
          peakBpm: event.peakBpm,
          deltaBpm: event.deltaBpm,
          timeToPeakS: event.timeToPeakS,
          durationS: event.durationS,
          context: contextOf(event, spans.sleeps, spans.exercises),
        }),
      );
    }
  }
  return { rows, artefactsDropped: read.artefactsDropped };
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
The pulse a cuff took with a reading: the same app's heart rate in the same
minute. Empty, and nothing read, when the policy denies heart rate.
*/
async function pulses(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  readings: readonly HcRecord[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (readings.length === 0 || !typeAllowed(call.rules, TYPE_HEART_RATE)) return out;
  const origins = distinctText(readings.map((reading) => reading.origin));
  const byMinute = new Map<string, number>();
  // Only the hours a reading falls in: a year of readings is a few hundred
  // hours of minute rows, not every hour between the first and the last.
  const windows = hourWindows(readings.map((reading) => recordStartMs(reading)));
  for (const window of windows) {
    const rows = await deps.hc.hrMinutes({ deviceId: device.id, ...window, origins });
    for (const row of rows) {
      for (const minute of row.minutes) {
        const at = row.hourUtc * HOUR_MS + minute.m * MINUTE_MS;
        byMinute.set(`${row.origin}|${String(at)}`, minute.mean);
      }
    }
  }
  for (const reading of readings) {
    const minute = Math.floor(recordStartMs(reading) / MINUTE_MS) * MINUTE_MS;
    const pulse = byMinute.get(`${reading.origin}|${String(minute)}`);
    if (pulse !== undefined) out.set(reading.id, Math.round(pulse));
  }
  return out;
}

interface PressureQuery {
  range: Range;
  dedupe: boolean;
  group: boolean;
  windowMin: number | undefined;
}

/** One phone's readings in the range, as sitting or reading rows. */
async function pressureRows(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  query: PressureQuery,
): Promise<{ rows: Record<string, unknown>[]; duplicates: number }> {
  const { range } = query;
  const { clock } = call;
  const stored = await deps.hc.records({
    deviceId: device.id,
    type: TYPE_BLOOD_PRESSURE,
    startMs: range.startMs,
    endMs: range.endMs,
  });
  const deduped = query.dedupe ? dedupeBloodPressure(stored) : { kept: stored, duplicates: [] };
  const pulseOf = await pulses(deps, call, device, deduped.kept);
  const reading = (record: HcRecord) => ({
    id: record.id,
    time: clock.iso(recordStartMs(record)),
    systolic: finite(record.data.systolic),
    diastolic: finite(record.data.diastolic),
    bodyPosition: textOf(record.data.bodyPosition),
    measurementLocation: textOf(record.data.measurementLocation),
    pulse: pulseOf.get(record.id) ?? null,
    origin: record.origin,
  });
  const tags = rowTags(device, TYPE_BLOOD_PRESSURE);
  const strip = (row: Record<string, unknown>): Record<string, unknown> =>
    stripJoined(call.rules, "blood_pressure", row);
  if (!query.group) {
    return {
      rows: deduped.kept.map((record) => strip({ kind: "reading", ...tags, ...reading(record) })),
      duplicates: deduped.duplicates.length,
    };
  }
  const sessions = groupBloodPressureSessions(deduped.kept, query.windowMin);
  const rows = sessions.map((session) => {
    const readings = session.readings.map((record) => reading(record));
    const withPulse = readings.flatMap((entry) => entry.pulse ?? []);
    return strip({
      kind: "session",
      ...tags,
      start: clock.iso(session.startMs),
      end: clock.iso(session.endMs),
      systolic: session.systolic,
      diastolic: session.diastolic,
      pulse: meanOf(withPulse),
      readingCount: readings.length,
      origins: distinctText(readings.map((entry) => entry.origin)),
      readings,
    });
  });
  return { rows, duplicates: deduped.duplicates.length };
}

/** `prefix:<count>` when the count is not zero. */
function counted(prefix: string, count: number): string[] {
  return count > 0 ? [`${prefix}:${String(count)}`] : [];
}

export function registerHcHeartTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "hr_series",
      description:
        "Heart rate over `[start, end)` as a time series, one row per point: `t`, `mean`, " +
        "`min`, `max`, `n` (samples behind the point) and `origin`. At `1min` `mean` is the " +
        "plain mean of that minute's samples; at `5min` and `1h` it is the mean of those " +
        "minute means; at `5s` it is time-weighted (each reading counts for as long as it " +
        "stood). `resolution` is `1min` " +
        "by default; `5min` and `1h` are also answered from stored per-minute statistics, " +
        "while `raw` (every sample; `mean` is the reading) and `5s` open the raw records and " +
        "suit minutes to hours, not days. A series longer than `max_points` (default " +
        `${String(DEFAULT_MAX_POINTS)}) is made coarser, never cut short: its points are put on the ` +
        "next width of a fixed ladder that fits (2, 5, 10, 15, 30 minutes; 1, 2, 3, 6, 12 " +
        "hours; 1, 2, 7, 14, 28 days), a whole multiple of the resolution asked for. Each " +
        "series (one per phone and app) is resampled on its own, so `series` in the answer " +
        "lists each one's `bucketMs`, `decimated`, `decimation`, `totalPoints` and `points` " +
        "(its number of rows), in the order the series appear in the rows. The top-level " +
        "`bucketMs` and `decimation` are given only when every series " +
        "shares them, and are null otherwise; `hr_series_decimated:<factor>` warns with the " +
        "largest factor. Minutes nothing was measured in are absent, " +
        "not interpolated. Readings above 200 or below 20 bpm are sensor artefacts and are " +
        "left out " +
        "(`hr_artefacts_dropped:<n>`). One app's readings only, unless `origins` names " +
        `several: two devices are never blended. ${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: SERIES_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "hr_series", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const coverage = await deviceCoverageFor(deps, call, { named: [TYPE_HEART_RATE] });
      const allowed = typeAllowed(call.rules, TYPE_HEART_RATE);
      const query: SeriesQuery = {
        range: parseRange({
          start: args.start,
          end: args.end,
          timeZone: call.clock.timeZone,
          nowMs: call.nowMs,
        }),
        resolution: args.resolution ?? DEFAULT_RESOLUTION,
        maxPoints: args.max_points ?? DEFAULT_MAX_POINTS,
        origins: args.origins,
      };
      if (query.range.endMs < query.range.startMs) return toolError("invalid_range");
      const stats = args.stats ?? STATS;

      const items: unknown[] = [];
      const totals = { artefacts: 0, otherOrigins: 0, points: 0 };
      // One entry per series, in row order. It names no app: the envelope is
      // not filtered by the exposure policy the way rows are, and `origin` is
      // a field the owner can hide.
      const shapes: SeriesShape[] = [];
      const devices = allowed ? call.devices : [];
      for (const device of devices) {
        const read = await readSeries(deps, device.id, query);
        totals.artefacts += read.artefactsDropped;
        totals.otherOrigins += read.otherOrigins;
        const tags = rowTags(device, TYPE_HEART_RATE);
        for (const { origin, result } of read.series) {
          totals.points += result.totalPoints;
          shapes.push({
            bucketMs: result.bucketMs,
            decimated: result.decimated,
            decimation: result.decimation,
            totalPoints: result.totalPoints,
            points: result.points.length,
          });
          for (const point of result.points) {
            items.push({ ...tags, origin, ...pointItem(point, stats, call.clock) });
          }
        }
      }
      const largest = Math.max(1, ...shapes.map((shape) => shape.decimation));

      return hcRespond({
        tool: "hr_series",
        call,
        args,
        page,
        items,
        coverage,
        warnings: [
          ...(allowed ? [] : [typeDeniedWarning(TYPE_HEART_RATE)]),
          ...(largest > 1 ? [`hr_series_decimated:${String(largest)}`] : []),
          ...counted("hr_artefacts_dropped", totals.artefacts),
          ...counted("hr_other_origins_not_shown", totals.otherOrigins),
        ],
        extra: {
          units: { mean: "bpm", min: "bpm", max: "bpm", n: "samples", bucketMs: "ms" },
          resolution: query.resolution,
          // What every series shares, or null: `raw` points are on no grid, and
          // two series can be decimated differently. `series` has each one's.
          bucketMs: shared(shapes.map((shape) => shape.bucketMs)),
          decimated: largest > 1,
          decimation: shared(shapes.map((shape) => shape.decimation)),
          totalPoints: totals.points,
          series: shapes,
        },
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "hr_events",
      description:
        "Sustained rises in heart rate within `[start, end)`: standing up, waking, a spike. " +
        "A minute whose mean is `min_delta_bpm` or more above its baseline opens an event; " +
        "the baseline is the 10th percentile of the quiet minutes in the `window_s` seconds " +
        "before it, minutes inside an earlier event left out. The event lasts while the " +
        "heart rate stays at least half that far above the baseline, and is reported when " +
        "it lasted `sustain_s` or longer. With the defaults a slow climb (about 2 bpm a " +
        "minute) is NOT reported, because the baseline rises with it: lengthen `window_s` " +
        "or lower `min_delta_bpm` to look for one. One row per event: `start`, `end`, `peakAt`, `baselineBpm`, `peakBpm`, " +
        "`deltaBpm`, `timeToPeakS`, `durationS`, `origin`, and `context` -- `exercise` " +
        "(during a recorded workout), `wake` (at the end of a sleep session), `sleep` or " +
        "`other`. Computed on per-minute means, so a rise shorter than a minute is not " +
        `seen. ${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: EVENTS_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "hr_events", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const coverage = await deviceCoverageFor(deps, call, { named: [TYPE_HEART_RATE] });
      const allowed = typeAllowed(call.rules, TYPE_HEART_RATE);
      const range = parseRange({
        start: args.start,
        end: args.end,
        timeZone: call.clock.timeZone,
        nowMs: call.nowMs,
      });
      if (range.endMs < range.startMs) return toolError("invalid_range");
      const options: HrEventOptions = {
        minDeltaBpm: args.min_delta_bpm ?? DEFAULT_MIN_DELTA_BPM,
        windowS: args.window_s ?? DEFAULT_WINDOW_S,
        sustainS: args.sustain_s ?? DEFAULT_SUSTAIN_S,
      };

      const items: unknown[] = [];
      let artefacts = 0;
      const devices = allowed ? call.devices : [];
      for (const device of devices) {
        const found = await eventRows(deps, call, device, {
          range,
          options,
          origins: args.origins,
        });
        artefacts += found.artefactsDropped;
        items.push(...found.rows);
      }

      return hcRespond({
        tool: "hr_events",
        call,
        args,
        page,
        items,
        coverage,
        warnings: [
          ...(allowed
            ? deniedJoins(call.rules, "hr_events").warnings
            : [typeDeniedWarning(TYPE_HEART_RATE)]),
          ...counted("hr_artefacts_dropped", artefacts),
        ],
        extra: {
          units: {
            baselineBpm: "bpm",
            peakBpm: "bpm",
            deltaBpm: "bpm",
            timeToPeakS: "s",
            durationS: "s",
          },
          rule: options,
        },
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "blood_pressure",
      description:
        "Blood-pressure readings from the phone in `[start, end)`. By default grouped into " +
        "sittings (`kind: session`): readings within `window_min` minutes of the one before " +
        "are one sitting, with `systolic` and `diastolic` as the sitting's means, `pulse`, " +
        "`readingCount` and the `readings` themselves (`time`, `systolic`, `diastolic`, " +
        "`bodyPosition`, `measurementLocation`, `pulse`, `origin`). `group_sessions: false` " +
        "returns one `kind: reading` row each instead. The same measurement written by two " +
        "apps (same time to the nearest second, same values to 0.1 mmHg) is counted once, " +
        "the earliest-written copy kept, " +
        "and the answer says how many copies it left out (`hc_duplicates_dropped:<n>`); " +
        "`dedupe: false` keeps them all. `pulse` is the heart rate the same app recorded in " +
        "the reading's minute, when it recorded one. Separate from `get_vitals`, which " +
        `holds what a clinic measured. ${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: PRESSURE_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "blood_pressure", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const coverage = await deviceCoverageFor(deps, call, { named: [TYPE_BLOOD_PRESSURE] });
      const allowed = typeAllowed(call.rules, TYPE_BLOOD_PRESSURE);
      const query: PressureQuery = {
        range: parseRange({
          start: args.start,
          end: args.end,
          timeZone: call.clock.timeZone,
          nowMs: call.nowMs,
        }),
        dedupe: args.dedupe !== false,
        group: args.group_sessions !== false,
        windowMin: args.window_min,
      };
      if (query.range.endMs < query.range.startMs) return toolError("invalid_range");

      const items: unknown[] = [];
      let duplicates = 0;
      const devices = allowed ? call.devices : [];
      for (const device of devices) {
        const found = await pressureRows(deps, call, device, query);
        duplicates += found.duplicates;
        items.push(...found.rows);
      }

      return hcRespond({
        tool: "blood_pressure",
        call,
        args,
        page,
        items,
        coverage,
        warnings: [
          ...(allowed
            ? deniedJoins(call.rules, "blood_pressure").warnings
            : [typeDeniedWarning(TYPE_BLOOD_PRESSURE)]),
          ...counted("hc_duplicates_dropped", duplicates),
        ],
        extra: {
          units: { systolic: "mmHg", diastolic: "mmHg", pulse: "bpm" },
          sessionWindowMin: args.window_min ?? BP_SESSION_WINDOW_MIN,
        },
      });
    },
  );
}
