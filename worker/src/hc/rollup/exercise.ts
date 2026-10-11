/**
 * The summary of one exercise session: `hc_exercise_session`.
 *
 * Beside the session's own facts (type, length, segments, laps, whether it has
 * a route) this puts what was measured while it ran, and four judgements about
 * the session itself -- does it overlap another, is it an exact copy of
 * another, is it of zero length, was it probably left running (and by which
 * of the two rules). The judgements
 * are made by `../rules.ts`, which owns every such rule and threshold; nothing
 * is decided here that a query tool could decide differently.
 *
 * ### What counts as "during the session"
 *
 * - Heart rate: what was measured in `[start, end]`. `min` and `max` are the
 *   lowest and highest sample, `mean` is the mean of the per-minute means (see
 *   `summariseHeartRate`), and `n` is the sample count.
 * - Steps, distance, active energy: the share of each record that falls in
 *   `[start, end]`. A record wholly inside counts whole; one that straddles an
 *   end of the session counts in proportion to the overlap (`quantityWithin`
 *   in `../rules.ts`, the helper the left-running rule uses too), so a
 *   five-minute step record that began two minutes before the session gives
 *   it three fifths of its steps, not all or none. An instantaneous record
 *   counts whole when it is inside. Each total is null when no record has any
 *   share in the session, which is not the same as a measured zero.
 *
 *   This is deliberately NOT the start-time bucketing the hour and day
 *   rollups use: a session is minutes long, and whole records at its edges
 *   would be a large part of it.
 *
 * Pure: no D1, no `Env`.
 */

import {
  isExactDuplicateSession,
  isZeroLengthSession,
  leftRunningReason,
  quantityWithin,
  sessionsOverlap,
} from "../rules.ts";
import { recordEndMs, recordStartMs } from "../wire.ts";

import { summariseHeartRate } from "./hr.ts";

import type { HrSample } from "./hr.ts";
import type { HcRecord } from "../wire.ts";
import type { ExerciseSummary } from "./types.ts";

const MINUTE_MS = 60_000;

/**
 * What was measured around one exercise session. Each list may run wider than
 * the session.
 *
 * `steps`, `distance` and `activeCalories` are SUMMED, so each must hold ONE
 * origin's records: a phone and a watch both counting the same walk would
 * otherwise be added together. Choosing the origin is the caller's job.
 */
export interface ExerciseContext {
  /** Heart rate: samples, or one point a minute carrying that minute's extremes. */
  hr: readonly HrSample[];
  /** Steps records, from a single origin. */
  steps: readonly HcRecord[];
  /** Distance records, from a single origin. */
  distance: readonly HcRecord[];
  /** ActiveCaloriesBurned records, from a single origin. */
  activeCalories: readonly HcRecord[];
  /**
   * The OTHER exercise sessions near this one, by blinded id. The session
   * being summarised must not be among them: it would be reported as its own
   * overlap and its own exact duplicate.
   */
  others: readonly { idBlind: string; startMs: number; endMs: number }[];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Summarise one ExerciseSession record against what was measured around it. */
export function summariseExercise(session: HcRecord, context: ExerciseContext): ExerciseSummary {
  const startMs = recordStartMs(session);
  const endMs = recordEndMs(session);
  const span = { startMs, endMs };
  const energy = quantityWithin(context.activeCalories, "energy", startMs, endMs);
  // One origin's records by contract, so any of them that reaches into the
  // session names the app the energy is from.
  const energyFrom = context.activeCalories.find(
    (record) => recordStartMs(record) <= endMs && recordEndMs(record) >= startMs,
  );
  const leftRunning = leftRunningReason(span, context.hr, context.steps);

  return {
    origin: session.origin,
    startMs,
    endMs,
    startOffsetMin: session.startOffsetMin ?? null,
    endOffsetMin: session.endOffsetMin ?? null,
    // A session the phone sent with no type is kept, under the SDK's own name for "other".
    exerciseType: text(session.data.exerciseType) ?? "OTHER_WORKOUT",
    title: text(session.data.title),
    notes: text(session.data.notes),
    durationMin: (endMs - startMs) / MINUTE_MS,
    hr: summariseHeartRate(context.hr, startMs, endMs),
    steps: quantityWithin(context.steps, "count", startMs, endMs),
    distance: quantityWithin(context.distance, "distance", startMs, endMs),
    energy,
    energyOrigin: energy === null ? null : (energyFrom?.origin ?? null),
    segments: lengthOf(session.data.segments),
    laps: lengthOf(session.data.laps),
    hasRoute: lengthOf(session.data.route) > 0,
    overlaps: context.others.filter((other) => sessionsOverlap(span, other)).map((o) => o.idBlind),
    exactDuplicate: context.others.some((other) => isExactDuplicateSession(span, other)),
    likelyLeftRunning: leftRunning !== null,
    leftRunningReason: leftRunning,
    zeroLength: isZeroLengthSession(span),
  };
}
