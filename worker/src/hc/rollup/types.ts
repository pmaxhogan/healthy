/**
The shapes of the pre-aggregates the Health Connect store keeps beside its
raw chunks (worker/migrations/0016_health_connect.sql). Each is the sealed
`payload_enc` of one row.

Bucketing rule of what is STORED, everywhere: a record counts in the bucket
its START falls in, whole. A fifteen-minute interval that straddles an hour
is not split in a stored rollup. Sleep and exercise sessions are the
exception -- they have their own summaries.

What a stored rollup also carries is what an answer needs to divide such a
record afterwards: for the running counts (steps, distance, energy, floors)
every record that runs past the end of the hour it starts in is listed
(`crossing`), so `hc_aggregate` can give each bucket the share of the record
that falls in it without opening a chunk (`worker/src/mcp/hc/aggregate.ts`).

Three different means of heart rate appear in this store, and each field
says which it is:

 - `HrMinute.mean` (and a HeartRate `FieldStats.mean`) is a PLAIN mean of
   the samples in the bucket.
 - `SleepNight.hr.mean` and `ExerciseSummary.hr.mean` are means of the
   PER-MINUTE means, so a minute sampled sixty times weighs the same as a
   minute sampled once.
 - A resampled series (`resampleHeartRate` in `./hr.ts`) is TIME-WEIGHTED
   within each bucket: a reading counts for as long as it stood.

They differ whenever the sampling rate changes within the period, which on
a wearable is whenever activity does.
*/

/** Summary statistics of one numeric field across the records of a bucket. */
export interface FieldStats {
  /** Records (or, for a series type, samples) that carried the field. */
  n: number;
  sum: number;
  min: number;
  max: number;
  /** Plain mean of the `n` values: `sum / n`, kept within `[min, max]`. */
  mean: number;
  /** The value at the earliest instant, and that instant (epoch ms). */
  first: number;
  firstMs: number;
  /** The value at the latest instant, and that instant (epoch ms). */
  last: number;
  lastMs: number;
}

/**
One interval record of a running count that runs past the end of the UTC
hour it starts in: when it ran, and its value per field. Enough to divide
the record among the buckets it spans. The record is counted whole in the
rollup that lists it.
*/
export interface CrossingRecord {
  /** The record's start and end, epoch ms. */
  s: number;
  e: number;
  /** The record's value for each summarised field it carries. */
  v: Record<string, number>;
}

/**
What dividing interval records among buckets does to one bucket of an
answer. Never stored: `hc_aggregate` builds it from `crossing`.
*/
export interface SpreadShare {
  /**
  Per field, the change to `FieldStats.sum`: the shares of records that
  started elsewhere and run into the bucket, less the parts of the bucket's
  own records that fall outside it.
  */
  sum: Record<string, number>;
  /** The same change to `durationMs`. */
  ms: number;
  /**
  Per field, how much of the bucket's total comes from records longer than
  an hour: a figure someone wrote for a long stretch, spread evenly over
  it, and not something measured in the bucket.
  */
  long: Record<string, number>;
}

/** `hc_rollup_hour` and `hc_rollup_day`: one (type, origin, bucket). */
export interface BucketRollup {
  /** Records that start in the bucket. */
  records: number;
  /** Per numeric field of the type; empty for a type with none. */
  fields: Record<string, FieldStats>;
  /**
  Total duration of the bucket's interval records, in ms. Absent for an
  instantaneous type.
  */
  durationMs?: number;
  /**
  The UTC hours (hours since the epoch) a record of the bucket starts in,
  ascending. What tells a reader whether another type's rollups -- the
  platform's hourly totals -- have a figure for every hour this one has
  data in. Absent on a rollup written before the field existed.
  */
  hours?: number[];
  /**
  For a running count: the bucket's records that run past the end of the
  UTC hour they start in. In a day rollup, only those that run past the end
  of the day or are longer than an hour. Absent when there are none.
  */
  crossing?: CrossingRecord[];
  /** Only on a rollup built for an answer: see {@link SpreadShare}. */
  spread?: SpreadShare;
}

/** One minute of heart rate. */
export interface HrMinute {
  /** Minute of the hour, 0-59. */
  m: number;
  /** Samples in the minute. */
  n: number;
  min: number;
  max: number;
  /** PLAIN mean of the minute's samples (not time-weighted). */
  mean: number;
}

/** `hc_hr_minute`: one (origin, UTC hour). Minutes with no sample are absent. */
export interface HrHour {
  minutes: HrMinute[];
}

export type SleepStage =
  "AWAKE" | "AWAKE_IN_BED" | "OUT_OF_BED" | "SLEEPING" | "LIGHT" | "DEEP" | "REM" | "UNKNOWN";

/** `hc_sleep_night`: one sleep session, with what was measured during it. */
export interface SleepNight {
  /** The origin app's package name. */
  origin: string;
  startMs: number;
  endMs: number;
  startOffsetMin: number | null;
  endOffsetMin: number | null;
  title: string | null;
  notes: string | null;
  /** Session length: end minus start. */
  inBedMin: number;
  /** In-bed time minus every awake stage. */
  asleepMin: number;
  awakeMin: number;
  /**
  Minutes per stage, for the stages the session has. The union of the
  stages: where two overlap, the shared stretch counts once, for the stage
  that starts first. Never totals more than `inBedMin`.
  */
  stageMin: Partial<Record<SleepStage, number>>;
  /**
  True when the session's stages overlapped or repeated and had to be cut
  to stop a stretch counting twice. Absent on summaries written before the
  field existed.
  */
  stagesOverlap?: boolean;
  /** First instant of a non-awake stage, or null when the session has no stages. */
  onsetMs: number | null;
  /** End of the last non-awake stage: the wake the session's own stages give. */
  stageWakeMs: number | null;
  /**
  The wake placed by heart rate: the start of the first sustained rise above
  the overnight baseline AFTER the pulse was last settled at its sleeping
  level, provided that rise begins within the search window around the
  session's end (ninety minutes before it to an hour after). An awakening
  the sleeper went back to sleep from is not it. Null when there is too
  little heart-rate data, when the pulse never rose for good in the data
  there is, or when it had been up since long before the end.
  */
  hrWakeMs: number | null;
  /**
  The first sustained rise of heart rate at or after the session's end,
  whether or not the pulse settled again afterwards: the first stirring,
  where `hrWakeMs` is the final get-up. Looked for up to an hour after the
  end. Null when there is none, or too little heart rate to say; absent on
  summaries written before the field existed.
  */
  hrFirstRiseMs?: number | null;
  /**
  Heart rate inside the session. `min` and `max` are the lowest and highest
  SAMPLE and `n` the number of samples; `mean` is the mean of the PER-MINUTE
  means, not of the samples. (A summary written before the store carried a
  minute's extremes has the lowest and highest minute MEAN, and the number
  of minutes, instead: the re-roll that follows that change rebuilds it.)
  */
  hr: { min: number; mean: number; max: number; n: number } | null;
  hrv: { median: number; q1: number; q3: number; n: number } | null;
  respiratoryRate: number | null;
  skinTempDelta: number | null;
  restingHr: number | null;
  /**
  True when the session claimed a span so long that only its first 48 hours
  of surrounding data were read to build this summary. The session itself is
  stored whole.
  */
  contextClamped?: boolean;
  /** Kept only when the caller asks for them; always stored. */
  stages: { start: number; end: number; stage: SleepStage }[];
}

/** `hc_exercise_session`: one exercise session, with what was measured during it. */
export interface ExerciseSummary {
  origin: string;
  startMs: number;
  endMs: number;
  startOffsetMin: number | null;
  endOffsetMin: number | null;
  exerciseType: string;
  title: string | null;
  notes: string | null;
  durationMin: number;
  /**
  Heart rate inside the session. `min` and `max` are the lowest and highest
  SAMPLE and `n` the number of samples; `mean` is the mean of the PER-MINUTE
  means, not of the samples.
  */
  hr: { mean: number; max: number; min: number; n: number } | null;
  /**
  Steps, distance (metres) and active energy (kcal) during the session, from
  one origin. A record that straddles an end of the session counts in
  proportion to its overlap, so these may be fractional. Null when nothing
  was recorded, which is not a measured zero.
  */
  steps: number | null;
  distance: number | null;
  /** Active energy during the session, kcal, when the phone has it. */
  energy: number | null;
  /**
  The app whose ActiveCaloriesBurned records `energy` is the sum of, by
  package name; null when `energy` is. Absent on summaries written before
  the field existed.
  */
  energyOrigin?: string | null;
  segments: number;
  laps: number;
  hasRoute: boolean;
  /** Blinded ids of other sessions this one overlaps in time. */
  overlaps: string[];
  /** True when another session has the same start and end to the second. */
  exactDuplicate: boolean;
  /**
  True for a session that looks forgotten rather than long: over three
  hours, with a tail of resting heart rate and no steps, or a tail far below
  the session's own busiest half hour in both pulse and cadence.
  */
  likelyLeftRunning: boolean;
  /**
  Which of the two rules raised `likelyLeftRunning` (`leftRunningReason` in
  `../rules.ts`); null when it is false. Absent on summaries written before
  the second rule was applied here, which only the first can have flagged.
  */
  leftRunningReason?: "resting_tail" | "tail_below_active_phase" | null;
  /**
  True when the session claimed a span so long that only its first 48 hours
  of surrounding data were read to build this summary. The session itself is
  stored whole.
  */
  contextClamped?: boolean;
  /** True for a session of zero length. */
  zeroLength: boolean;
}
