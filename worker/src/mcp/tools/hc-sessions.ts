/**
 * `sleep_sessions` and `exercise_sessions`: one row per night, one per workout.
 *
 * Both answer from the summaries the store builds when a session arrives
 * (`hc_sleep_night`, `hc_exercise_session`): stage minutes, the overnight
 * heart-rate and HRV joins, the heart-rate-checked wake, the left-running
 * flag. The only raw records opened are the sessions themselves, for one
 * thing: their ids. A summary is stored under a keyed blind of its record's
 * id, which is not a thing to hand out and joins to nothing; the `id` of a row
 * and of each of its `members` is the record's own, the one `hc_records` gives
 * it (`sessionRecordIds`), so a session here can be looked up there.
 *
 * What is decided here, at answer time, is which stored sessions are the same
 * stretch of time: two apps writing one night, or one workout logged twice.
 * That is `mergeOverlappingSessions` in `worker/src/hc/rules.ts`; a row is one
 * of its groups, and every figure on it -- `start`, `end`, `durationMin`, the
 * heart rate, steps and energy -- is the group's longest session's, so they
 * all describe the same span. The stretch the whole group covers is beside
 * them (`spanStart`, `spanEnd`, `spanMin`) and every session it stands for is
 * listed in `members`, so nothing a merge absorbed disappears. A session
 * flagged as left running, one longer than the rule's bound, or one of a
 * different exercise type is never merged into: it gets its own row.
 *
 * A joined or derived figure belongs to the record type it was measured as:
 * the overnight heart rate is heart-rate data, and `likelyLeftRunning` was
 * read off heart rate and steps. Every row goes out through `stripJoined`
 * (`../hc/policy.ts`), the one table of which field comes from which type, so
 * a deny rule on `hc:HeartRate` removes those fields here as well. A removed
 * `likelyLeftRunning` is dropped, not recomputed from duration alone: a flag
 * that silently changed meaning with the policy would be worse than no flag.
 */

import { z } from "zod";

import { dayBoundsMs } from "../../hc/rollup/day.ts";
import { isOverThreeHours } from "../../hc/rules.ts";
import { AVAILABILITY_NOTE, BUDGET_NOTE, RANGE_NOTE, hcArgs, rangeArgs } from "../hc/args.ts";
import { openStampedPage } from "../hc/page.ts";
import { JOINED_FIELDS, deniedJoins, stripJoined } from "../hc/policy.ts";
import { groupSessions, leftRunningReasons, restingHrByDay } from "../hc/sessions.ts";
import {
  beginHcCall,
  deviceCoverageFor,
  hcRespond,
  rowTags,
  typeAllowed,
  typeDeniedWarning,
} from "../hc/sources.ts";
import { MINUTE_MS, parseRange } from "../hc/time.ts";
import { distinctText } from "../hc/util.ts";
import { toolError } from "../respond.ts";

import { readTool } from "./register.ts";

import type { ExerciseSummary, SleepNight } from "../../hc/rollup/types.ts";
import type { ToolDeps } from "../deps.ts";
import type { HcDevice } from "../hc/reads.ts";
import type { Group, LeftRunningReason, Spanned } from "../hc/sessions.ts";
import type { HcCall } from "../hc/sources.ts";
import type { Range } from "../hc/time.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TYPE_SLEEP = "SleepSession";
const TYPE_EXERCISE = "ExerciseSession";

/** Every record type a row of each tool may carry a figure of, for coverage. */
const SLEEP_TYPES = distinctText([
  TYPE_SLEEP,
  ...Object.values(JOINED_FIELDS.sleep_sessions).flat(),
]);
const EXERCISE_TYPES = distinctText([
  TYPE_EXERCISE,
  ...Object.values(JOINED_FIELDS.exercise_sessions).flat(),
]);

const INCLUDE_STAGES_ARG = z
  .boolean()
  .optional()
  .describe("Also return each night's `stages` (`start`, `end`, `stage`). Default false.");

const SLEEP_SCHEMA = hcArgs("sleep_sessions", {
  ...rangeArgs("a session is returned when any part of it falls in the range"),
  include_stages: INCLUDE_STAGES_ARG,
});

const EXERCISE_TYPE = z.string().min(1);

const EXERCISE_TYPES_ARG = z
  .array(EXERCISE_TYPE)
  .max(100)
  .optional()
  .describe(
    "Only these exercise types (`WALKING`, `RUNNING`, ...), case-insensitive. Omit for all.",
  );

const EXERCISE_SCHEMA = hcArgs("exercise_sessions", {
  ...rangeArgs("a session is returned when any part of it falls in the range"),
  types: EXERCISE_TYPES_ARG,
});

/**
 * The row fields every merged group carries. `members` lists every session
 * the row stands for, the one that describes it included, each by its own id,
 * times and origin: a session a merge absorbed is still there to be seen.
 */
function groupFields<Summary extends Spanned>(
  call: HcCall,
  group: Group<Summary>,
  recordIds: RecordIds,
) {
  const { clock } = call;
  return {
    origin: group.primary.summary.origin,
    mergedSessions: group.members.length,
    exactDuplicates: group.merged.exactDuplicates,
    origins: distinctText(group.members.map((member) => member.summary.origin)),
    spanStart: clock.iso(group.merged.startMs),
    spanEnd: clock.iso(group.merged.endMs),
    spanMin: (group.merged.endMs - group.merged.startMs) / MINUTE_MS,
    members: group.members.map(({ id, summary }) => ({
      id: recordIdOf(recordIds, id),
      start: clock.iso(summary.startMs),
      end: clock.iso(summary.endMs),
      ...(summary.exerciseType !== undefined && { exerciseType: summary.exerciseType }),
      origin: summary.origin,
    })),
  };
}

/** The record id of each stored session in an answer, by its summary's key. */
type RecordIds = ReadonlyMap<string, string>;

/**
 * The id `hc_records` gives a stored session. Null when the record is not
 * there to be read (deleted since its summary was built, and the summary not
 * yet rebuilt): the summary's own key is internal and is never sent in its place.
 */
function recordIdOf(recordIds: RecordIds, key: string): string | null {
  return recordIds.get(key) ?? null;
}

/** True when the policy lets this call see the left-running flag, which is heart rate and steps. */
function leftRunningReadable(call: HcCall): boolean {
  return JOINED_FIELDS.exercise_sessions.likelyLeftRunning.every((type) =>
    typeAllowed(call.rules, type),
  );
}

/** What a sleep row is built with besides its group. */
interface SleepRowContext {
  recordIds: RecordIds;
  /** The resting heart rate of each row, by its primary's key: `restingHrByDay`. */
  restingHr: ReadonlyMap<string, number | null>;
  includeStages: boolean;
}

function sleepRow(
  call: HcCall,
  device: HcDevice,
  group: Group<SleepNight>,
  context: SleepRowContext,
): Record<string, unknown> {
  const { clock } = call;
  const { recordIds, includeStages } = context;
  const night = group.primary.summary;
  return stripJoined(call.rules, "sleep_sessions", {
    ...rowTags(device, TYPE_SLEEP),
    id: recordIdOf(recordIds, group.primary.id),
    date: clock.day(night.endMs),
    start: clock.iso(night.startMs),
    end: clock.iso(night.endMs),
    title: night.title,
    inBedMin: night.inBedMin,
    asleepMin: night.asleepMin,
    awakeMin: night.awakeMin,
    stageMin: night.stageMin,
    stagesOverlap: night.stagesOverlap ?? false,
    onset: clock.isoOrNull(night.onsetMs),
    wearableWake: clock.isoOrNull(night.stageWakeMs),
    hrWake: clock.isoOrNull(night.hrWakeMs),
    hrFirstRise: clock.isoOrNull(night.hrFirstRiseMs),
    hr: night.hr,
    hrv: night.hrv === null ? null : { ...night.hrv, iqr: night.hrv.q3 - night.hrv.q1 },
    respiratoryRate: night.respiratoryRate,
    skinTempDelta: night.skinTempDelta,
    // The day's figure, on the longest sleep of the date and not on whichever
    // session's end it was stamped at.
    restingHr: context.restingHr.get(group.primary.id) ?? null,
    contextClamped: night.contextClamped ?? false,
    ...groupFields(call, group, recordIds),
    ...(includeStages && {
      stages: night.stages.map((stage) => ({
        start: clock.iso(stage.start),
        end: clock.iso(stage.end),
        stage: stage.stage,
      })),
    }),
  });
}

function exerciseRow(
  call: HcCall,
  device: HcDevice,
  group: Group<ExerciseSummary>,
  recordIds: RecordIds,
  reasons: ReadonlyMap<string, LeftRunningReason>,
): Record<string, unknown> {
  const { clock } = call;
  const session = group.primary.summary;
  return stripJoined(call.rules, "exercise_sessions", {
    ...rowTags(device, TYPE_EXERCISE),
    id: recordIdOf(recordIds, group.primary.id),
    title: session.title,
    exerciseType: session.exerciseType,
    // The session's own times, like every figure below: one span for the row.
    start: clock.iso(session.startMs),
    end: clock.iso(session.endMs),
    durationMin: (session.endMs - session.startMs) / MINUTE_MS,
    hr: session.hr,
    energy: session.energy,
    energyOrigin: session.energyOrigin ?? null,
    distance: session.distance,
    // A record that straddles an end of the session counts in proportion, so
    // the stored sum can be fractional: a count of steps is rounded once, here.
    steps: session.steps === null ? null : Math.round(session.steps),
    overThreeHours: isOverThreeHours(session),
    likelyLeftRunning: session.likelyLeftRunning,
    leftRunningReason: reasons.get(group.primary.id) ?? null,
    zeroLength: session.zeroLength,
    exactDuplicate: session.exactDuplicate,
    hasRoute: session.hasRoute,
    contextClamped: session.contextClamped ?? false,
    ...groupFields(call, group, recordIds),
  });
}

/** The record ids of one phone's stored sessions in the range; nothing is read when there are none. */
async function sessionIds(
  deps: ToolDeps,
  device: HcDevice,
  type: string,
  range: Range,
  stored: number,
): Promise<RecordIds> {
  if (stored === 0) return new Map();
  return deps.hc.sessionRecordIds({
    deviceId: device.id,
    type,
    startMs: range.startMs,
    endMs: range.endMs,
  });
}

/** A stored night as the store's reader returns it: its key and its summary. */
type StoredNight = Awaited<ReturnType<ToolDeps["hc"]["sleepNights"]>>[number];

/**
 * The sleeps OUTSIDE the range that ended on a local date the answer has a
 * row for. They are never returned and never counted: they are read so that
 * which sleep of a date carries the day's resting heart rate
 * (`restingHrByDay`) does not depend on where the range was cut.
 *
 * Only two dates can be cut: the one the range starts in, and whatever lies
 * between the range's end and the end of the last date a returned sleep ended
 * on. So this is at most two reads a phone however long the range is, and none
 * when the range is whole days that hold every sleep's end, the usual case.
 */
async function sleepsBeyondRange(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  { range, nights }: { range: Range; nights: readonly StoredNight[] },
): Promise<StoredNight[]> {
  if (nights.length === 0) return [];
  const { clock } = call;
  let firstEnd = Infinity;
  let lastEnd = -Infinity;
  for (const { night } of nights) {
    firstEnd = Math.min(firstEnd, night.endMs);
    lastEnd = Math.max(lastEnd, night.endMs);
  }
  const fromMs = dayBoundsMs(clock.day(firstEnd), clock.timeZone).startMs;
  const toMs = dayBoundsMs(clock.day(lastEnd), clock.timeZone).endMs;
  const found: StoredNight[] = [];
  if (fromMs < range.startMs) {
    found.push(
      ...(await deps.hc.sleepNights({
        deviceId: device.id,
        startMs: fromMs,
        endMs: range.startMs,
      })),
    );
  }
  if (toMs > range.endMs) {
    found.push(
      ...(await deps.hc.sleepNights({ deviceId: device.id, startMs: range.endMs, endMs: toMs })),
    );
  }
  // A window's edge is shared with the range's: a sleep read twice is one sleep.
  const seen = new Set(nights.map(({ id }) => id));
  return found.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function sleepRows(
  deps: ToolDeps,
  call: HcCall,
  range: Range,
  includeStages: boolean,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const device of call.devices) {
    const nights = await deps.hc.sleepNights({ deviceId: device.id, ...range });
    const recordIds = await sessionIds(deps, device, TYPE_SLEEP, range, nights.length);
    const groups = groupSessions(
      TYPE_SLEEP,
      nights.map(({ id, night }) => ({ id, summary: night })),
    );
    // Judged over every sleep of the dates answered about, so that a range
    // which cuts a date between its night and its nap answers as a whole one does.
    const beyond = await sleepsBeyondRange(deps, call, device, { range, nights });
    const judged =
      beyond.length === 0
        ? groups
        : groupSessions(
            TYPE_SLEEP,
            [...nights, ...beyond].map(({ id, night }) => ({ id, summary: night })),
          );
    const restingHr = restingHrByDay(judged, (ms) => call.clock.day(ms));
    const context = { recordIds, restingHr, includeStages };
    for (const group of groups) rows.push(sleepRow(call, device, group, context));
  }
  return rows;
}

async function exerciseRows(
  deps: ToolDeps,
  call: HcCall,
  range: Range,
  types: readonly string[] | undefined,
): Promise<Record<string, unknown>[]> {
  const wanted = types === undefined ? null : new Set(types.map((type) => type.toUpperCase()));
  const rows: Record<string, unknown>[] = [];
  for (const device of call.devices) {
    const sessions = await deps.hc.exerciseSessions({ deviceId: device.id, ...range });
    const recordIds = await sessionIds(deps, device, TYPE_EXERCISE, range, sessions.length);
    const chosen = sessions
      .filter(({ session }) => wanted === null || wanted.has(session.exerciseType.toUpperCase()))
      .map(({ id, session }) => ({ id, summary: session }));
    // The flag is heart rate and steps, judged when the summary was built: a
    // call that may not see it gets neither it nor its reason (`stripJoined`
    // takes both off the row), and its grouping does not depend on it.
    const readable = leftRunningReadable(call);
    const reasons = readable ? leftRunningReasons(chosen) : new Map<string, LeftRunningReason>();
    const groups = groupSessions(TYPE_EXERCISE, chosen, readable);
    for (const group of groups) {
      rows.push(exerciseRow(call, device, group, recordIds, reasons));
    }
  }
  return rows;
}

export function registerHcSessionTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "sleep_sessions",
      description:
        "Sleep, one row per night (per stretch of sleep: a nap is its own row) with " +
        "anything in `[start, end)`. `date` is the local date the sleep ended on. " +
        "`inBedMin`, `asleepMin`, `awakeMin`, `stageMin` (minutes per stage: LIGHT, DEEP, " +
        "REM, AWAKE, ...), `onset` (first moment asleep), and two wake times: " +
        "`wearableWake` is the end of the last sleep stage the wearable logged; `hrWake` " +
        "is when the heart rate left its sleeping level FOR GOOD -- the start of the " +
        "sustained rise (12 bpm over the night's baseline, held five minutes) that follows " +
        "the LAST time the pulse was settled, looked for from 90 minutes before the " +
        "session's end to an hour after it. That makes `hrWake` the final get-up, not the " +
        "first stirring: if the pulse rose on waking, settled again for five minutes or " +
        "more (lying in, dozing), and rose again, `hrWake` is the second rise, and it can " +
        "be up to an hour after `end`. An awakening the sleeper went back to sleep from is " +
        "never it. `hrFirstRise` is the FIRST stirring after the session: the first rise " +
        "of the same size, held five minutes, that begins at or after `end` (within the " +
        "hour after it), whether or not the pulse settled again afterwards. It is `end` " +
        "itself when the pulse was already up as the session closed, equals `hrWake` when " +
        "there was only one rise and it came after `end`, and is null when nothing rose in " +
        "that hour or there is too little heart rate to say (and on a night whose summary " +
        "predates the field). The two wake times differ when " +
        "the wearable kept logging sleep after you got up, or stopped early. " +
        "`stagesOverlap` is true when the stages overlapped and were cut so no stretch " +
        "counts twice. Overnight `hr`: `min` and `max` are the lowest and highest single " +
        "SAMPLE of the night, `n` is the number of samples, and `mean` is the mean of the " +
        "per-minute means (not of the samples), so a densely sampled stretch does not " +
        "outweigh a sparse one. `hrv` (`median`, `q1`, `q3`, `iqr` of RMSSD), " +
        "`respiratoryRate`, `skinTempDelta` (versus the wearable's own baseline), " +
        "`restingHr` (the DAY's resting heart rate, one figure a day: when several sleeps " +
        "ended on one `date` it is on the longest of them, the night, and null on a nap, " +
        "wherever in the day the wearable stamped it -- unless the night and a nap each " +
        "have a reading of their own, which each keeps. Every sleep of the date is " +
        "weighed, also one outside `[start, end)`, so a row's `restingHr` is the same " +
        "whatever range returned it; `daily_summary` has the day's " +
        "figure too), and `origin`. Sessions two apps wrote for the same night are one " +
        "row (`mergedSessions`, `origins`), described by the longest, with every session " +
        "it stands for listed in `members` (`id`, `start`, `end`, `origin`) and the stretch " +
        "they cover together in `spanStart`, `spanEnd`, `spanMin`. A session longer than 18 " +
        "hours is never merged with another: it was not closed, and gets a row of its own. " +
        "A row's `id` and each member's `id` is that SleepSession record's `id` in `hc_records`. " +
        "`contextClamped` is true when a session claimed so long a span that only its first " +
        "48 hours of heart rate and the rest were read for the joins. `include_stages` " +
        `adds the stage timeline. ${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: SLEEP_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "sleep_sessions", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      // The tool is about sleep sessions; what is joined onto a night is listed
      // only where the phone has some.
      const coverage = await deviceCoverageFor(deps, call, {
        types: SLEEP_TYPES,
        named: [TYPE_SLEEP],
      });
      const allowed = typeAllowed(call.rules, TYPE_SLEEP);
      const range = parseRange({
        start: args.start,
        end: args.end,
        timeZone: call.clock.timeZone,
        nowMs: call.nowMs,
      });
      if (range.endMs < range.startMs) return toolError("invalid_range");
      return hcRespond({
        tool: "sleep_sessions",
        call,
        args,
        page,
        items: allowed ? await sleepRows(deps, call, range, args.include_stages === true) : [],
        coverage,
        warnings: allowed
          ? deniedJoins(call.rules, "sleep_sessions").warnings
          : [typeDeniedWarning(TYPE_SLEEP)],
        extra: {
          units: {
            inBedMin: "min",
            asleepMin: "min",
            awakeMin: "min",
            stageMin: "min",
            hr: "bpm",
            hrv: "ms",
            respiratoryRate: "breaths/min",
            skinTempDelta: "celsius",
            restingHr: "bpm",
          },
        },
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "exercise_sessions",
      description:
        "Workouts with anything in `[start, end)`, one row each: `title`, `exerciseType` " +
        "(the Health Connect name, e.g. WALKING, RUNNING, BIKING), `start`, `end`, " +
        "`durationMin`, heart rate during it (`hr`: `min` and `max` are the lowest and " +
        "highest single SAMPLE, `n` the number of samples, and `mean` the mean of the " +
        "per-minute means, not of the samples), `energy` (active kcal: the " +
        "sum of the `ActiveCaloriesBurned` records ONE app wrote during the session -- the " +
        "session's own app when it wrote any, otherwise the app that wrote the most; " +
        "`energyOrigin` names that app -- and " +
        "null when no app recorded active calories then, which is not zero; it is never " +
        "derived from total calories or a basal rate), `distance`, " +
        "`steps` (a whole number: a record that only partly overlaps the session counts in " +
        "proportion, and the sum is rounded once), " +
        "`origin`, and four flags: `overThreeHours` (the session is longer than three " +
        "hours, by the clock alone), " +
        "`likelyLeftRunning` (probably a forgotten stop button, so do not trust its " +
        "duration; `leftRunningReason` names the rule that found it. `resting_tail`: over " +
        "three hours, and its last 30 minutes are at or below 100 bpm with at most 30 steps " +
        "-- or it has neither heart rate nor steps to judge by. `tail_below_active_phase`: " +
        "over three hours, and its last 30 minutes are at least 20 bpm below its own " +
        "busiest half hour AND hold at most 20 steps a minute where that busiest half hour " +
        "held at least 40: the workout stopped and the tracker ran on while the wearer was " +
        "up and about. An activity that makes no steps is never judged by the second rule. " +
        "It is a flag only: no time or figure on the row is changed by it, and it is the " +
        "same flag `daily_summary`, `hc_aggregate` and `data_quality` use), `zeroLength`, " +
        'and `exactDuplicate`. For "minutes of exercise" over a period do not sum ' +
        "`durationMin` here: only same-type overlaps are merged, so two DIFFERENT exercise " +
        "types recorded at once count that time twice. `hc_aggregate` on `ExerciseSession` " +
        "with `duration` is Health Connect's own total, overlaps across types removed, and " +
        "is the one to quote; these rows say what the sessions were. " +
        "Sessions of the same exercise type that overlap in time -- the " +
        "same workout from two apps -- are merged into one row (`mergedSessions`, `origins`, " +
        "`exactDuplicates`). Every figure on the row, `start`, `end` and `durationMin` " +
        "included, is the longest session's; `members` lists every session the row stands " +
        "for (`id`, `start`, `end`, `exerciseType`, `origin`) and `spanStart`, `spanEnd`, " +
        "`spanMin` the stretch they cover together, so summing `spanMin` over one exercise " +
        "type never counts an hour twice. A session that is `likelyLeftRunning` or longer " +
        "than 12 hours is never merged with anything but an exact copy of itself, so a " +
        "forgotten session cannot swallow the real workouts recorded while it ran: each " +
        "keeps its own row. A row's `id` and each member's `id` is that ExerciseSession " +
        "record's `id` in `hc_records`. `contextClamped` is true when a session claimed so long a span " +
        "that only its first 48 hours of heart rate, steps and energy were read. " +
        `${RANGE_NOTE} ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: EXERCISE_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "exercise_sessions", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const coverage = await deviceCoverageFor(deps, call, {
        types: EXERCISE_TYPES,
        named: [TYPE_EXERCISE],
      });
      const allowed = typeAllowed(call.rules, TYPE_EXERCISE);
      const range = parseRange({
        start: args.start,
        end: args.end,
        timeZone: call.clock.timeZone,
        nowMs: call.nowMs,
      });
      if (range.endMs < range.startMs) return toolError("invalid_range");
      return hcRespond({
        tool: "exercise_sessions",
        call,
        args,
        page,
        items: allowed ? await exerciseRows(deps, call, range, args.types) : [],
        coverage,
        warnings: allowed
          ? deniedJoins(call.rules, "exercise_sessions").warnings
          : [typeDeniedWarning(TYPE_EXERCISE)],
        extra: {
          units: { durationMin: "min", hr: "bpm", energy: "kcal", distance: "m", steps: "steps" },
        },
      });
    },
  );
}
