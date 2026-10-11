// The diff decides what happens to a real appointment on a real calendar, so
// every branch of the table in `plan.ts` has a test and each one says which
// asymmetry it is protecting.

import { describe, expect, it } from "vitest";

import { healthyBlock } from "../../../src/sync/description.ts";
import { eventKeyOf, planChanges } from "../../../src/sync/plan.ts";

import type { CalendarEventRow } from "../../../src/db/rows.ts";
import type { EventRecord } from "../../../src/google/types.ts";
import type { PlanCandidate } from "../../../src/sync/plan.ts";

const KEY = "prov-1:enc-1";
const ACTIVE_FP = "fingerprint-active";
const GHOST_FP = "fingerprint-ghost";
const ACTIVE_BLOCK = healthyBlock("Office Visit · planned");
const GHOST_BLOCK = `${ACTIVE_BLOCK}\n\nNo longer on the health system's schedule as of today.`;

function row(overrides: Partial<CalendarEventRow> = {}): CalendarEventRow {
  return {
    event_key: KEY,
    health_system_id: "prov-1",
    encounter_id: "enc-1",
    calendar_id: "primary",
    google_event_id: "google-1",
    fingerprint: ACTIVE_FP,
    state: "active",
    start_at: 1_790_000_000,
    first_seen_at: 1_780_000_000,
    last_seen_at: 1_780_000_000,
    ghosted_at: null,
    updated_at: 1_780_000_000,
    source: "fhir",
    portal_csn: null,
    title_digest: null,
    ...overrides,
  };
}

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "google-1",
    status: "confirmed",
    summary: "Office Visit",
    description: `A note of the owner's\n\n${ACTIVE_BLOCK}`,
    start: { dateTime: "2026-10-01T15:30:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-10-01T16:00:00Z", timeZone: "UTC" },
    colorId: null,
    transparency: null,
    extendedProperties: {
      private: { healthy: "1", key: KEY, fp: ACTIVE_FP, healthSystem: "prov-1" },
    },
    updated: null,
    etag: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    key: KEY,
    fingerprint: ACTIVE_FP,
    ghostFingerprint: GHOST_FP,
    description: ACTIVE_BLOCK,
    ghostDescription: GHOST_BLOCK,
    offSchedule: false,
    absent: false,
    upcoming: true,
    hasModel: true,
    ...overrides,
  };
}

/** The one entry a single-key plan produced. */
function only(
  rows: CalendarEventRow[],
  events: EventRecord[],
  candidates: PlanCandidate[],
  options: { suppressGhosting?: boolean } = {},
) {
  const plan = planChanges(rows, events, candidates, options);
  expect(plan.entries).toHaveLength(1);
  return plan.entries[0]!;
}

describe("eventKeyOf", () => {
  it("reads the key off one of our events", () => {
    expect(eventKeyOf(event())).toBe(KEY);
  });

  it("refuses an event without the marker, whatever else it carries", () => {
    // THE invariant: no marker, not ours, never touched.
    expect(
      eventKeyOf(event({ extendedProperties: { private: { key: KEY, healthy: "0" } } })),
    ).toBeNull();
    expect(eventKeyOf(event({ extendedProperties: null }))).toBeNull();
  });

  it("refuses an event with the marker but no key", () => {
    expect(eventKeyOf(event({ extendedProperties: { private: { healthy: "1" } } }))).toBeNull();
  });
});

describe("a live appointment", () => {
  it("inserts when neither the table nor the calendar knows it", () => {
    expect(only([], [], [candidate()])).toMatchObject({ action: "insert", reason: "new" });
  });

  it("leaves a settled event alone", () => {
    const entry = only([row()], [event()], [candidate()]);

    expect(entry).toMatchObject({ action: "unchanged", reason: "fingerprint_match" });
  });

  it("patches a settled event whose description lost the rule", () => {
    // The owner typed over the whole description: the block has to come back.
    const retyped = event({ description: "The owner's own words" });

    expect(only([row()], [retyped], [candidate()])).toMatchObject({
      action: "patch",
      reason: "description_drift",
      googleEventId: "google-1",
    });
  });

  it("patches a settled event edited below the rule", () => {
    const edited = event({ description: ACTIVE_BLOCK.replace("planned", "edited") });

    expect(only([row()], [edited], [candidate()])).toMatchObject({
      action: "patch",
      reason: "description_drift",
    });
  });

  it("patches a settled event with no description at all", () => {
    expect(only([row()], [event({ description: null })], [candidate()])).toMatchObject({
      action: "patch",
      reason: "description_drift",
    });
  });

  it("patches when the mapped fields moved", () => {
    const entry = only([row()], [event()], [candidate({ fingerprint: "fingerprint-new" })]);

    expect(entry).toMatchObject({ action: "patch", reason: "changed", googleEventId: "google-1" });
  });

  it("patches when Google's own fingerprint drifted from the row's", () => {
    // The row and the model agree, but the calendar does not -- a patch that was
    // half applied, or an event edited by hand despite the "do not edit" footer.
    const drifted = event({
      extendedProperties: { private: { healthy: "1", key: KEY, fp: "fingerprint-stale" } },
    });

    expect(only([row()], [drifted], [candidate()])).toMatchObject({ action: "patch" });
  });

  it("adopts an event of ours that has no row", () => {
    // A local data loss, or a restore from backup. Inserting would duplicate it.
    expect(only([], [event()], [candidate()])).toMatchObject({
      action: "patch",
      reason: "adopt",
      googleEventId: "google-1",
    });
  });

  it("restores a ghost whose appointment came back", () => {
    const ghosted = row({ state: "ghost", ghosted_at: 1_781_000_000, fingerprint: GHOST_FP });

    expect(only([ghosted], [event()], [candidate()])).toMatchObject({
      action: "restore",
      reason: "reappeared",
      variant: "active",
    });
  });

  it("re-creates an upcoming event the owner deleted", () => {
    expect(only([row()], [], [candidate({ upcoming: true })])).toMatchObject({
      action: "insert",
      reason: "recreate_deleted",
    });
  });

  it("ghosts, not re-creates, a past event the owner deleted", () => {
    // Re-creating an event somebody deliberately deleted is the one thing they
    // clearly did not want.
    expect(only([row()], [], [candidate({ upcoming: false })])).toMatchObject({
      action: "ghost-row-only",
      reason: "past_deleted",
    });
  });

  it("never re-creates a ghost", () => {
    const ghosted = row({ state: "ghost", ghosted_at: 1_781_000_000, fingerprint: GHOST_FP });

    expect(only([ghosted], [], [candidate({ upcoming: true })])).toMatchObject({
      action: "unchanged",
      reason: "ghost_not_recreated",
    });
  });

  it("skips a candidate with no model at all", () => {
    expect(only([row()], [event()], [candidate({ hasModel: false })])).toMatchObject({
      action: "skip",
      reason: "no_model",
    });
  });
});

describe("a cancelled appointment", () => {
  it("ghosts the event it wrote", () => {
    const entry = only([row()], [event()], [candidate({ offSchedule: true })]);

    expect(entry).toMatchObject({
      action: "ghost",
      reason: "cancelled",
      variant: "ghost",
      googleEventId: "google-1",
    });
  });

  it("is skipped when it was never on the calendar", () => {
    // A ghost for something that never existed would invent history.
    expect(only([], [event()], [candidate({ offSchedule: true })])).toMatchObject({
      action: "skip",
      reason: "never_written",
    });
  });

  it("settles after one ghosting pass", () => {
    const ghosted = row({ state: "ghost", ghosted_at: 1_781_000_000, fingerprint: GHOST_FP });
    const ghostEvent = event({ description: GHOST_BLOCK });

    expect(only([ghosted], [ghostEvent], [candidate({ offSchedule: true })])).toMatchObject({
      action: "unchanged",
      reason: "already_ghost",
    });
  });

  it("re-ghosts a settled ghost whose description lost its block", () => {
    const ghosted = row({ state: "ghost", ghosted_at: 1_781_000_000, fingerprint: GHOST_FP });
    const retyped = event({ description: "The owner's own words" });

    expect(only([ghosted], [retyped], [candidate({ offSchedule: true })])).toMatchObject({
      action: "ghost",
      reason: "description_drift",
      googleEventId: "google-1",
    });
  });

  it("moves only the row when the Google event is gone", () => {
    expect(only([row()], [], [candidate({ offSchedule: true })])).toMatchObject({
      action: "ghost-row-only",
      reason: "event_gone",
    });
  });
});

describe("an appointment that vanished upstream", () => {
  it("ghosts it", () => {
    const entry = only([row()], [event()], [candidate({ absent: true })]);

    expect(entry).toMatchObject({ action: "ghost", reason: "vanished", variant: "ghost" });
  });

  it("marks the row without a Google write when the cache has forgotten it too", () => {
    const entry = only([row()], [event()], [candidate({ absent: true, hasModel: false })]);

    expect(entry).toMatchObject({ action: "ghost-row-only", reason: "no_model" });
  });

  it("is left entirely alone while the view was filtered", () => {
    // Epic 4119: absence proves nothing, so partial results must not ghost real
    // appointments.
    const entry = only([row()], [event()], [candidate({ absent: true })], {
      suppressGhosting: true,
    });

    expect(entry).toMatchObject({ action: "skip", reason: "filtered_view" });
  });

  it("still ghosts a cancelled one while the view was filtered", () => {
    // A cancellation is a positive statement, not an absence.
    const entry = only([row()], [event()], [candidate({ offSchedule: true })], {
      suppressGhosting: true,
    });

    expect(entry).toMatchObject({ action: "ghost", reason: "cancelled" });
  });
});

describe("orphans", () => {
  it("reports an event of ours with no row and no candidate", () => {
    const plan = planChanges([], [event()], []);

    expect(plan.orphans).toStrictEqual([{ key: KEY, googleEventId: "google-1" }]);
    expect(plan.entries).toHaveLength(0);
  });

  it("does not report an event that has a row", () => {
    const plan = planChanges([row()], [event()], []);

    expect(plan.orphans).toHaveLength(0);
  });

  it("ignores an event without our marker entirely", () => {
    const plan = planChanges([], [event({ extendedProperties: null })], []);

    expect(plan.orphans).toHaveLength(0);
    expect(plan.entries).toHaveLength(0);
  });
});

/** An event key for one made-up encounter id. */
function keyed(suffix: string): string {
  return `prov-1:${suffix}`;
}

describe("grouping", () => {
  it("buckets a mixed plan and counts every key once", () => {
    const rows = [
      row({ event_key: keyed("patch"), google_event_id: "g-patch", encounter_id: "patch" }),
      row({ event_key: keyed("gone"), google_event_id: "g-gone", encounter_id: "gone" }),
      row({ event_key: keyed("same"), google_event_id: "g-same", encounter_id: "same" }),
    ];
    const events = [
      event({
        id: "g-patch",
        extendedProperties: { private: { healthy: "1", key: keyed("patch") } },
      }),
      event({
        id: "g-gone",
        extendedProperties: { private: { healthy: "1", key: keyed("gone") } },
      }),
      event({
        id: "g-same",
        extendedProperties: { private: { healthy: "1", key: keyed("same") } },
      }),
    ];
    const candidates = [
      candidate({ key: keyed("new") }),
      candidate({ key: keyed("patch"), fingerprint: "moved" }),
      candidate({ key: keyed("gone"), absent: true }),
      candidate({ key: keyed("same") }),
    ];

    const plan = planChanges(rows, events, candidates);

    expect(plan.inserts).toHaveLength(1);
    expect(plan.patches).toHaveLength(1);
    expect(plan.ghosts).toHaveLength(1);
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.entries).toHaveLength(4);
    expect(plan.orphans).toHaveLength(0);
  });

  it("groups a row-only ghost with the ghosts", () => {
    const plan = planChanges([row()], [], [candidate({ absent: true })]);

    expect(plan.ghosts).toHaveLength(1);
    expect(plan.ghosts[0]?.action).toBe("ghost-row-only");
  });
});

/** A one-key plan with title digests, and its only entry. */
function titled(
  rows: CalendarEventRow[],
  events: EventRecord[],
  candidates: PlanCandidate[],
  titles: { google: string | null; active: string | null; ghost: string | null },
) {
  const plan = planChanges(rows, events, candidates, { titles: new Map([[KEY, titles]]) });
  expect(plan.entries).toHaveLength(1);
  return { entry: plan.entries[0]!, plan };
}

describe("the owner's title", () => {
  // Stand-ins for keyed digests: the plan only ever compares them.
  const HEALTHY = "~digest-healthy";
  const NEWER = "~digest-newer";
  const GHOSTLY = "~digest-ghost";
  const OWNERS = "~digest-owner";

  it("is Healthy's while Google holds what Healthy last wrote", () => {
    const { entry } = titled([row({ title_digest: HEALTHY })], [event()], [candidate()], {
      google: HEALTHY,
      active: HEALTHY,
      ghost: null,
    });

    expect(entry).toMatchObject({ action: "unchanged", keepTitle: false, titleDigest: HEALTHY });
  });

  it("is the owner's once it differs, and a change is written without it", () => {
    const changed = candidate({ fingerprint: "fingerprint-new" });
    const { entry, plan } = titled([row({ title_digest: HEALTHY })], [event()], [changed], {
      google: OWNERS,
      active: NEWER,
      ghost: null,
    });

    expect(entry).toMatchObject({ action: "patch", reason: "changed", keepTitle: true });
    // What the row goes on recording is what Healthy last wrote, not the owner's.
    expect(entry.titleDigest).toBe(HEALTHY);
    expect(plan.titlesKept).toBe(1);
  });

  it("never patches an owner's title that merely differs from the model", () => {
    const { entry } = titled([row({ title_digest: HEALTHY })], [event()], [candidate()], {
      google: OWNERS,
      active: NEWER,
      ghost: null,
    });

    expect(entry).toMatchObject({ action: "unchanged", keepTitle: true });
  });

  it("patches a title Healthy owns but would now write differently (title_drift)", () => {
    // The owner put back an older Healthy title after the model had moved on.
    const { entry } = titled([row({ title_digest: HEALTHY })], [event()], [candidate()], {
      google: HEALTHY,
      active: NEWER,
      ghost: null,
    });

    expect(entry).toMatchObject({ action: "patch", reason: "title_drift", keepTitle: false });
  });

  it("keeps the owner's title on a ghost", () => {
    const { entry } = titled(
      [row({ title_digest: HEALTHY })],
      [event()],
      [candidate({ offSchedule: true })],
      { google: OWNERS, active: HEALTHY, ghost: GHOSTLY },
    );

    expect(entry).toMatchObject({ action: "ghost", reason: "cancelled", keepTitle: true });
  });

  it("restores a ghost to Healthy's title when Google still shows the ghost's", () => {
    const ghostRow = row({
      state: "ghost",
      ghosted_at: 1_780_000_000,
      fingerprint: GHOST_FP,
      title_digest: GHOSTLY,
    });
    const { entry } = titled([ghostRow], [event()], [candidate()], {
      google: GHOSTLY,
      active: HEALTHY,
      ghost: null,
    });

    expect(entry).toMatchObject({ action: "restore", keepTitle: false });
  });

  describe("on a row from before titles were tracked", () => {
    it("seeds Google's title as Healthy's when it is the one Healthy computes", () => {
      const { entry } = titled([row()], [event()], [candidate()], {
        google: HEALTHY,
        active: HEALTHY,
        ghost: null,
      });

      expect(entry).toMatchObject({ action: "unchanged", keepTitle: false, titleDigest: HEALTHY });
    });

    it("reads a difference as the owner's when the fingerprint proves what Healthy wrote", () => {
      const { entry } = titled([row()], [event()], [candidate()], {
        google: OWNERS,
        active: HEALTHY,
        ghost: null,
      });

      expect(entry).toMatchObject({ action: "unchanged", keepTitle: true, titleDigest: HEALTHY });
    });

    it("takes Google's title as Healthy's when the model moved since the last write", () => {
      const moved = candidate({ fingerprint: "fingerprint-new" });
      const { entry } = titled([row()], [event()], [moved], {
        google: OWNERS,
        active: NEWER,
        ghost: null,
      });

      expect(entry).toMatchObject({ action: "patch", keepTitle: false, titleDigest: OWNERS });
    });
  });

  it("is Healthy's, with nothing to record, for an event with no row", () => {
    const { entry } = titled([], [event()], [candidate()], {
      google: OWNERS,
      active: HEALTHY,
      ghost: null,
    });

    expect(entry).toMatchObject({ action: "patch", reason: "adopt", keepTitle: false });
    expect(entry.titleDigest).toBeNull();
  });
});
