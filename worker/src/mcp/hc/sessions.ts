/**
 * Stored sleep and exercise summaries, grouped into stretches of time.
 *
 * Which sessions are the same stretch -- overlapping, or written twice -- is
 * decided by `mergeOverlappingSessions` in `worker/src/hc/rules.ts`, the one
 * module for those rules. This only carries the stored summaries to it and
 * back, and tells it what the rules need to know about each: its kind (an
 * exercise type; two different activities that overlap are not one), whether
 * it was flagged as left running (such a session is never merged: it would
 * swallow every real workout that happened while it ran), and the bound past
 * which a session of this record type stands alone.
 *
 * One more thing is decided over the grouped rows, here because it needs them
 * all: which sleep of a date the day's resting heart rate is shown on
 * ({@link restingHrByDay}).
 */

import {
  EXERCISE_MERGE_MAX_MS,
  SLEEP_MERGE_MAX_MS,
  isOverThreeHours,
  mergeOverlappingSessions,
} from "../../hc/rules.ts";

import { compareText, fileUnder } from "./util.ts";

import type { LeftRunningReason, MergedSession, SessionMergeOptions } from "../../hc/rules.ts";
import type { HcRecord } from "../../hc/wire.ts";

export type { LeftRunningReason } from "../../hc/rules.ts";

export interface Stored<Summary> {
  id: string;
  summary: Summary;
}

export interface Spanned {
  origin: string;
  startMs: number;
  endMs: number;
  /** Exercise only: sessions of different types are never merged. */
  exerciseType?: string;
  /** Exercise only: a session flagged as left running is never merged. */
  likelyLeftRunning?: boolean;
}

export interface Group<Summary> {
  merged: MergedSession;
  primary: Stored<Summary>;
  members: Stored<Summary>[];
}

const TYPE_SLEEP = "SleepSession";

/**
 * Stored summaries grouped by the session rules. The rules take records, so
 * each summary is handed over as the record it summarises: its id, origin and
 * span, which is all they read. Which member then speaks for a group is
 * decided here, where the summaries are: see {@link speaker}.
 *
 * `leftRunningReadable` is false for a call whose policy withholds the
 * left-running flag (it is read off heart rate and steps). The grouping must
 * not then depend on it, or the shape of the answer would give it away: every
 * session over three hours stands alone instead, which the session's own
 * times decide.
 */
export function groupSessions<Summary extends Spanned>(
  type: string,
  stored: readonly Stored<Summary>[],
  leftRunningReadable = true,
): Group<Summary>[] {
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  const records: HcRecord[] = stored.map((entry) => ({
    id: entry.id,
    type,
    origin: entry.summary.origin,
    lastModified: 0,
    start: entry.summary.startMs,
    end: entry.summary.endMs,
    data: {},
  }));
  const options: SessionMergeOptions = {
    kindOf: (record) => (byId.get(record.id)?.summary.exerciseType ?? "").toUpperCase(),
    standsAlone: (record) => {
      const summary = byId.get(record.id)?.summary;
      if (summary === undefined || type === TYPE_SLEEP) return false;
      return leftRunningReadable ? summary.likelyLeftRunning === true : isOverThreeHours(summary);
    },
    maxMs: type === TYPE_SLEEP ? SLEEP_MERGE_MAX_MS : EXERCISE_MERGE_MAX_MS,
  };
  const groups: Group<Summary>[] = [];
  const all = mergeOverlappingSessions(records, options);
  for (const merged of all) {
    const members = merged.sessions.flatMap((record) => {
      const member = byId.get(record.id);
      return member === undefined ? [] : [member];
    });
    const primary = speaker(members);
    if (primary !== undefined) groups.push({ merged, primary, members });
  }
  return groups;
}

const SECOND_MS = 1000;

/** How long a session ran, in whole seconds: what "equally long" is judged by. */
function seconds(summary: Spanned): number {
  return Math.floor((summary.endMs - summary.startMs) / SECOND_MS);
}

/**
 * How much a summary carries beyond its times: one for every figure that is
 * there (a heart rate, steps, a route ...). Two copies of one workout are
 * equally long, and the copy from the app that measured it is the one worth
 * describing the row by.
 */
function richness(summary: object): number {
  let count = 0;
  for (const value of Object.values(summary)) {
    if (value !== null && value !== undefined && value !== false) count += 1;
  }
  return count;
}

/**
 * The member that describes a group's row: the longest; among equally long
 * ones the one carrying the most (see {@link richness}), then the lower origin
 * name, then the lower id -- so the choice is the same on every call.
 */
function speaker<Summary extends Spanned>(
  members: readonly Stored<Summary>[],
): Stored<Summary> | undefined {
  let best = members[0];
  for (const member of members) {
    if (best === undefined) break;
    const order =
      seconds(best.summary) - seconds(member.summary) ||
      richness(best.summary) - richness(member.summary) ||
      compareText(member.summary.origin, best.summary.origin) ||
      compareText(member.id, best.id);
    if (order < 0) best = member;
  }
  return best;
}

// --------------------------------------------------------------------------
// Resting heart rate: whose it is
// --------------------------------------------------------------------------

/** What the day's resting heart rate reads of a stored night. */
interface Rested extends Spanned {
  restingHr: number | null;
}

/** The longer of two rows; of equally long ones the earlier, then the lower id. */
function longerRow<Summary extends Rested>(
  left: Group<Summary>,
  right: Group<Summary>,
): Group<Summary> {
  const order =
    seconds(right.primary.summary) - seconds(left.primary.summary) ||
    left.primary.summary.startMs - right.primary.summary.startMs ||
    compareText(left.primary.id, right.primary.id);
  return order <= 0 ? left : right;
}

/**
 * The resting heart rate each sleep row carries, by the key of the session
 * that describes the row.
 *
 * A stored night holds the reading stamped at its own end
 * (`summariseSleep`), and that is right for a date with one sleep. But resting
 * heart rate is ONE figure a day, and a wearable that writes one record a day
 * stamps it at the end of the day's LAST sleep: once a nap is recorded the
 * record moves from the night's end to the nap's, and the stored night has
 * none while the nap has the day's. So, among the rows that ended on one date
 * (`dayOf`, the `date` a row carries):
 *
 *  - the longest row keeps the reading it has, and nothing moves: a date with
 *    one sleep, and a date whose night has a reading of its own whatever a nap
 *    has (several records in the day);
 *  - when the longest has none and another row of the date has one, the
 *    longest gets it and that row gives it up -- it is the day's figure, and
 *    it is said once. Of several such rows the one that ended last gives: that
 *    is where a once-a-day record is stamped.
 *
 * A session longer than `SLEEP_MERGE_MAX_MS` was never closed: it is not a
 * night, so it neither takes a reading nor gives one.
 *
 * Decided when an answer is made, from the rows handed in: the stored
 * summaries are not changed. For the answer not to depend on where a range
 * was cut, the caller hands in EVERY sleep of each date it answers about, the
 * ones outside its range included (`sleep_sessions` reads them). The map is
 * therefore keyed by every session of a row, not only the one that describes
 * it: a caller whose own rows were grouped from fewer sessions still finds
 * each of them here.
 */
export function restingHrByDay<Summary extends Rested>(
  groups: readonly Group<Summary>[],
  dayOf: (ms: number) => string,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const days = new Map<string, Group<Summary>[]>();
  for (const group of groups) {
    const { summary } = group.primary;
    setRow(out, group, summary.restingHr);
    if (summary.endMs - summary.startMs > SLEEP_MERGE_MAX_MS) continue;
    fileUnder(days, dayOf(summary.endMs), group);
  }
  for (const rows of days.values()) {
    const longest = longestRow(rows);
    const giver = lastRowWithReading(rows);
    const moves =
      longest !== undefined && giver !== undefined && longest.primary.summary.restingHr === null;
    if (!moves) continue;
    setRow(out, longest, giver.primary.summary.restingHr);
    setRow(out, giver, null);
  }
  return out;
}

/** One row's figure, under the key of every session the row stands for. */
function setRow<Summary extends Rested>(
  out: Map<string, number | null>,
  row: Group<Summary>,
  value: number | null,
): void {
  for (const member of row.members) out.set(member.id, value);
}

/** The longest of a date's rows: see {@link longerRow}. */
function longestRow<Summary extends Rested>(
  rows: readonly Group<Summary>[],
): Group<Summary> | undefined {
  let longest = rows[0];
  for (const row of rows) {
    if (longest !== undefined) longest = longerRow(longest, row);
  }
  return longest;
}

/** Of a date's rows that carry a resting heart rate, the one that ended last. */
function lastRowWithReading<Summary extends Rested>(
  rows: readonly Group<Summary>[],
): Group<Summary> | undefined {
  let last: Group<Summary> | undefined;
  for (const row of rows) {
    const { restingHr, endMs } = row.primary.summary;
    if (restingHr !== null && endMs > (last?.primary.summary.endMs ?? -Infinity)) last = row;
  }
  return last;
}

// --------------------------------------------------------------------------
// Left running: why
// --------------------------------------------------------------------------

/** What the left-running flag reads of a stored exercise summary. */
interface LeftRunningSubject {
  likelyLeftRunning: boolean;
  leftRunningReason?: LeftRunningReason | null;
}

/**
 * Why each flagged session was flagged, by summary key.
 *
 * Both rules are applied when a session's summary is built
 * (`leftRunningReason` in `worker/src/hc/rules.ts`), so the flag and its
 * reason are stored and every tool reads the same ones: nothing is judged, and
 * nothing is read, when a tool answers. A summary written before the reason
 * was stored was flagged by the only rule there was then.
 *
 * The flag is heart rate and steps, so a caller whose policy withholds either
 * must not report it: `leftRunningReadable` in the tools decides.
 */
export function leftRunningReasons<Summary extends LeftRunningSubject>(
  stored: readonly Stored<Summary>[],
): Map<string, LeftRunningReason> {
  const reasons = new Map<string, LeftRunningReason>();
  for (const { id, summary } of stored) {
    if (summary.likelyLeftRunning) reasons.set(id, summary.leftRunningReason ?? "resting_tail");
  }
  return reasons;
}
