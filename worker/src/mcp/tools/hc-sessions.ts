/**
 * `sleep_sessions` and `exercise_sessions`: one row per night, one per workout.
 *
 * Both answer from the summaries the store builds when a session arrives
 * (`hc_sleep_night`, `hc_exercise_session`): stage minutes, the overnight
 * heart-rate and HRV joins, the heart-rate-checked wake, the left-running
 * flag. No raw chunk is opened.
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

import { isOverThreeHours } from "../../hc/rules.ts";
import { AVAILABILITY_NOTE, BUDGET_NOTE, hcArgs, rangeArgs } from "../hc/args.ts";
import { openStampedPage } from "../hc/page.ts";
import { JOINED_FIELDS, deniedJoins, stripJoined } from "../hc/policy.ts";
import { groupSessions } from "../hc/sessions.ts";
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
import type { Group, Spanned } from "../hc/sessions.ts";
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
function groupFields<Summary extends Spanned>(call: HcCall, group: Group<Summary>) {
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
      id,
      start: clock.iso(summary.startMs),
      end: clock.iso(summary.endMs),
      ...(summary.exerciseType !== undefined && { exerciseType: summary.exerciseType }),
      origin: summary.origin,
    })),
  };
}

/** True when the policy lets this call see the left-running flag, which is heart rate and steps. */
function leftRunningReadable(call: HcCall): boolean {
  return JOINED_FIELDS.exercise_sessions.likelyLeftRunning.every((type) =>
    typeAllowed(call.rules, type),
  );
}

function sleepRow(
  call: HcCall,
  device: HcDevice,
  group: Group<SleepNight>,
  includeStages: boolean,
): Record<string, unknown> {
  const { clock } = call;
  const night = group.primary.summary;
  return stripJoined(call.rules, "sleep_sessions", {
    ...rowTags(device, TYPE_SLEEP),
    id: group.primary.id,
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
    hr: night.hr,
    hrv: night.hrv === null ? null : { ...night.hrv, iqr: night.hrv.q3 - night.hrv.q1 },
    respiratoryRate: night.respiratoryRate,
    skinTempDelta: night.skinTempDelta,
    restingHr: night.restingHr,
    contextClamped: night.contextClamped ?? false,
    ...groupFields(call, group),
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
): Record<string, unknown> {
  const { clock } = call;
  const session = group.primary.summary;
  return stripJoined(call.rules, "exercise_sessions", {
    ...rowTags(device, TYPE_EXERCISE),
    id: group.primary.id,
    title: session.title,
    exerciseType: session.exerciseType,
    // The session's own times, like every figure below: one span for the row.
    start: clock.iso(session.startMs),
    end: clock.iso(session.endMs),
    durationMin: (session.endMs - session.startMs) / MINUTE_MS,
    hr: session.hr,
    energy: session.energy,
    distance: session.distance,
    steps: session.steps,
    overThreeHours: isOverThreeHours(session),
    likelyLeftRunning: session.likelyLeftRunning,
    zeroLength: session.zeroLength,
    exactDuplicate: session.exactDuplicate,
    hasRoute: session.hasRoute,
    contextClamped: session.contextClamped ?? false,
    ...groupFields(call, group),
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
    const groups = groupSessions(
      TYPE_SLEEP,
      nights.map(({ id, night }) => ({ id, summary: night })),
    );
    for (const group of groups) rows.push(sleepRow(call, device, group, includeStages));
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
    const groups = groupSessions(
      TYPE_EXERCISE,
      sessions
        .filter(({ session }) => wanted === null || wanted.has(session.exerciseType.toUpperCase()))
        .map(({ id, session }) => ({ id, summary: session })),
      leftRunningReadable(call),
    );
    for (const group of groups) rows.push(exerciseRow(call, device, group));
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
        "`wearableWake` is the end of the last sleep stage the wearable logged, `hrWake` " +
        "is the first sustained rise in heart rate after the pulse was last settled -- so " +
        "an awakening the sleeper went back to sleep from is not the wake. They differ when " +
        "the wearable kept logging sleep after you got up, or stopped early. " +
        "`stagesOverlap` is true when the stages overlapped and were cut so no stretch " +
        "counts twice. Overnight `hr` (`min` and `max` over the samples; `mean` is the mean " +
        "of per-minute means, so a densely sampled stretch does not outweigh a sparse " +
        "one), `hrv` (`median`, `q1`, `q3`, `iqr` of RMSSD), " +
        "`respiratoryRate`, `skinTempDelta` (versus the wearable's own baseline), " +
        "`restingHr`, and `origin`. Sessions two apps wrote for the same night are one " +
        "row (`mergedSessions`, `origins`), described by the longest, with every session " +
        "it stands for listed in `members` (`id`, `start`, `end`, `origin`) and the stretch " +
        "they cover together in `spanStart`, `spanEnd`, `spanMin`. A session longer than 18 " +
        "hours is never merged with another: it was not closed, and gets a row of its own. " +
        "`contextClamped` is true when a session claimed so long a span that only its first " +
        "48 hours of heart rate and the rest were read for the joins. `include_stages` " +
        `adds the stage timeline. ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
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
        "`durationMin`, heart rate during it (`hr`: `max` and `min` over the samples, " +
        "`mean` as the mean of per-minute means), `energy` (active kcal), `distance`, " +
        "`steps` (a record that only partly overlaps the session counts in proportion), " +
        "`origin`, and four flags: `overThreeHours` (the session is longer than three " +
        "hours, by the clock alone), " +
        "`likelyLeftRunning` (over three hours, ending in resting heart rate and no steps: " +
        "probably a forgotten stop button, so do not trust its duration), `zeroLength`, and " +
        "`exactDuplicate`. Sessions of the same exercise type that overlap in time -- the " +
        "same workout from two apps -- are merged into one row (`mergedSessions`, `origins`, " +
        "`exactDuplicates`). Every figure on the row, `start`, `end` and `durationMin` " +
        "included, is the longest session's; `members` lists every session the row stands " +
        "for (`id`, `start`, `end`, `exerciseType`, `origin`) and `spanStart`, `spanEnd`, " +
        "`spanMin` the stretch they cover together, so summing `spanMin` over one exercise " +
        "type never counts an hour twice. A session that is `likelyLeftRunning` or longer " +
        "than 12 hours is never merged with anything but an exact copy of itself, so a " +
        "forgotten session cannot swallow the real workouts recorded while it ran: each " +
        "keeps its own row. `contextClamped` is true when a session claimed so long a span " +
        "that only its first 48 hours of heart rate, steps and energy were read. " +
        `${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
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
