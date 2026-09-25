// The mapping layer is the part of the sync a human actually reads: it produces
// the title on the owner's phone and the description they open when they are
// already in the car. So it is tested exhaustively and against literal strings.
//
// Timezones here are "UTC" and "Etc/GMT-2" (which is UTC+2 -- the POSIX sign is
// inverted). Neither names a place, which is deliberate: this repository must not
// disclose where the owner lives, and a test fixture is a tracked file like any
// other.

import { describe, expect, it } from "vitest";

import { blindEventKey, blinderFor } from "../../../worker/db/blind.ts";
import { healthSystemConfigSchema } from "../../../worker/db/schemas.ts";
import { AppError } from "../../../worker/lib/errors.ts";
import { formatInZone } from "../../../worker/lib/time.ts";
import {
  DEFAULT_DURATION_MIN,
  arrivalOffsetFor,
  buildCalendarModel,
  eventKey,
  formatApptTime,
  ghostModel,
  parseEventKey,
  renderTitle,
} from "../../../worker/sync/mapping.ts";

import type { NormalizedAppointmentView } from "../../../worker/fhir/normalize/types.ts";
import type { MappingInput, MappingSettings } from "../../../worker/sync/mapping.ts";

const HEALTH_SYSTEM_ID = "prov-1";
const START = "2026-10-01T15:30:00Z";
const PORTAL = "https://portal.example.test/mychart";

/** A fresh random key per run: the blinds only have to be consistent within one. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}
const BLINDER = blinderFor(randomKey());

const SETTINGS: MappingSettings = {
  timezone: "UTC",
  defaultTitleTemplate: "{visitType} · {practitioner}",
  defaultColorId: null,
  ghostColorId: "8",
  defaultArrivalOffsetMin: 0,
};

function config(overrides: Record<string, unknown> = {}) {
  return healthSystemConfigSchema.parse(overrides);
}

function input(
  overrides: {
    settings?: Partial<MappingSettings>;
    config?: Record<string, unknown>;
    portalUrl?: string | null;
  } = {},
): MappingInput {
  return {
    healthSystem: {
      id: HEALTH_SYSTEM_ID,
      displayName: "Example Health",
      portalUrl: overrides.portalUrl === undefined ? PORTAL : overrides.portalUrl,
      config: config(overrides.config),
    },
    settings: { ...SETTINGS, ...overrides.settings },
    blinder: BLINDER,
  };
}

/**
 * A view override may be an explicit `undefined`, which means "drop this field".
 *
 * `Partial<NormalizedAppointmentView>` will not do: under
 * `exactOptionalPropertyTypes` an optional property does not accept `undefined`,
 * and half these tests are about what happens when a field is missing.
 */
type ViewOverrides = {
  [K in keyof NormalizedAppointmentView]?: NormalizedAppointmentView[K] | undefined;
};

function view(overrides: ViewOverrides = {}): NormalizedAppointmentView {
  const base = {
    healthSystem: HEALTH_SYSTEM_ID,
    encounterId: "enc-1",
    status: "planned",
    start: START,
    visitType: "Office Visit",
    practitioner: "Casey Example",
    specialty: "Cardiology",
    department: "Heart Clinic",
    org: "Example Regional",
    location: {
      name: "Clinic Building A",
      address: { lines: ["1 Test Way"], city: "Testville", state: "TS", postalCode: "00001" },
      phone: "555-0100",
    },
    telehealth: false,
    ...overrides,
  };
  // An explicit `undefined` override becomes an absent key, which is what a
  // normalizer would actually have produced.
  const present = Object.entries(base).filter(([, value]) => value !== undefined);
  return Object.fromEntries(present) as unknown as NormalizedAppointmentView;
}

describe("eventKey", () => {
  it("round-trips a health system and encounter id", () => {
    const key = eventKey(HEALTH_SYSTEM_ID, "enc-1");

    expect(key).toBe("prov-1:enc-1");
    expect(parseEventKey(key)).toStrictEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      encounterId: "enc-1",
    });
  });

  it("keeps a colon inside an encounter id", () => {
    // Epic ids are opaque; nothing guarantees they have no colon, and splitting
    // on the last one instead of the first would move the boundary.
    expect(parseEventKey("prov-1:a:b")).toStrictEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      encounterId: "a:b",
    });
  });

  it("rejects anything that is not one of ours", () => {
    expect(parseEventKey("no-colon")).toBeNull();
    expect(parseEventKey(":leading")).toBeNull();
    expect(parseEventKey("trailing:")).toBeNull();
  });
});

describe("renderTitle", () => {
  const values = new Map([
    ["visitType", "Office Visit"],
    ["practitioner", "Casey Example"],
    ["specialty", "Cardiology"],
    ["orgShort", "ERH"],
    ["org", "Example Regional"],
    ["department", "Heart Clinic"],
    ["apptTime", "3:30 PM"],
  ]);

  it("substitutes every placeholder", () => {
    expect(
      renderTitle(
        "{visitType} · {practitioner} · {specialty} · {orgShort} · {org} · {department} · {apptTime}",
        values,
      ),
    ).toBe(
      "Office Visit · Casey Example · Cardiology · ERH · Example Regional · Heart Clinic · 3:30 PM",
    );
  });

  it("drops a separator left stranded by an empty value", () => {
    const sparse = new Map([["visitType", "Office Visit"]]);

    expect(renderTitle("{visitType} · {practitioner}", sparse)).toBe("Office Visit");
    expect(renderTitle("{practitioner} · {visitType}", sparse)).toBe("Office Visit");
    expect(renderTitle("{practitioner} · {specialty} · {visitType}", sparse)).toBe("Office Visit");
  });

  it("keeps a hyphen that belongs to a value", () => {
    // A hyphen is never a split separator: "Follow-up" would otherwise become
    // "Follow up" or, worse, two segments.
    expect(renderTitle("{visitType}", new Map([["visitType", "Follow-up Visit"]]))).toBe(
      "Follow-up Visit",
    );
  });

  it("trims a dangling hyphen when the value after it is empty", () => {
    expect(renderTitle("{visitType} - {practitioner}", new Map([["visitType", "Labs"]]))).toBe(
      "Labs",
    );
  });

  it("falls back rather than producing an empty title", () => {
    expect(renderTitle("{visitType} · {practitioner}", new Map())).toBe("Appointment");
  });

  it("leaves an unknown placeholder empty rather than literal", () => {
    expect(renderTitle("{visitType} · {nonsense}", values)).toBe("Office Visit");
  });
});

describe("arrivalOffsetFor", () => {
  it("prefers a visit-type override over the health system default", () => {
    const healthSystem = config({
      arrival_offset_min: 10,
      arrival_offsets_by_visit_type: { "office visit": 25 },
    });

    expect(arrivalOffsetFor("Office Visit", healthSystem, 0)).toBe(25);
  });

  it("matches a visit type without regard to case or padding", () => {
    const healthSystem = config({ arrival_offsets_by_visit_type: { "Office Visit": 25 } });

    expect(arrivalOffsetFor("  office visit ", healthSystem, 0)).toBe(25);
  });

  it("falls back to the health system default, then the global one", () => {
    expect(arrivalOffsetFor("Other", config({ arrival_offset_min: 10 }), 45)).toBe(10);
    expect(arrivalOffsetFor("Other", config(), 45)).toBe(45);
    expect(arrivalOffsetFor(undefined, config(), 45)).toBe(45);
  });
});

describe("buildCalendarModel", () => {
  it("maps the straightforward case with no arrival offset", async () => {
    const { model, status, offSchedule, reportedStart, arrivalOffsetMin } =
      await buildCalendarModel(view(), input());

    expect(model.key).toBe(await blindEventKey(BLINDER, "prov-1:enc-1"));
    expect(model.encounterId).toBe("enc-1");
    expect(model.healthSystem).toBe(HEALTH_SYSTEM_ID);
    expect(model.title).toBe("Office Visit · Casey Example");
    expect(model.start).toBe(START);
    expect(model.end).toBe("2026-10-01T16:00:00.000Z");
    expect(model.timeZone).toBe("UTC");
    expect(model.transparent).toBe(false);
    expect(model.colorId).toBeUndefined();
    expect(status).toBe("planned");
    expect(offSchedule).toBe(false);
    expect(reportedStart).toBe(START);
    expect(arrivalOffsetMin).toBe(0);
  });

  it("shifts the start by the offset and names the real time in the title", async () => {
    const { model } = await buildCalendarModel(
      view(),
      input({ config: { arrival_offset_min: 20 } }),
    );

    expect(model.start).toBe("2026-10-01T15:10:00.000Z");
    // The default duration is measured from the REAL start, so the offset
    // lengthens the event rather than sliding it.
    expect(model.end).toBe("2026-10-01T16:00:00.000Z");
    expect(model.title).toBe("Office Visit · Casey Example (appt 3:30 PM)");
  });

  it("uses a visit-type override for the offset", async () => {
    const { model, arrivalOffsetMin } = await buildCalendarModel(
      view({ visitType: "Imaging" }),
      input({
        config: { arrival_offset_min: 5, arrival_offsets_by_visit_type: { imaging: 45 } },
      }),
    );

    expect(arrivalOffsetMin).toBe(45);
    expect(model.start).toBe("2026-10-01T14:45:00.000Z");
  });

  it("renders the appointment time in the settings timezone", async () => {
    const { model } = await buildCalendarModel(
      view(),
      input({ settings: { timezone: "Etc/GMT-2" }, config: { arrival_offset_min: 15 } }),
    );

    // Etc/GMT-2 is UTC+2, so 15:30Z reads as 5:30 PM.
    expect(model.title).toContain("(appt 5:30 PM)");
    expect(model.timeZone).toBe("Etc/GMT-2");
  });

  it("adds no suffix when the offset is zero", async () => {
    const { model } = await buildCalendarModel(view(), input());

    expect(model.title).not.toContain("appt");
  });

  it("defaults the end to 30 minutes after the real start", async () => {
    const { model } = await buildCalendarModel(view({ end: undefined }), input());
    const expected = new Date(Date.parse(START) + DEFAULT_DURATION_MIN * 60_000).toISOString();

    expect(model.end).toBe(expected);
  });

  it("keeps an upstream end that is after the start", async () => {
    const { model } = await buildCalendarModel(
      view({ end: "2026-10-01T17:15:00Z" }),
      input({ config: { arrival_offset_min: 30 } }),
    );

    expect(model.end).toBe("2026-10-01T17:15:00Z");
  });

  it("replaces an upstream end that is not after the start", async () => {
    // Google rejects a non-positive duration outright, so a nonsense period must
    // not reach it.
    const { model } = await buildCalendarModel(view({ end: "2026-10-01T15:30:00Z" }), input());

    expect(model.end).toBe("2026-10-01T16:00:00.000Z");
  });

  it("throws rather than inventing a time for an Encounter with no start", async () => {
    await expect(buildCalendarModel(view({ start: undefined }), input())).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("flags a cancelled Encounter as off the schedule", async () => {
    const cancelled = await buildCalendarModel(view({ status: "cancelled" }), input());
    const erroneous = await buildCalendarModel(view({ status: "entered-in-error" }), input());
    const finished = await buildCalendarModel(view({ status: "finished" }), input());

    expect(cancelled.offSchedule).toBe(true);
    expect(erroneous.offSchedule).toBe(true);
    expect(finished.offSchedule).toBe(false);
  });
});

describe("location", () => {
  it("joins the clinic name and the address", async () => {
    const { model } = await buildCalendarModel(view(), input());

    expect(model.location).toBe("Clinic Building A, 1 Test Way, Testville, TS, 00001");
  });

  it("says video visit and carries the portal link for telehealth", async () => {
    const { model } = await buildCalendarModel(view({ telehealth: true }), input());

    expect(model.location).toBe(`Video visit · ${PORTAL}`);
  });

  it("says video visit alone when there is no portal url", async () => {
    const { model } = await buildCalendarModel(
      view({ telehealth: true }),
      input({ portalUrl: null }),
    );

    expect(model.location).toBe("Video visit");
  });

  it("omits the field entirely when there is nothing to say", async () => {
    const { model } = await buildCalendarModel(view({ location: undefined }), input());

    expect(model.location).toBeUndefined();
  });
});

describe("description", () => {
  it("carries the place, the people, the portal link and the footer", async () => {
    const { model } = await buildCalendarModel(view(), input());

    expect(model.description).toContain("Example Regional");
    expect(model.description).toContain("Heart Clinic");
    expect(model.description).toContain("Clinic Building A");
    expect(model.description).toContain("1 Test Way, Testville, TS, 00001 · 555-0100");
    expect(model.description).toContain("Casey Example — Cardiology");
    expect(model.description).toContain("Office Visit · planned");
    expect(model.description).toContain(PORTAL);
    expect(model.description.endsWith("\n\nSynced by Healthy · do not edit")).toBe(true);
  });

  it("carries no clock: an unchanged event is never patched, so a time would go stale", async () => {
    const { model } = await buildCalendarModel(view(), input());

    expect(model.description).not.toContain("last checked");
  });

  it("falls back to the health system display name when the org is unknown", async () => {
    const { model } = await buildCalendarModel(view({ org: undefined }), input());

    expect(model.description).toContain("Example Health");
  });

  it("leaves no blank line where a missing field would have been", async () => {
    const { model } = await buildCalendarModel(
      view({ department: undefined, specialty: undefined, location: undefined }),
      input({ portalUrl: null }),
    );

    expect(model.description).not.toContain("\n".repeat(3));
    expect(model.description.startsWith("Example Regional")).toBe(true);
  });
});

describe("colorId", () => {
  it("prefers the health system's colour, then the global default, then none", async () => {
    const healthSystem = await buildCalendarModel(
      view(),
      input({ config: { color_id: "4" }, settings: { defaultColorId: "9" } }),
    );
    const global = await buildCalendarModel(view(), input({ settings: { defaultColorId: "9" } }));
    const neither = await buildCalendarModel(view(), input());

    expect(healthSystem.model.colorId).toBe("4");
    expect(global.model.colorId).toBe("9");
    expect(neither.model.colorId).toBeUndefined();
  });
});

describe("fingerprint", () => {
  it("is the same on every build of an unchanged appointment", async () => {
    // THE property that stops the hourly sync patching every event forever.
    const first = await buildCalendarModel(view(), input());
    const later = await buildCalendarModel(view(), input());

    expect(later.model.description).toBe(first.model.description);
    expect(later.model.fingerprint).toBe(first.model.fingerprint);
  });

  it("changes when the time, the title, the place or the colour changes", async () => {
    const base = await buildCalendarModel(view(), input());
    const moved = await buildCalendarModel(view({ start: "2026-10-01T16:30:00Z" }), input());
    const renamed = await buildCalendarModel(view({ practitioner: "Other Example" }), input());
    const relocated = await buildCalendarModel(view({ telehealth: true }), input());
    const recoloured = await buildCalendarModel(view(), input({ config: { color_id: "4" } }));

    const fingerprints = new Set([
      base.model.fingerprint,
      moved.model.fingerprint,
      renamed.model.fingerprint,
      relocated.model.fingerprint,
      recoloured.model.fingerprint,
    ]);

    expect(fingerprints.size).toBe(5);
  });

  it("changes when a detail only the description carries changes", async () => {
    const base = await buildCalendarModel(view(), input());
    const other = await buildCalendarModel(view({ department: "Other Clinic" }), input());

    expect(other.model.fingerprint).not.toBe(base.model.fingerprint);
  });
});

describe("ghostModel", () => {
  const GHOSTED_AT = "2026-10-02T09:00:00Z";

  it("prefixes, greys, frees the time and records when it vanished", async () => {
    const { model } = await buildCalendarModel(view(), input());

    const ghost = await ghostModel(model, {
      ghostColorId: "8",
      blinder: BLINDER,
      timezone: "UTC",
      ghostedAtIso: GHOSTED_AT,
    });

    expect(ghost.title).toBe("Cancelled: Office Visit · Casey Example");
    expect(ghost.transparent).toBe(true);
    expect(ghost.colorId).toBe("8");
    expect(ghost.start).toBe(model.start);
    // The original details survive: a ghost is history, not a tombstone.
    expect(ghost.description).toContain("Casey Example — Cardiology");
    expect(ghost.description).toContain(
      `No longer on the health system's schedule as of ${formatInZone(GHOSTED_AT, "UTC")}.`,
    );
    expect(ghost.fingerprint).not.toBe(model.fingerprint);
  });

  it("does not stack the prefix when it ghosts a ghost", async () => {
    const { model } = await buildCalendarModel(view(), input());
    const once = await ghostModel(model, {
      ghostColorId: "8",
      blinder: BLINDER,
      timezone: "UTC",
      ghostedAtIso: GHOSTED_AT,
    });

    const twice = await ghostModel(once, {
      ghostColorId: "8",
      blinder: BLINDER,
      timezone: "UTC",
      ghostedAtIso: GHOSTED_AT,
    });

    expect(twice.title).toBe("Cancelled: Office Visit · Casey Example");
  });

  it("settles: the same disappearance time gives the same fingerprint", async () => {
    // What stops every hourly run re-patching every ghost.
    const early = await buildCalendarModel(view(), input());
    const late = await buildCalendarModel(view(), input());
    const options = {
      ghostColorId: "8",
      blinder: BLINDER,
      timezone: "UTC",
      ghostedAtIso: GHOSTED_AT,
    };

    const first = await ghostModel(early.model, options);
    const second = await ghostModel(late.model, options);

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("moves the fingerprint when the disappearance time moves", async () => {
    const { model } = await buildCalendarModel(view(), input());
    const base = { ghostColorId: "8", blinder: BLINDER, timezone: "UTC" };

    const first = await ghostModel(model, { ...base, ghostedAtIso: GHOSTED_AT });
    const later = await ghostModel(model, { ...base, ghostedAtIso: "2026-10-03T09:00:00Z" });

    expect(later.fingerprint).not.toBe(first.fingerprint);
  });

  it("restores to exactly the active model", async () => {
    // Restore is not a third variant: the sync simply writes the active model
    // again, so its fingerprint has to match what it was before the ghosting.
    const { model } = await buildCalendarModel(view(), input());
    await ghostModel(model, {
      ghostColorId: "8",
      blinder: BLINDER,
      timezone: "UTC",
      ghostedAtIso: GHOSTED_AT,
    });

    const rebuilt = await buildCalendarModel(view(), input());

    expect(rebuilt.model).toStrictEqual(model);
  });
});

describe("formatApptTime", () => {
  it("formats an hour and minute with no date", () => {
    expect(formatApptTime(START, "UTC")).toBe("3:30 PM");
    expect(formatApptTime(START, "Etc/GMT-2")).toBe("5:30 PM");
  });
});

describe("keyed key and fingerprint", () => {
  it("blinds the event key: the health system prefix stays, the upstream id does not", async () => {
    const { model } = await buildCalendarModel(view(), input());

    expect(model.key.startsWith(`${HEALTH_SYSTEM_ID}:~`)).toBe(true);
    expect(model.key).not.toContain("enc-1");
  });

  it("keys the fingerprint: another key gives another fingerprint and another event key", async () => {
    const mine = await buildCalendarModel(view(), input());
    const theirs = await buildCalendarModel(view(), {
      ...input(),
      blinder: blinderFor(randomKey()),
    });

    expect(theirs.model.fingerprint).not.toBe(mine.model.fingerprint);
    expect(theirs.model.key).not.toBe(mine.model.key);
    expect(theirs.model.title).toBe(mine.model.title);
  });

  it("is not a plain sha256 of anything a snapshot reader could rebuild", async () => {
    const { model } = await buildCalendarModel(view(), input());

    expect(model.fingerprint).not.toMatch(/^[0-9a-f]{64}$/u);
    expect(model.fingerprint.startsWith("~")).toBe(true);
  });
});
