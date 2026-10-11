/**
 * Owner edits to an event's title win, for ever.
 *
 * The owner may rename a calendar event Healthy wrote. That edit must survive
 * every later sync; Healthy's own titles may still be replaced by newer ones. So
 * each row records what title Healthy last wrote (`calendar_events.title_digest`,
 * 0015), and every run compares it with the `summary` Google holds now -- which
 * the sync's own `events.list` already returned, so this costs no extra call.
 *
 *   - **Equal**: the title is still Healthy's. A write may replace it with the
 *     title the model computes now.
 *   - **Different**: the owner edited it. Every write to that event leaves
 *     `summary` out, so theirs stays, and the row keeps recording what Healthy
 *     last wrote.
 *   - **Changed back to exactly what Healthy last wrote**: equal again, so Healthy
 *     owns it again. Chosen deliberately: an owner who restores the original has
 *     said "I'm done with my version", and the only alternative -- freezing a
 *     title because it was once edited -- would leave a stale practitioner or
 *     visit type on the calendar with no way for the owner to hand it back. If
 *     Healthy's computed title moved meanwhile, the plan patches it
 *     (`title_drift`).
 *
 * A ghost follows the same rule. When the owner owns the title, the ghost patch
 * does not add "Cancelled: " -- the cancellation still shows as the grey colour,
 * the event no longer blocking time, and the "no longer on the schedule" line.
 *
 * **Legacy rows** (no digest yet, i.e. every row before 0015). Before this
 * feature every title on the calendar was written by Healthy, and the owner has
 * not been editing titles, so the seed leans towards "Healthy's":
 *
 *   1. Google's title equals the title the model computes now: Healthy's. Seed it.
 *   2. Otherwise, if the row's fingerprint still matches the model's -- Healthy
 *      provably last wrote this very model, title included -- the difference can
 *      only be an owner edit: owner-owned, recording the model's title as what
 *      Healthy wrote.
 *   3. Otherwise provenance is unknown (the model moved since the last write, so
 *      what Healthy last wrote cannot be recovered): Google's title is taken as
 *      Healthy's and the write that follows updates it. This is the "the owner
 *      has not edited titles yet" assumption, and it misfires only for an edit
 *      made before 0015 *and* an upstream change to the same appointment since.
 *
 * The digest is keyed (`Blinder.digest`), because a title names a practitioner
 * and a plain hash of a guessable string is a confirmation oracle. It is salted
 * with the health system id only -- not the event key, which `rekey` changes when
 * the FHIR pass adopts a portal row, while the event (and its title) stays.
 *
 * Nothing here logs a title.
 */

import type { Blinder } from "../db/blind.ts";
import type { CalendarEventRow } from "../db/rows.ts";
import type { CalendarEventBody, CalendarEventModel, EventRecord } from "../google/types.ts";

const TITLE_DOMAIN = "calendar_events.title_digest";

/** The stored digest of one title. */
export function titleDigest(
  blinder: Blinder,
  healthSystemId: string,
  title: string,
): Promise<string> {
  return blinder.digest(TITLE_DOMAIN, `${healthSystemId}\u{0}${title}`);
}

/** Per event key: the digests the plan compares. */
export interface TitleDigests {
  /** Digest of the `summary` Google holds now, or null with no event listed. */
  google: string | null;
  /** Digest of the active model's title, or null with no model. */
  active: string | null;
  /** Digest of the ghost model's title, or null with no ghost variant. */
  ghost: string | null;
}

/**
 * Every digest the plan needs for one health system's keys, computed up front so
 * the plan itself stays synchronous and pure.
 *
 * `keyOf` pairs an event with its key the way the caller's plan will.
 */
export async function titleDigestsFor(
  blinder: Blinder,
  healthSystemId: string,
  input: {
    events: readonly EventRecord[];
    keyOf: (event: EventRecord) => string | null;
    models: ReadonlyMap<string, CalendarEventModel>;
    ghosts: ReadonlyMap<string, CalendarEventModel>;
  },
): Promise<Map<string, TitleDigests>> {
  const out = new Map<string, TitleDigests>();
  const slot = (key: string): TitleDigests => {
    let entry = out.get(key);
    if (entry === undefined) {
      entry = { google: null, active: null, ghost: null };
      out.set(key, entry);
    }
    return entry;
  };
  for (const event of input.events) {
    const key = input.keyOf(event);
    if (key === null) continue;
    // Last listed wins, exactly as `planChanges` pairs a duplicate key.
    slot(key).google = await titleDigest(blinder, healthSystemId, event.summary ?? "");
  }
  for (const [key, model] of input.models) {
    slot(key).active = await titleDigest(blinder, healthSystemId, model.title);
  }
  for (const [key, model] of input.ghosts) {
    slot(key).ghost = await titleDigest(blinder, healthSystemId, model.title);
  }
  return out;
}

/** Who holds an event's title, and what the row should record. */
export interface TitleOwnership {
  /** True when the owner edited the title: writes must leave `summary` out. */
  ownerEdited: boolean;
  /**
   * The digest of what Healthy last wrote, as the row should record it --
   * including a legacy row's freshly seeded value. Null when nothing is known
   * (no row, or no event to compare).
   */
  lastWritten: string | null;
}

/**
 * Decide who owns one event's title. Pure; see the module comment for the rules.
 *
 * `variantTitle` is the digest of the title Healthy would write now (active or
 * ghost), and `fingerprintMatches` says whether the row's fingerprint is that
 * variant's -- only consulted for a legacy row.
 */
export function titleOwnership(
  row: CalendarEventRow | undefined,
  googleTitle: string | null,
  variantTitle: string | null,
  fingerprintMatches: boolean,
): TitleOwnership {
  if (row === undefined || googleTitle === null) return { ownerEdited: false, lastWritten: null };
  const recorded = row.title_digest;
  if (recorded !== null) {
    return { ownerEdited: googleTitle !== recorded, lastWritten: recorded };
  }
  if (variantTitle === null || googleTitle === variantTitle) {
    return { ownerEdited: false, lastWritten: googleTitle };
  }
  return fingerprintMatches
    ? { ownerEdited: true, lastWritten: variantTitle }
    : { ownerEdited: false, lastWritten: googleTitle };
}

/**
 * A write body with `summary` taken out when the owner holds the title.
 *
 * Google's `events.patch` leaves a field it is not sent alone, so leaving
 * `summary` out is exactly "keep whatever title the event has".
 */
export function titledBody(
  body: CalendarEventBody,
  entry: { keepTitle: boolean },
): Partial<CalendarEventBody> {
  if (!entry.keepTitle) return body;
  const rest: Partial<CalendarEventBody> = { ...body };
  delete rest.summary;
  return rest;
}

/**
 * The legacy rows an `unchanged` entry left without a title digest, with the one
 * the plan worked out for them. Written even though nothing else about the row
 * is: a row that stayed NULL would read the owner's first edit as Healthy's own
 * title and overwrite it on the next change.
 */
export function titleSeeds(
  unchanged: readonly { key: string; titleDigest: string | null }[],
  rows: readonly CalendarEventRow[],
): { eventKey: string; titleDigest: string }[] {
  const unseeded = new Set(
    rows.filter((row) => row.title_digest === null).map((row) => row.event_key),
  );
  return unchanged.flatMap((entry) =>
    entry.titleDigest !== null && unseeded.has(entry.key)
      ? [{ eventKey: entry.key, titleDigest: entry.titleDigest }]
      : [],
  );
}
