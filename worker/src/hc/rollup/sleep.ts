/**
The nightly summary of one sleep session: `hc_sleep_night`.

A session is the wearable's own record of a night -- when it thinks its
wearer went to bed and got up, and the stages in between. This puts beside
it what else was measured during those hours (heart rate, heart-rate
variability, respiratory rate, skin temperature, resting heart rate), and a
second opinion on the wake time taken from heart rate alone.

### Time arithmetic

- `inBedMin` is the session's length.
- A stage is clipped to the session, and then to whatever earlier stages
  have not already covered: stages are taken in time order, and where two
  overlap (or one is written twice) the stretch they share goes to the one
  that starts first. Stage minutes are therefore the UNION of the stages,
  never more than the time in bed, and `stagesOverlap` says when any such
  clipping happened so the session can be flagged.
- `awakeMin` is the total of the awake stages: AWAKE, AWAKE_IN_BED and
  OUT_OF_BED. `asleepMin` is `inBedMin - awakeMin`, so time no stage covers,
  and UNKNOWN stages, count as asleep. A session with no stages at all is
  asleep throughout: it is what an app that records only bedtime and wake
  time writes.
- `onsetMs` is the start of the first stage that is not an awake one, and
  `stageWakeMs` the end of the last; both null without stages.

### The heart-rate wake (`hrWakeMs`)

A wearable's stage boundaries tend to run early against heart rate: the
last sleep stage ends while the pulse is still at its sleeping level. So the
wake is also placed from heart rate, as the moment the pulse left its
sleeping level FOR GOOD:

 1. Take the per-minute means of the samples from the session's start to
    {@link HR_WAKE_SEARCH_AFTER_MS} past its end. Fewer than
    {@link HR_WAKE_MIN_OVERNIGHT_MINUTES} minutes of data inside the
    session: null.
 2. Baseline = the {@link HR_WAKE_BASELINE_PERCENTILE} quantile of the
    in-session means -- the level of the quietest part of the night, not its
    average, which a restless night would drag upwards. Two levels follow
    from it: "risen" is baseline + {@link HR_WAKE_RISE_BPM}, and "quiet" is
    below baseline + {@link HR_WAKE_HOLD_FRACTION} of that rise.
 3. Find the last time the pulse was SETTLED: the last minute of a quiet
    stretch lasting {@link HR_WAKE_SUSTAIN_MS} or more. Everything up to
    there is the night, including any awakening the sleeper went back to
    sleep from.
 4. After that point the pulse never settles again, by construction. The
    wake is the first risen minute there that begins a sustained rise: one
    spanning {@link HR_WAKE_SUSTAIN_MS} or more, with at least
    {@link HR_WAKE_MIN_RUN_MINUTES} minutes of data, and no hole in the
    data longer than {@link HR_WAKE_MAX_GAP_MS}. A dip of a minute or two
    below "risen", or even below "quiet", does not end it -- a dip long
    enough to matter would have been a settled stretch in step 3.
 5. That rise must begin no earlier than {@link HR_WAKE_SEARCH_BEFORE_MS}
    before the session's end. If it began before that, the pulse had been
    up for a long while and there is no wake near the end to report: null.
    No sustained rise after the last settled stretch: null -- which is the
    answer for a night whose data stops while the pulse is still at its
    sleeping level, however many awakenings came before.

### The first rise after the session (`hrFirstRiseMs`)

`hrWakeMs` is the FINAL get-up: a pulse that rose on waking, settled again
for five minutes or more (lying in, dozing) and rose a second time gives the
second rise. The first is kept beside it. From the session's end to
{@link HR_WAKE_SEARCH_AFTER_MS} after it, `hrFirstRiseMs` is the first risen
minute that begins a rise lasting {@link HR_WAKE_SUSTAIN_MS} or more -- with
the same baseline, the same two levels and the same tolerance of holes as
above -- BEFORE the pulse next settles. Whether it settles afterwards does
not matter, which is the difference. A pulse already up when the session
ends is risen in the session's last minute, so the answer is then the first
minute at or after the end. Null on the conditions of step 1, and when no
such rise begins in that hour.

Because the wake may fall after the session's stated end, the caller should
pass heart rate up to {@link HR_WAKE_SEARCH_AFTER_MS} beyond it. With only
in-session samples the function still works, but a rise in the session's
last few minutes cannot be seen to be sustained.

### Which session a nightly reading belongs to

Respiratory rate, resting heart rate and skin temperature are stamped by the
wearable at one end of the night, and a nap soon after the night would sit
within reach of the night's readings. Each reading is therefore given to ONE
session: of the sessions whose window it falls in, the one whose anchor is
nearest (the earlier session on a tie). `SleepContext.others` is how this
session learns of the rest.

Pure: no D1, no `Env`.
*/

import { recordEndMs, recordStartMs } from "../wire.ts";

import { minuteSeries, summariseHeartRate } from "./hr.ts";
import { mean, quantile, sortedBy } from "./stats.ts";

import type { HrMinutePoint, HrSample } from "./hr.ts";
import type { HcRecord } from "../wire.ts";
import type { SleepNight, SleepStage } from "./types.ts";

const MINUTE_MS = 60_000;

/** What was measured around one sleep session. Each list may run wider than the session. */
export interface SleepContext {
  /**
  Heart rate, ideally to `HR_WAKE_SEARCH_AFTER_MS` past the session's end:
  samples, or one point a minute carrying that minute's extremes (`HrSample`).
  */
  hr: readonly HrSample[];
  /** HeartRateVariabilityRmssd records. */
  hrv: readonly HcRecord[];
  /** RespiratoryRate records. */
  respiratoryRate: readonly HcRecord[];
  /** SkinTemperature records. */
  skinTemperature: readonly HcRecord[];
  /** RestingHeartRate records. */
  restingHeartRate: readonly HcRecord[];
  /**
  The OTHER sleep sessions near this one (a nap after the night, the night
  before a nap), so a reading stamped between two of them goes to one only.
  The session being summarised must not be among them. Left out, the session
  is taken to be alone and may claim a neighbour's readings.
  */
  others?: readonly { startMs: number; endMs: number }[];
}

/** The stages that count as awake. Everything else, UNKNOWN included, is not. */
export const AWAKE_STAGES: ReadonlySet<SleepStage> = new Set<SleepStage>([
  "AWAKE",
  "AWAKE_IN_BED",
  "OUT_OF_BED",
]);

const KNOWN_STAGES: ReadonlySet<string> = new Set<SleepStage>([
  "AWAKE",
  "AWAKE_IN_BED",
  "OUT_OF_BED",
  "SLEEPING",
  "LIGHT",
  "DEEP",
  "REM",
  "UNKNOWN",
]);

/** A stage name a newer SDK adds is kept as time in bed of unknown kind. */
function stageOf(name: unknown): SleepStage {
  return typeof name === "string" && KNOWN_STAGES.has(name) ? (name as SleepStage) : "UNKNOWN";
}

/**
How far from its anchor a nightly reading may be stamped and still belong to
the session, ms. A wearable works its nightly figures out when the night is
over and stamps respiratory rate and resting heart rate at, or shortly
after, the session's end, and the night's skin temperature at its start.
Thirty minutes covers the processing delay and a session whose end was
trimmed afterwards.
*/
export const SLEEP_MATCH_TOLERANCE_MS = 30 * MINUTE_MS;

/**
How long BEFORE the session's end a resting heart rate may be stamped and
still be this night's, ms. Resting heart rate is one figure per day, worked
out once the night is over, so a real one is at or after the end; five
minutes allows for a session whose end was nudged later after the figure was
written. One stamped earlier than that was written while the session was
still running and is some other period's figure (yesterday's, typically).
*/
export const RESTING_HR_BEFORE_END_TOLERANCE_MS = 5 * MINUTE_MS;

/**
The overnight baseline is this quantile of the session's per-minute heart
rate. The tenth percentile is the level of the quietest sleep without being
the single lowest minute, which one dropped beat can set.
*/
export const HR_WAKE_BASELINE_PERCENTILE = 0.1;

/**
A minute counts as risen at this many bpm over the baseline. Twelve sits
between the few bpm heart rate climbs in lighter sleep and dreams and the
fifteen and more of being up and about, so stirring is ignored and waking
is not.
*/
export const HR_WAKE_RISE_BPM = 12;

/**
A minute is "quiet" -- back at the sleeping level -- below this fraction of
{@link HR_WAKE_RISE_BPM} over the baseline. Half, as `detectHrEvents` uses:
once awake the pulse wanders, and a minute a beat or two under the rise
threshold is still a waking pulse, while one most of the way back to the
baseline is not.
*/
export const HR_WAKE_HOLD_FRACTION = 0.5;

/**
How long a rise must last to be a wake, and how long the pulse must stay
quiet to count as settled again, ms. Five minutes: a turn-over or a brief
arousal lifts the pulse for a minute or two and lets it fall back, and a
waking pulse dips for no longer than that.
*/
export const HR_WAKE_SUSTAIN_MS = 5 * MINUTE_MS;

/**
A sustained rise needs at least this many minutes that actually have data,
so two stray readings five minutes apart are not a "rise".
*/
export const HR_WAKE_MIN_RUN_MINUTES = 3;

/**
A hole in the minute series longer than this ends a rise (or a quiet
stretch), ms. Five minutes matches the slowest overnight sampling a wearable
is likely to use; a longer silence says nothing about what the pulse did.
*/
export const HR_WAKE_MAX_GAP_MS = 5 * MINUTE_MS;

/**
The wake must begin no earlier than this before the session's end, ms.
Ninety minutes -- about one sleep cycle -- is as far as a stage-derived end
can plausibly be out; a rise earlier than that is a wakeful spell, not the
wake.
*/
export const HR_WAKE_SEARCH_BEFORE_MS = 90 * MINUTE_MS;

/**
Heart rate is examined up to this long after the session's end, ms. An hour
allows for a session that the wearable closed early and for the rise to be
seen to last.
*/
export const HR_WAKE_SEARCH_AFTER_MS = 60 * MINUTE_MS;

/**
Below this many minutes of heart rate inside the session there is no
baseline worth the name, and `hrWakeMs` is null.
*/
export const HR_WAKE_MIN_OVERNIGHT_MINUTES = 30;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
The session's stages as non-overlapping pieces in time order, and whether
any had to be cut to make them so. See "Time arithmetic" in the module
comment. Unreadable entries are skipped.
*/
function readStages(
  session: HcRecord,
  startMs: number,
  endMs: number,
): { stages: SleepNight["stages"]; overlap: boolean } {
  const list = session.data.stages;
  if (!Array.isArray(list)) return { stages: [], overlap: false };
  const clipped: SleepNight["stages"] = [];
  for (const entry of list as unknown[]) {
    if (!isObject(entry)) continue;
    const from = finite(entry.start);
    const to = finite(entry.end);
    if (from === null || to === null) continue;
    const start = Math.max(from, startMs);
    const end = Math.min(to, endMs);
    if (end > start) clipped.push({ start, end, stage: stageOf(entry.stage) });
  }
  const stages: SleepNight["stages"] = [];
  let overlap = false;
  // In start order everything already covered from a stage's start onwards is
  // one stretch, ending at the latest end seen so far.
  let coveredTo = -Infinity;
  const inOrder = sortedBy(clipped, (a, b) => a.start - b.start || a.end - b.end);
  for (const stage of inOrder) {
    if (stage.start < coveredTo) overlap = true;
    const start = Math.max(stage.start, coveredTo);
    if (stage.end > start) stages.push({ ...stage, start });
    coveredTo = Math.max(coveredTo, stage.end);
  }
  return { stages, overlap };
}

/**
The minutes after the pulse was last settled: after the last minute of a
quiet stretch (every minute below `quietBelow`, no hole too long) that had
by then lasted {@link HR_WAKE_SUSTAIN_MS}.
*/
function afterLastSettled(
  minutes: readonly HrMinutePoint[],
  quietBelow: number,
): readonly HrMinutePoint[] {
  let settledAt = -1;
  let stretchStart: number | null = null;
  let previous = 0;
  for (const [index, minute] of minutes.entries()) {
    if (minute.mean >= quietBelow) {
      stretchStart = null;
      continue;
    }
    if (stretchStart === null || minute.t - previous > HR_WAKE_MAX_GAP_MS) stretchStart = minute.t;
    previous = minute.t;
    if (minute.t + MINUTE_MS - stretchStart >= HR_WAKE_SUSTAIN_MS) settledAt = index;
  }
  return minutes.slice(settledAt + 1);
}

/**
How far the rise that opens at `minutes[from]` runs: through every following
minute until a hole in the data too long to see across. Minutes below
`quietBelow` on the way are passed over, not counted -- the caller's minutes
hold no settled stretch, so such a dip is brief.
*/
function riseFrom(
  minutes: readonly HrMinutePoint[],
  from: number,
  quietBelow: number,
): { last: number; held: number; next: number } {
  let seen = minutes[from]?.t ?? 0;
  let last = seen;
  let held = 1;
  let next = from + 1;
  for (; next < minutes.length; next += 1) {
    const minute = minutes[next];
    if (minute === undefined || minute.t - seen > HR_WAKE_MAX_GAP_MS) break;
    seen = minute.t;
    if (minute.mean < quietBelow) continue;
    last = minute.t;
    held += 1;
  }
  return { last, held, next };
}

/**
The start of the first sustained rise in `minutes`, which hold no settled
stretch: a minute at or above `risen`, followed without a long hole by
enough minutes at or above `quietBelow`. Null when there is none.
*/
function firstSustainedRise(
  minutes: readonly HrMinutePoint[],
  risen: number,
  quietBelow: number,
): number | null {
  let index = 0;
  while (index < minutes.length) {
    const opener = minutes[index];
    if (opener === undefined || opener.mean < risen) {
      index += 1;
      continue;
    }
    const rise = riseFrom(minutes, index, quietBelow);
    const sustained =
      rise.last + MINUTE_MS - opener.t >= HR_WAKE_SUSTAIN_MS &&
      rise.held >= HR_WAKE_MIN_RUN_MINUTES;
    if (sustained) return opener.t;
    index = rise.next;
  }
  return null;
}

/** The night's minute series and the two levels a wake is judged by, or null without a baseline. */
function wakeLevels(
  hr: readonly HrSample[],
  startMs: number,
  endMs: number,
): { minutes: HrMinutePoint[]; risen: number; quietBelow: number } | null {
  const searchEnd = endMs + HR_WAKE_SEARCH_AFTER_MS;
  const minutes = minuteSeries(hr.filter((sample) => sample.t >= startMs && sample.t <= searchEnd));
  const overnight = minutes.filter((minute) => minute.t < endMs).map((minute) => minute.mean);
  if (overnight.length < HR_WAKE_MIN_OVERNIGHT_MINUTES) return null;
  const baseline = quantile(overnight, HR_WAKE_BASELINE_PERCENTILE);
  if (baseline === null) return null;
  return {
    minutes,
    risen: baseline + HR_WAKE_RISE_BPM,
    quietBelow: baseline + HR_WAKE_RISE_BPM * HR_WAKE_HOLD_FRACTION,
  };
}

/** The heart-rate wake. See the module comment. `hr` need not be sorted. */
export function hrWake(hr: readonly HrSample[], startMs: number, endMs: number): number | null {
  const levels = wakeLevels(hr, startMs, endMs);
  if (levels === null) return null;
  const { minutes, risen, quietBelow } = levels;
  const wake = firstSustainedRise(afterLastSettled(minutes, quietBelow), risen, quietBelow);
  return wake !== null && wake >= endMs - HR_WAKE_SEARCH_BEFORE_MS ? wake : null;
}

/**
The minutes from `minutes[0]` up to the pulse next being settled: up to,
and not including, the first quiet stretch that lasts
{@link HR_WAKE_SUSTAIN_MS}.
*/
function untilSettled(
  minutes: readonly HrMinutePoint[],
  quietBelow: number,
): readonly HrMinutePoint[] {
  let stretchFrom: number | null = null;
  let previous = 0;
  for (const [index, minute] of minutes.entries()) {
    if (minute.mean >= quietBelow) {
      stretchFrom = null;
      continue;
    }
    if (stretchFrom === null || minute.t - previous > HR_WAKE_MAX_GAP_MS) stretchFrom = index;
    previous = minute.t;
    const from = minutes[stretchFrom]?.t ?? minute.t;
    if (minute.t + MINUTE_MS - from >= HR_WAKE_SUSTAIN_MS) return minutes.slice(0, stretchFrom);
  }
  return minutes;
}

/**
The first sustained rise at or after the session's end, whether or not the
pulse settles again after it. See the module comment. `hr` need not be
sorted.
*/
export function hrFirstRise(
  hr: readonly HrSample[],
  startMs: number,
  endMs: number,
): number | null {
  const levels = wakeLevels(hr, startMs, endMs);
  if (levels === null) return null;
  const { risen, quietBelow } = levels;
  // From the minute the session ends in: a pulse already up then is "at the end".
  let minutes: readonly HrMinutePoint[] = levels.minutes.filter(
    (minute) => minute.t + MINUTE_MS > endMs,
  );
  while (minutes.length > 0) {
    // One stretch between two settlings at a time: a rise is sustained inside
    // it or not at all.
    const stretch = untilSettled(minutes, quietBelow);
    const rise = firstSustainedRise(stretch, risen, quietBelow);
    if (rise !== null) return Math.max(rise, endMs);
    // Past the settled stretch that ended this one, which is at least a minute long.
    minutes = minutes.slice(Math.max(stretch.length, 1));
  }
  return null;
}

/** Where a nightly reading is expected, and how far either side of it counts. */
interface Anchor {
  ms: number;
  /** How long before `ms` a reading may be stamped. */
  before: number;
  /** How long after. */
  after: number;
}

function within(time: number, anchor: Anchor): boolean {
  return time >= anchor.ms - anchor.before && time <= anchor.ms + anchor.after;
}

/**
True when a reading stamped at `time` belongs to another session rather
than this one: it is inside that session's window too, and that session's
anchor is nearer -- or as near and earlier, so a tie has one winner.
*/
function claimedElsewhere(time: number, anchor: Anchor, rivals: readonly number[]): boolean {
  const own = Math.abs(time - anchor.ms);
  return rivals.some((rival) => {
    const theirs = Math.abs(time - rival);
    return (
      within(time, { ...anchor, ms: rival }) &&
      (theirs < own || (theirs === own && rival < anchor.ms))
    );
  });
}

/**
The value of the reading that belongs at `anchor`: of the records that
actually carry a value (`valueOf` not null), are stamped inside the anchor's
window and are not another session's, the session's own origin's before any
other app's; among those the nearest in time, then the one written first.
*/
function anchored(
  records: readonly HcRecord[],
  anchor: Anchor,
  rivals: readonly number[],
  origin: string,
  valueOf: (record: HcRecord) => number | null,
): number | null {
  const candidates: { record: HcRecord; value: number }[] = [];
  for (const record of records) {
    const time = recordStartMs(record);
    const value = valueOf(record);
    const eligible =
      value !== null && within(time, anchor) && !claimedElsewhere(time, anchor, rivals);
    if (eligible) candidates.push({ record, value });
  }
  const distance = (record: HcRecord): number => Math.abs(recordStartMs(record) - anchor.ms);
  const foreign = (record: HcRecord): number => (record.origin === origin ? 0 : 1);
  const [best] = sortedBy(
    candidates,
    (a, b) =>
      foreign(a.record) - foreign(b.record) ||
      distance(a.record) - distance(b.record) ||
      a.record.lastModified - b.record.lastModified,
  );
  return best?.value ?? null;
}

/** Records that start inside the session, the session's own origin's if it has any. */
function inSession(
  records: readonly HcRecord[],
  startMs: number,
  endMs: number,
  origin: string,
  carries: (record: HcRecord) => boolean,
): HcRecord[] {
  const inside = records.filter((record) => {
    const at = recordStartMs(record);
    return at >= startMs && at <= endMs && carries(record);
  });
  const own = inside.filter((record) => record.origin === origin);
  return own.length > 0 ? own : inside;
}

function deltasOf(record: HcRecord): number[] {
  const list = record.data.deltas;
  if (!Array.isArray(list)) return [];
  const deltas: number[] = [];
  for (const entry of list as unknown[]) {
    const delta = isObject(entry) ? finite(entry.delta) : null;
    if (delta !== null) deltas.push(delta);
  }
  return deltas;
}

function scalars(records: readonly HcRecord[], field: string): number[] {
  const values: number[] = [];
  for (const record of records) {
    const value = finite(record.data[field]);
    if (value !== null) values.push(value);
  }
  return values;
}

/** Minutes per stage, the awake total, and the first and last instants not awake. */
function stageTotals(stages: SleepNight["stages"]): {
  stageMin: Partial<Record<SleepStage, number>>;
  awakeMs: number;
  onsetMs: number | null;
  stageWakeMs: number | null;
} {
  const stageMs = new Map<SleepStage, number>();
  let awakeMs = 0;
  let onsetMs: number | null = null;
  let stageWakeMs: number | null = null;
  for (const { start, end, stage } of stages) {
    stageMs.set(stage, (stageMs.get(stage) ?? 0) + (end - start));
    if (AWAKE_STAGES.has(stage)) {
      awakeMs += end - start;
      continue;
    }
    onsetMs = Math.min(onsetMs ?? start, start);
    stageWakeMs = Math.max(stageWakeMs ?? end, end);
  }
  const stageMin: Partial<Record<SleepStage, number>> = {};
  for (const [stage, ms] of stageMs) stageMin[stage] = ms / MINUTE_MS;
  return { stageMin, awakeMs, onsetMs, stageWakeMs };
}

/**
Summarise one SleepSession record against what was measured around it.

- `hr`: heart rate inside the session; `min` and `max` are the lowest and
  highest SAMPLE, `mean` is the mean of per-minute means (see
  `summariseHeartRate`), `n` the sample count.
- `hrv`: median and quartiles (linear interpolation, see `quantile`) of the
  RMSSD readings timed inside the session -- the session's own origin's when
  it wrote any, otherwise every app's.
- `respiratoryRate`: the reading stamped nearest the session's END within
  {@link SLEEP_MATCH_TOLERANCE_MS}; failing that, the mean of the readings
  timed inside the session (a wearable that logs it through the night).
- `restingHr`: the reading stamped nearest the session's END, no more than
  {@link RESTING_HR_BEFORE_END_TOLERANCE_MS} before it and no more than
  {@link SLEEP_MATCH_TOLERANCE_MS} after. No fallback: resting heart rate
  is a daily figure, and one from mid-session is not this night's.
- `skinTempDelta`: the mean of the deltas of the SkinTemperature record that
  starts nearest the session's START within the tolerance; failing that, of
  the records that start inside the session.

In each match only a record that actually carries the value is considered,
a record from the session's own origin wins over another app's, and a
reading nearer another session's anchor (`context.others`) is left to that
session. Anything not measured is null.
*/
export function summariseSleep(session: HcRecord, context: SleepContext): SleepNight {
  const startMs = recordStartMs(session);
  const endMs = recordEndMs(session);
  const { origin } = session;
  const { stages, overlap } = readStages(session, startMs, endMs);
  const { stageMin, awakeMs, onsetMs, stageWakeMs } = stageTotals(stages);
  const inBedMs = endMs - startMs;

  const atEnd = { ms: endMs, before: SLEEP_MATCH_TOLERANCE_MS, after: SLEEP_MATCH_TOLERANCE_MS };
  const atStart = { ...atEnd, ms: startMs };
  const others = context.others ?? [];
  const otherEnds = others.map((other) => other.endMs);
  const otherStarts = others.map((other) => other.startMs);
  const rateOf = (record: HcRecord): number | null => finite(record.data.rate);
  const deltaOf = (record: HcRecord): number | null => mean(deltasOf(record));

  const rmssd = scalars(
    inSession(context.hrv, startMs, endMs, origin, (record) => finite(record.data.rmssd) !== null),
    "rmssd",
  );
  const respiratoryRate =
    anchored(context.respiratoryRate, atEnd, otherEnds, origin, rateOf) ??
    mean(
      scalars(
        inSession(context.respiratoryRate, startMs, endMs, origin, (r) => rateOf(r) !== null),
        "rate",
      ),
    );
  const skinTempDelta =
    anchored(context.skinTemperature, atStart, otherStarts, origin, deltaOf) ??
    mean(
      inSession(
        context.skinTemperature,
        startMs,
        endMs,
        origin,
        (r) => deltaOf(r) !== null,
      ).flatMap((record) => deltasOf(record)),
    );
  const restingHr = anchored(
    context.restingHeartRate,
    { ...atEnd, before: RESTING_HR_BEFORE_END_TOLERANCE_MS },
    otherEnds,
    origin,
    (record) => finite(record.data.bpm),
  );

  return {
    origin,
    startMs,
    endMs,
    startOffsetMin: session.startOffsetMin ?? null,
    endOffsetMin: session.endOffsetMin ?? null,
    title: text(session.data.title),
    notes: text(session.data.notes),
    inBedMin: inBedMs / MINUTE_MS,
    asleepMin: (inBedMs - awakeMs) / MINUTE_MS,
    awakeMin: awakeMs / MINUTE_MS,
    stageMin,
    stagesOverlap: overlap,
    onsetMs,
    stageWakeMs,
    hrWakeMs: hrWake(context.hr, startMs, endMs),
    hrFirstRiseMs: hrFirstRise(context.hr, startMs, endMs),
    hr: summariseHeartRate(context.hr, startMs, endMs),
    hrv:
      rmssd.length === 0
        ? null
        : {
            median: quantile(rmssd, 0.5) ?? 0,
            q1: quantile(rmssd, 0.25) ?? 0,
            q3: quantile(rmssd, 0.75) ?? 0,
            n: rmssd.length,
          },
    respiratoryRate,
    skinTempDelta,
    restingHr,
    stages,
  };
}
