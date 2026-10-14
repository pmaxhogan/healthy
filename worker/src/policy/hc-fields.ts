/**
 * Which field of which Health Connect tool's rows belongs to which record type.
 *
 * A row is tagged with one `resourceType` (`hc:<Type>`), but several tools
 * put numbers on a row that were measured as a DIFFERENT type: a night's row
 * carries the overnight heart rate, a day's row the night's skin temperature,
 * a blood-pressure reading the cuff's pulse. The exposure policy has to follow
 * a type to those fields or a rule on it can be walked around, and these two
 * tables are the one place that says where they are:
 *
 *  - {@link JOINED_FIELDS}: per tool, the fields measured as (or derived from)
 *    some other type than the row's own, and which types. A dotted name is a
 *    field one level down (`sleep.skinTempDelta`, also inside an array). A
 *    field with several types needs all of them.
 *  - {@link OWN_FIELDS}: per tool, every other field of its rows: the row's own
 *    type's, or bookkeeping.
 *
 * Together they name every field these tools emit, and a unit test holds them
 * to that against the tools' real output, so a field cannot be added to a row
 * without someone deciding which type it belongs to.
 *
 * Read by `worker/src/mcp/hc/policy.ts` (a `resource` rule on a source type
 * removes its joined fields), by `./hc-aliases.ts` (a `field` rule on a source
 * type reaches them) and by `./tree.ts` (which shapes a rule's scope reaches).
 *
 * Pure: plain data, no imports.
 */

export const JOINED_FIELDS = {
  sleep_sessions: {
    hr: ["HeartRate"],
    hrWake: ["HeartRate"],
    hrFirstRise: ["HeartRate"],
    hrv: ["HeartRateVariabilityRmssd"],
    respiratoryRate: ["RespiratoryRate"],
    skinTempDelta: ["SkinTemperature"],
    restingHr: ["RestingHeartRate"],
  },
  exercise_sessions: {
    hr: ["HeartRate"],
    steps: ["Steps"],
    distance: ["Distance"],
    energy: ["ActiveCaloriesBurned"],
    energyOrigin: ["ActiveCaloriesBurned"],
    likelyLeftRunning: ["HeartRate", "Steps"],
    leftRunningReason: ["HeartRate", "Steps"],
  },
  blood_pressure: {
    pulse: ["HeartRate"],
    "readings.pulse": ["HeartRate"],
  },
  hr_events: {
    context: ["SleepSession", "ExerciseSession"],
  },
  daily_summary: {
    steps: ["Steps"],
    distance: ["Distance"],
    activeKcal: ["ActiveCaloriesBurned"],
    totalKcal: ["TotalCaloriesBurned"],
    sleep: ["SleepSession"],
    "sleep.skinTempDelta": ["SkinTemperature"],
    restingHr: ["RestingHeartRate"],
    hrvRmssdMean: ["HeartRateVariabilityRmssd"],
    respiratoryRate: ["RespiratoryRate"],
    bloodPressure: ["BloodPressure"],
    weight: ["Weight"],
    weighings: ["Weight"],
    exercises: ["ExerciseSession"],
    "exercises.likelyLeftRunning": ["HeartRate", "Steps"],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type JoiningTool = keyof typeof JOINED_FIELDS;

export const OWN_FIELDS = {
  sleep_sessions: [
    "resourceType",
    "healthSystemId",
    "id",
    "date",
    "start",
    "end",
    "title",
    "inBedMin",
    "asleepMin",
    "awakeMin",
    "stageMin",
    "stagesOverlap",
    "onset",
    "wearableWake",
    "origin",
    "mergedSessions",
    "exactDuplicates",
    "origins",
    "spanStart",
    "spanEnd",
    "spanMin",
    "members",
    "contextClamped",
    "stages",
  ],
  exercise_sessions: [
    "resourceType",
    "healthSystemId",
    "id",
    "title",
    "exerciseType",
    "start",
    "end",
    "durationMin",
    "overThreeHours",
    "zeroLength",
    "exactDuplicate",
    "hasRoute",
    "origin",
    "mergedSessions",
    "exactDuplicates",
    "origins",
    "spanStart",
    "spanEnd",
    "spanMin",
    "members",
    "contextClamped",
  ],
  blood_pressure: [
    "kind",
    "resourceType",
    "healthSystemId",
    "id",
    "time",
    "start",
    "end",
    "systolic",
    "diastolic",
    "bodyPosition",
    "measurementLocation",
    "readingCount",
    "origin",
    "origins",
    "readings",
    "readings.id",
    "readings.time",
    "readings.systolic",
    "readings.diastolic",
    "readings.bodyPosition",
    "readings.measurementLocation",
    "readings.origin",
  ],
  hr_events: [
    "resourceType",
    "healthSystemId",
    "origin",
    "start",
    "end",
    "peakAt",
    "baselineBpm",
    "peakBpm",
    "deltaBpm",
    "timeToPeakS",
    "durationS",
  ],
  daily_summary: [
    "resourceType",
    "healthSystemId",
    "date",
    "flags",
    "sleep.start",
    "sleep.end",
    "sleep.inBedMin",
    "sleep.asleepMin",
    "sleep.awakeMin",
    "sleep.wearableWake",
    "sleep.origin",
    "sleep.naps",
    "sleep.napMin",
    "sleep.totalAsleepMin",
    "exercises.title",
    "exercises.exerciseType",
    "exercises.start",
    "exercises.durationMin",
    "exercises.overThreeHours",
  ],
} as const satisfies Record<JoiningTool, readonly string[]>;

const JOINED_BY_TOOL: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>> = new Map(
  Object.entries(JOINED_FIELDS),
);

/** The joined fields of one tool's rows that carry data of `type`. None for a tool that joins nothing. */
export function joinedFieldsOf(tool: string, type: string): string[] {
  const table = JOINED_BY_TOOL.get(tool);
  return table === undefined
    ? []
    : Object.entries(table)
        .filter(([, types]) => types.includes(type))
        .map(([field]) => field);
}

/**
 * Health Connect record type, and the metric of the `Agg.<Metric>` record the
 * phone uploads for it: the platform's own priority-merged hourly total. An
 * aggregate is data of the type it aggregates, so the policy treats it as
 * that type everywhere.
 */
export const PLATFORM_PAIRS: readonly (readonly [type: string, metric: string])[] = [
  ["Steps", "Steps"],
  ["Distance", "Distance"],
  ["ActiveCaloriesBurned", "ActiveCalories"],
  ["FloorsClimbed", "Floors"],
  ["ElevationGained", "Elevation"],
  ["WheelchairPushes", "WheelchairPushes"],
  ["Hydration", "Hydration"],
  ["ExerciseSession", "ExerciseDuration"],
  ["SleepSession", "SleepDuration"],
];

/** Every record type some joined field carries, across the joining tools. */
export const JOINED_SOURCE_TYPES: readonly string[] = [
  ...new Set(
    Object.values(JOINED_FIELDS).flatMap((table: Record<string, readonly string[]>) =>
      Object.values(table).flat(),
    ),
  ),
];
