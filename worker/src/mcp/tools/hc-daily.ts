/**
`daily_summary` and `data_quality`: the two Health Connect tools that read
across record types.

`daily_summary` is the join point between phone data and a question like
"how was last week" (`../hc/daily.ts`); `data_quality` says what in a range
is duplicated, implausible, missing or changed hands (`../hc/quality.ts`).

Reading across types is where a `resource` deny rule is easiest to leak
past, so both decide which types they may read before reading any: a denied
type's section is not read and is absent from a day, a denied type yields no
finding and is not used as context for another type's rule, and every day
row goes out through `stripJoined` (`../hc/policy.ts`), which removes a
field that sits inside another type's section.

`data_quality`'s `types` argument is a different thing from the policy: it
chooses which findings to report, and never what a rule may read as context.
*/

import { z } from "zod";

import { AVAILABILITY_NOTE, BUDGET_NOTE, RANGE_NOTE, hcArgs, rangeArgs } from "../hc/args.ts";
import { DAILY_TYPES, dailySummary, summaryDays } from "../hc/daily.ts";
import { DEFAULT_MAX_BYTES, openStampedPage } from "../hc/page.ts";
import {
  deniedJoins,
  isPlatformAggregate,
  policyResourceType,
  sourceTypeOf,
  stripJoined,
} from "../hc/policy.ts";
import { QUALITY_RULES, dataQualityPage } from "../hc/quality.ts";
import {
  beginHcCall,
  dayRollupsUsable,
  deviceCoverageFor,
  deviceSourceId,
  hcRespond,
  rowTags,
  storeState,
  typeAllowed,
} from "../hc/sources.ts";
import { isCalendarDate, parseRange } from "../hc/time.ts";
import { toolError } from "../respond.ts";

import { readTool } from "./register.ts";

import type { ToolDeps } from "../deps.ts";
import type { DailySection } from "../hc/daily.ts";
import type { HcDevice } from "../hc/reads.ts";
import type { HcCall } from "../hc/sources.ts";
import type { Range } from "../hc/time.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** What a record type is prefixed with in a warning and a row's `resourceType`. */
const HC_PREFIX = "hc:";

/** What a `daily_summary` row is tagged as: a view over several record types. */
const DAILY_SUMMARY_TYPE = "DailySummary";

const DAY_ARG = z
  .string()
  .refine(isCalendarDate, { message: "must be a calendar date (2026-01-31)" })
  .optional()
  .describe("One local day. Not together with `start`/`end`.");

const DAILY_RANGE = rangeArgs("days the range touches");

const DAILY_SCHEMA = hcArgs("daily_summary", {
  date: DAY_ARG,
  start: DAILY_RANGE.start.optional(),
  end: DAILY_RANGE.end,
});

const TYPE_NAME = z.string().min(1);

const QUALITY_TYPES_ARG = z
  .array(TYPE_NAME)
  .max(200)
  .optional()
  .describe(
    "Only report findings about these record types. Omit for every type the phone holds. " +
      "This narrows the report, not what a rule may look at: a profile-setup weight is " +
      "still told by the height beside it when only `Weight` is asked for.",
  );

const QUALITY_SCHEMA = hcArgs("data_quality", {
  ...rangeArgs("records that start in the range"),
  types: QUALITY_TYPES_ARG,
});

const DAILY_UNITS = {
  steps: "steps",
  distance: "m",
  activeKcal: "kcal",
  totalKcal: "kcal",
  asleepMin: "min",
  napMin: "min",
  totalAsleepMin: "min",
  inBedMin: "min",
  awakeMin: "min",
  skinTempDelta: "celsius",
  restingHr: "bpm",
  hrvRmssdMean: "ms",
  respiratoryRate: "breaths/min",
  systolic: "mmHg",
  diastolic: "mmHg",
  weight: "kg",
  durationMin: "min",
} as const;

/**
The local days a `daily_summary` call names: one `date`, a range, or today.

Arguments that cannot mean anything are refused, not guessed at: `end`
without `start` (which day would the range begin on?), `date` beside a
range, and a range that ends before it starts -- each of which used to come
back as an answer for some other days, or for none. The refusal is the
`invalid_range` error with `detail` saying which of the three it was.
*/
function daysAsked(
  call: HcCall,
  args: { date?: string | undefined; start?: string | undefined; end?: string | undefined },
): { days: string[] } | { refused: string } {
  const { clock, nowMs } = call;
  if (args.date !== undefined) {
    return args.start === undefined && args.end === undefined
      ? { days: [args.date] }
      : { refused: "pass either `date` or `start`/`end`, not both" };
  }
  if (args.start === undefined) {
    return args.end === undefined
      ? { days: [clock.day(nowMs)] }
      : { refused: "`end` needs `start`: pass both, or `date` for one day" };
  }
  const timeZone = clock.timeZone;
  const range = parseRange({ start: args.start, end: args.end, timeZone, nowMs });
  return range.endMs > range.startMs
    ? { days: summaryDays(range, timeZone) }
    : { refused: "`end` is not after `start`" };
}

/** The record types of one phone that `data_quality` may assess. */
async function assessableTypes(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  wanted: ReadonlySet<string> | null,
): Promise<string[]> {
  const rows = await deps.hc.syncRows(device.id);
  return (
    rows
      .filter((row) => row.recordCount > 0)
      // The platform's own aggregates are not something to assess the quality of.
      .filter((row) => !isPlatformAggregate(row.recordType))
      .filter((row) => wanted === null || wanted.has(row.recordType))
      .filter((row) => typeAllowed(call.rules, row.recordType))
      .map((row) => row.recordType)
  );
}

export function registerHcDailyTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "daily_summary",
      description:
        "One row per local day from the phone's Health Connect data: `steps`, `distance`, " +
        "`activeKcal`, `totalKcal` (what was recorded -- never padded with basal metabolic " +
        "rate, so a day the tracker was off is low, not plausible; when an app wrote a " +
        "day's energy as one long record, that record only counts in the hours no app " +
        "measured, and the day is then flagged `long_record_used`), `sleep` (the night that " +
        "ended that day, the day you woke up -- the same date `sleep_sessions` and " +
        "`hc_aggregate` give it: `asleepMin`, `inBedMin`, `awakeMin`, `start`, `end` of the " +
        "main night, the longest; `naps`, how many other sleeps ended that day, `napMin`, " +
        "their time asleep, and `totalAsleepMin`, the main night and the naps together -- " +
        "the day's sleep as `hc_aggregate`'s `durationMs` counts it), " +
        "`restingHr` (from the wearable's resting-heart-rate records; a blood-pressure " +
        "cuff's pulse written as one is excluded), `hrvRmssdMean` (the MEAN of the day's " +
        "HRV readings -- not the night's median that `sleep_sessions` gives as " +
        "`hrv.median`), `respiratoryRate` (the day's mean), " +
        "`bloodPressure` (mean of the day's readings, duplicates counted once), `weight` " +
        "(the day's last weighing that is not a profile entry; `weighings` lists every " +
        "one, each with its `flag`), `exercises` (each workout on the day it started, with " +
        "its own `start` and `durationMin`, `overThreeHours` and `likelyLeftRunning`), and " +
        "`flags` saying what to read with " +
        "care (`partial_day`, `other_origins_dropped`, `long_record_used`, " +
        "`bp_duplicates_dropped`, " +
        "`resting_hr_cuff_pulse_excluded`, `weight_profile_artefact_excluded`, " +
        "`exercise_over_three_hours`, `exercise_likely_left_running`, " +
        "`session_context_clamped`, ...). The two exclusions each need a second record " +
        "type to tell the artefact by -- the cuff rule the blood-pressure readings, the " +
        "profile rule the heights -- and apply only when the owner's policy lets that type " +
        "be read. When it does not, the rule is not applied, the figure is as recorded, and " +
        "`warnings` says so: `resting_hr_cuff_rule_not_applied` (`restingHr` may include a " +
        "cuff's pulse) or `weight_artefact_rule_not_applied` (`weight` may be a profile " +
        "entry). What was left out is counted per kind: `hc_bp_duplicates_dropped:<n>` " +
        "(copies of a blood-pressure reading), `hc_other_origins_dropped:<n>` (records of an " +
        "app that lost an hour of a day total to another) and " +
        "`resting_hr_cuff_pulse_excluded:<n>`. Pass `date` for one day or `start` and `end` " +
        "for a range; with neither, today. `end` without `start`, `date` together with a " +
        "range, and an `end` that is not after `start` are refused (`invalid_range`). " +
        "Totals follow `hc_aggregate`'s `hc_priority`. A workout's `likelyLeftRunning` is " +
        "the flag `exercise_sessions` gives it, by either of its two rules. A " +
        "missing value is null; a section the owner's policy withholds is absent. " +
        `${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: DAILY_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "daily_summary", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const asked = daysAsked(call, args);
      if ("refused" in asked) return toolError("invalid_range", { detail: asked.refused });
      const { days } = asked;
      const allowed = (type: string): boolean => typeAllowed(call.rules, type);

      const sections = new Set<DailySection>();
      for (const [section, type] of Object.entries(DAILY_TYPES) as [DailySection, string][]) {
        if (typeAllowed(call.rules, type)) sections.add(section);
      }
      const warnings: string[] = deniedJoins(call.rules, "daily_summary").warnings;
      // A day is joined from whatever the phone holds; none of these types is
      // asked for by name, so one it has nothing of is simply not mentioned.
      const coverage = await deviceCoverageFor(deps, call, {
        types: Object.values(DAILY_TYPES),
      });

      const items: unknown[] = [];
      // Counted per kind: a copy of a reading and a losing app's records are not one thing.
      const dropped = { cuffPulses: 0, bpCopies: 0, otherOrigins: 0 };
      const notApplied = new Set<string>();
      for (const device of call.devices) {
        const state = await storeState(deps, device);
        warnings.push(...state.warnings);
        const result = await dailySummary(deps.hc, {
          deviceId: device.id,
          days,
          clock: call.clock,
          nowMs: call.nowMs,
          dayRollupsUsable: (type, range) =>
            dayRollupsUsable(deps, call, device, { state, type, range }),
          sections,
          allowed,
        });
        dropped.cuffPulses += result.cuffPulsesExcluded;
        dropped.bpCopies += result.bpDuplicatesDropped;
        dropped.otherOrigins += result.duplicatesDropped;
        for (const code of result.rulesNotApplied) notApplied.add(code);
        const tags = rowTags(device, DAILY_SUMMARY_TYPE);
        for (const row of result.rows) {
          items.push(stripJoined(call.rules, "daily_summary", { ...tags, ...row }));
        }
      }
      if (dropped.cuffPulses > 0) {
        warnings.push(`resting_hr_cuff_pulse_excluded:${String(dropped.cuffPulses)}`);
      }
      if (dropped.bpCopies > 0) {
        warnings.push(`hc_bp_duplicates_dropped:${String(dropped.bpCopies)}`);
      }
      if (dropped.otherOrigins > 0) {
        warnings.push(`hc_other_origins_dropped:${String(dropped.otherOrigins)}`);
      }
      // Stable codes, no count and no type name: a rule that could not run.
      warnings.push(...notApplied);

      return hcRespond({
        tool: "daily_summary",
        call,
        args,
        page,
        items,
        coverage,
        warnings,
        extra: {
          units: DAILY_UNITS,
          // Everything is filed by when it started, except a night: by when it ended.
          bucketing: "start_time",
          sleepBucketing: "end_time",
          originMode: "hc_priority",
        },
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "data_quality",
      description:
        "What in the phone's data for `[start, end)` should be read with care, one row " +
        "per finding, each tagged with the record type (`resourceType: hc:<Type>`) and a " +
        "`kind`: `duplicate` (a blood-pressure reading written twice), `artefact` (heart " +
        "rate above 200 or below 20 bpm, speed above 15 m/s, an implausible floor count, a " +
        "weight typed into a profile screen and saved as a weighing -- `reason` says which, " +
        "grouped per hour for dense types), `overlapping_sessions`, `overlapping_stages` (a " +
        "night whose sleep stages overlapped and had to be cut), `session_missing` (a date " +
        "with overnight readings of at least two kinds -- resting heart rate, respiratory " +
        "rate, HRV, skin temperature, listed in `vitals` -- that no stored sleep session " +
        "accounts for: the wearable measured a night whose session did not arrive), " +
        "`long_session` (an " +
        "exercise session longer than three hours, by the clock alone), " +
        "`likely_left_running` (one of those that looks forgotten; `reason` says by which " +
        "rule: `resting_tail`, its last half hour at resting heart rate with no steps, or " +
        "`tail_below_active_phase`, its last half hour far below its own busiest half hour " +
        "in both pulse and cadence -- the flag and reason `exercise_sessions` gives it), " +
        "`zero_length_session`, `overlapping_origins` (two apps recording the same steps " +
        "or energy on one day, which a plain sum would double count), `gap` (days without a " +
        "type that is otherwise recorded most days -- reported only for what a device " +
        "records by itself, day in and day out: the sensor counters, the vitals a wearable " +
        "samples unasked, and sleep; a week without a workout, a weighing or a " +
        "blood-pressure reading is not a gap), `source_switch` (the app supplying a " +
        "type went away and another took over: reported only when the earlier app is " +
        "absent, or nearly, on the day of the change -- `previousShare` is its share of " +
        "that day's total -- so two apps recording side by side are not a switch; the " +
        "current local day is never judged, because it is unfinished and an app that has " +
        "not uploaded yet looks like one that left, so a switch that happens today is " +
        "reported from tomorrow on), " +
        "`precision_change` (an app's values went from rounded to unrounded " +
        "or back, usually a unit conversion), `stale_platform_total` (hours whose stored " +
        "platform total -- Health Connect's own hourly figure, which `hc_aggregate`'s " +
        "`hc_priority` and `daily_summary` use -- has a figure where the type has no record " +
        "at all (`reason: no_records`; `origins` are the apps the total says it counted); one " +
        "finding per run of such hours, `start` to `end`, `count` hours. That is a total from before " +
        "those records were deleted, and the figures built from it read high there until " +
        "the phone works the hours out again, which it is asked to do on its next syncs), " +
        "and `noisy_series` (floors climbed are " +
        "barometric estimates). `types` narrows which findings are reported, never what a " +
        "rule may look at: asking about `Weight` alone still finds a profile weight by the " +
        "height beside it, unless the owner's policy withholds heights. `rules` in the " +
        "answer gives every threshold. Nothing is " +
        "removed from the store by any of this: the other tools apply the same rules when " +
        "they answer. A platform total named in `types` (`Agg.Steps`) is not assessed, and " +
        "the answer says so: `not_assessed:hc:Agg.<Metric>`. " +
        "A LONG RANGE COMES BACK IN PAGES. The range is assessed half a year at a time, " +
        "oldest first, and one call reads at most two such windows (a year) -- fewer once " +
        "it holds `max_bytes` of findings -- because a single request cannot open years of " +
        "the store. When it stops short of `end` the answer says `truncated: true` with a " +
        "`cursor`, EVEN IF this page holds few findings or none: an empty or short page " +
        'with `truncated: true` means "nothing found so far", not "nothing found". ' +
        "Repeat the call with the `cursor` until `truncated` is false. On a truncated page " +
        "`total` and `matched` count the findings so far, this page and the ones before " +
        "it, not the whole range. No finding is dropped or repeated across pages, and what " +
        "a rule sees is not cut at a page: each window is judged with the half year before " +
        "it in view. " +
        `${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: QUALITY_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "data_quality", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const asked = parseRange({
        start: args.start,
        end: args.end,
        timeZone: call.clock.timeZone,
        nowMs: call.nowMs,
      });
      if (asked.endMs < asked.startMs) return toolError("invalid_range");
      // Nothing after now is assessed: a future day is not a gap.
      const range: Range = { startMs: asked.startMs, endMs: Math.min(asked.endMs, call.nowMs) };
      const wanted = args.types === undefined ? null : new Set(args.types);
      const coverage = await deviceCoverageFor(deps, call, { named: args.types });

      // A type named and not assessed is answered all the same: the platform's
      // own totals are not something to judge the quality of, and saying
      // nothing would read as "nothing found". (A name that is no type at all
      // is answered `unknown_type` with the rest of what was named.)
      const warnings: string[] = (args.types ?? [])
        .filter((type) => isPlatformAggregate(type) && sourceTypeOf(type) !== null)
        .filter((type) => typeAllowed(call.rules, type))
        .map((type) => `not_assessed:${HC_PREFIX}${type}`);
      const items: unknown[] = [];
      // The range is walked a window at a time, and one call reads a bounded
      // stretch of it (`dataQualityPage`). Where the first phone's page stops
      // is where every phone's does, so a page is one stretch of time for all
      // of them and the cursor names it.
      let scan: { fromMs: number; untilMs: number; done: boolean } | undefined;
      for (const device of call.devices) {
        const state = await storeState(deps, device);
        warnings.push(...state.warnings);
        const scanned = await dataQualityPage(
          deps.hc,
          {
            deviceId: device.id,
            range,
            clock: call.clock,
            nowMs: call.nowMs,
            dayRollupsUsable: (type, span) =>
              dayRollupsUsable(deps, call, device, { state, type, range: span }),
            // Which findings to report. What a rule may read is the policy's alone.
            types: await assessableTypes(deps, call, device, wanted),
            allowed: (type) => typeAllowed(call.rules, type),
          },
          {
            fromMs: page.anchorMs,
            untilMs: page.untilMs ?? scan?.untilMs,
            maxBytes: args.max_bytes ?? DEFAULT_MAX_BYTES,
          },
        );
        scan ??= { fromMs: scanned.fromMs, untilMs: scanned.untilMs, done: scanned.done };
        const { findings } = scanned;
        const healthSystemId = deviceSourceId(device.id);
        for (const finding of findings) {
          items.push({
            resourceType: policyResourceType(finding.type),
            healthSystemId,
            kind: finding.kind,
            ...finding.detail,
          });
        }
      }

      return hcRespond({
        tool: "data_quality",
        call,
        args,
        page,
        items,
        coverage,
        named: args.types,
        warnings,
        extra: { rules: QUALITY_RULES },
        ...(scan !== undefined && { scan }),
      });
    },
  );
}
