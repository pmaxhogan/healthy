// One upcoming portal visit -> a calendar event, in plain Node.
//
// The conversion is deliberately thin -- it hands a `PortalVisit` to the same
// `buildCalendarModel` the FHIR pass uses -- so what is worth pinning is exactly
// the part that is not shared: the event key's `csn:` half, what becomes the
// location, which statuses mean "off the schedule", and the fact that the title,
// the arrive-early arithmetic and the "Video visit" line come out identical to the
// FHIR side's. An owner must not be able to tell from their calendar which source
// wrote an event.
//
// Timezones here are "UTC" and "Etc/GMT-2" (UTC+2; the POSIX sign is inverted).
// Neither names a place: this repository must not disclose where the owner lives,
// and a test fixture is a tracked file like any other.

import { describe, expect, it } from "vitest";

import { blindEventKey, blinderFor } from "../../../worker/db/blind.ts";
import { healthSystemConfigSchema } from "../../../worker/db/schemas.ts";
import { buildCalendarModel } from "../../../worker/sync/mapping.ts";
import {
  DEDUPE_WINDOW_SECONDS,
  csnOfEncounterId,
  isOffSchedule,
  portalEncounterId,
  portalVisitView,
} from "../../../worker/sync/portal-mapping.ts";

import type { PortalVisit } from "../../../worker/ehr/mychart/index.ts";
import type {
  CalendarMapping,
  MappingInput,
  MappingSettings,
} from "../../../worker/sync/mapping.ts";

const HEALTH_SYSTEM_ID = "prov-1";
const PORTAL_URL = "https://portal.example.test/mychart";

const SETTINGS: MappingSettings = {
  timezone: "UTC",
  defaultTitleTemplate: "{visitType} · {practitioner}",
  defaultColorId: null,
  ghostColorId: "8",
  defaultArrivalOffsetMin: 0,
};

/** A fresh random key per run: the blinds only have to be consistent within one. */
const KEY_BYTES = crypto.getRandomValues(new Uint8Array(32));
const BLINDER = blinderFor(btoa(String.fromCodePoint(...KEY_BYTES)));

function input(
  overrides: { settings?: Partial<MappingSettings>; config?: Record<string, unknown> } = {},
): MappingInput {
  return {
    healthSystem: {
      id: HEALTH_SYSTEM_ID,
      displayName: "Example Health",
      portalUrl: PORTAL_URL,
      config: healthSystemConfigSchema.parse(overrides.config ?? {}),
    },
    settings: { ...SETTINGS, ...overrides.settings },
    blinder: BLINDER,
  };
}

/**
 * A visit override may be an explicit `undefined`, which means "drop this field".
 *
 * `Partial<PortalVisit>` will not do: under `exactOptionalPropertyTypes` an
 * optional property does not accept `undefined`, and several tests here are about
 * what the mapping does when the payload carried no practitioner or no location.
 */
type VisitOverrides = { [K in keyof PortalVisit]?: PortalVisit[K] | undefined };

function visit(overrides: VisitOverrides = {}): PortalVisit {
  const base = {
    csn: "csn-1",
    start: "2026-10-01T15:30:00+00:00",
    timeZone: "UTC",
    visitType: "Follow-up",
    practitioner: "A. Example, MD",
    department: "Example Clinic",
    isVideo: false,
    status: "scheduled",
    ...overrides,
  };
  // An explicit `undefined` override becomes an absent key, which is what the
  // parser in `visits.ts` would actually have produced for a missing field.
  const present = Object.entries(base).filter(([, value]) => value !== undefined);
  return Object.fromEntries(present) as unknown as PortalVisit;
}

/** The mapping for one visit, which is the conversion plus the shared mapper. */
async function map(
  overrides: VisitOverrides = {},
  mappingInput: MappingInput = input(),
): Promise<CalendarMapping> {
  return buildCalendarModel(portalVisitView(HEALTH_SYSTEM_ID, visit(overrides)), mappingInput);
}

describe("the portal event key", () => {
  it("is the health system, the csn: marker and a blind of the contact-serial number", async () => {
    const mapping = await map({ csn: "1234567" });
    expect(mapping.model.key).toBe(await blindEventKey(BLINDER, "prov-1:csn:1234567"));
    expect(mapping.model.key.startsWith("prov-1:csn:~")).toBe(true);
    expect(mapping.model.key).not.toContain("1234567");
    expect(mapping.model.encounterId).toBe("csn:1234567");
  });

  it("round-trips through the encounter-id half", () => {
    expect(csnOfEncounterId(portalEncounterId("1234567"))).toBe("1234567");
  });

  it("does not read an Epic encounter id as a portal one", () => {
    // Which is the point of the marker: `source` says the same thing, and the two
    // must never disagree about the same row.
    expect(csnOfEncounterId("eV1234abcd")).toBeNull();
  });

  it("carries the csn onto the mapping, for the dedupe to match on", async () => {
    const mapping = await map({ csn: "1234567" });
    expect(mapping.csn).toBe("1234567");
  });
});

describe("what the owner sees", () => {
  it("renders the shared title template from the portal's own fields", async () => {
    const mapping = await map();
    expect(mapping.model.title).toBe("Follow-up · A. Example, MD");
    expect(mapping.model.start).toBe("2026-10-01T15:30:00+00:00");
    // `addMinutes` normalises to UTC, which is what the fallback duration goes
    // through; the offset form survives only when the payload's own string is used.
    expect(mapping.model.end).toBe("2026-10-01T16:00:00.000Z");
  });

  it("uses the visit's own duration when the payload gave one", async () => {
    const mapping = await map({ end: "2026-10-01T16:45:00+00:00" });
    expect(mapping.model.end).toBe("2026-10-01T16:45:00+00:00");
  });

  it("applies the arrive-early offset and keeps the real time in the title", async () => {
    const mapping = await map({}, input({ config: { arrival_offset_min: 20 } }));
    expect(mapping.model.start).toBe("2026-10-01T15:10:00.000Z");
    expect(mapping.reportedStart).toBe("2026-10-01T15:30:00+00:00");
    expect(mapping.arrivalOffsetMin).toBe(20);
    expect(mapping.model.title).toBe("Follow-up · A. Example, MD (appt 3:30 PM)");
    // Measured from the *reported* start, so the event is 50 minutes, which is what
    // the afternoon actually costs.
    expect(mapping.model.end).toBe("2026-10-01T16:00:00.000Z");
  });

  it("honours a visit-type arrive-early override, matched case-insensitively", async () => {
    const mapping = await map(
      { visitType: "LAB" },
      input({ config: { arrival_offsets_by_visit_type: { lab: 5 } } }),
    );
    expect(mapping.arrivalOffsetMin).toBe(5);
  });

  it("renders every time in the owner's zone, not the clinic's", async () => {
    const mapping = await map(
      { timeZone: "UTC", start: "2026-10-01T15:30:00+00:00" },
      input({ settings: { timezone: "Etc/GMT-2" } }),
    );
    expect(mapping.model.timeZone).toBe("Etc/GMT-2");
    expect(mapping.model.description.endsWith("Synced by Healthy · do not edit")).toBe(true);
  });

  it("puts the location name and the address on the event", async () => {
    const mapping = await map({ locationName: "Example Tower", address: "1 Example Way" });
    expect(mapping.model.location).toBe("Example Tower, 1 Example Way");
  });

  it("falls back to the department when the payload names no location", async () => {
    const mapping = await map({ locationName: undefined, department: "Example Clinic" });
    expect(mapping.model.location).toBe("Example Clinic");
  });

  it("says Video visit and links the portal for a telehealth visit", async () => {
    const mapping = await map({ isVideo: true, locationName: "Example Tower" });
    expect(mapping.model.location).toBe(`Video visit · ${PORTAL_URL}`);
  });

  it("describes where and who, and never blocks time by accident", async () => {
    const mapping = await map({ address: "1 Example Way", phone: "555-0100" });
    expect(mapping.model.description).toContain("Example Health");
    expect(mapping.model.description).toContain("Example Clinic");
    expect(mapping.model.description).toContain("1 Example Way · 555-0100");
    expect(mapping.model.description).toContain("Follow-up · scheduled");
    expect(mapping.model.transparent).toBe(false);
  });

  it("leaves the title readable when the payload names no practitioner", async () => {
    const mapping = await map({ practitioner: undefined });
    expect(mapping.model.title).toBe("Follow-up");
  });

  it("calls a visit with no type an Appointment rather than nothing", async () => {
    const mapping = await map({ visitType: undefined, practitioner: undefined });
    expect(mapping.model.title).toBe("Appointment");
  });

  it("gives two different visits two different fingerprints", async () => {
    const one = await map({ csn: "csn-1" });
    const two = await map({ csn: "csn-2" });
    expect(one.model.fingerprint).not.toBe(two.model.fingerprint);
  });

  it("gives the same visit the same fingerprint twice, so nothing is re-patched", async () => {
    const one = await map();
    const two = await map();
    expect(one.model.fingerprint).toBe(two.model.fingerprint);
  });
});

describe("which statuses take a visit off the schedule", () => {
  it("ghosts a canceled or no-show visit", () => {
    expect(isOffSchedule("canceled")).toBe(true);
    expect(isOffSchedule("no_show")).toBe(true);
  });

  it("leaves every other status on the calendar", () => {
    for (const status of [
      "scheduled",
      "confirmed",
      "arrived",
      "in_progress",
      "completed",
      "cancel_requested",
      "left_without_being_seen",
    ] as const) {
      expect(isOffSchedule(status)).toBe(false);
    }
  });

  it("keeps the portal's own word for the status in the description", async () => {
    // Not translated into FHIR's vocabulary: the owner is reading what their clinic
    // said, and `no_show` has no FHIR equivalent to be translated into.
    const mapping = await map({ status: "no_show" });
    expect(mapping.model.description).toContain("Follow-up · no_show");
    // `offSchedule` on the mapping reflects the FHIR statuses only, which is why
    // the portal pass asks `isOffSchedule` instead of trusting it.
    expect(mapping.offSchedule).toBe(false);
  });
});

describe("the dedupe tolerance", () => {
  it("is five minutes, in seconds", () => {
    // Quoted rather than derived: both directions of the dedupe compare against it,
    // and widening it starts collapsing back-to-back appointments into one.
    expect(DEDUPE_WINDOW_SECONDS).toBe(300);
  });
});
