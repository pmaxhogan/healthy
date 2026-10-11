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
 */

import {
  EXERCISE_MERGE_MAX_MS,
  SLEEP_MERGE_MAX_MS,
  isOverThreeHours,
  mergeOverlappingSessions,
} from "../../hc/rules.ts";

import { compareText } from "./util.ts";

import type { MergedSession, SessionMergeOptions } from "../../hc/rules.ts";
import type { HcRecord } from "../../hc/wire.ts";

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
