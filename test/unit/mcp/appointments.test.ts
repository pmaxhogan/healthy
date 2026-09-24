// `get_appointments` (and the summary's appointments section) with the patient
// portal's stored visits merged in.
//
// Epic's patient FHIR view never returns an upcoming Encounter, so the portal's
// visits are the only upcoming appointments there are. What is pinned here:
//
//   - every stored visit comes back, however far out, soonest first
//   - a visit FHIR also has is one item, the FHIR one, filled in from the portal
//   - the window and the `health_systems` argument apply to portal items too
//   - every policy rule that reaches an Encounter reaches a portal item
//   - `raw` never carries the portal payload
//
// Every visit below is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { parseUpcoming } from "../../../worker/ehr/mychart/visits.ts";
import { PORTAL_RAW_WARNING } from "../../../worker/mcp/appointment-items.ts";
import { buildRules } from "../../../worker/policy/rules.ts";

import {
  NAME_A,
  NAME_B,
  NOW,
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { PortalVisit } from "../../../worker/ehr/mychart/index.ts";
import type { PortalVisitRecord } from "../../../worker/mcp/deps.ts";
import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const rules = (...input: PolicyRuleInput[]) => buildRules(input);

/** A synthetic visit; the defaults are an ordinary in-person follow-up. */
function visit(overrides: Partial<PortalVisit> & { csn: string; start: string }): PortalVisit {
  return {
    timeZone: "UTC",
    visitType: "Follow-up",
    practitioner: "P. Example, MD",
    department: "Example Clinic",
    locationName: "Example Tower",
    address: "1 Example Way",
    phone: "555-0199",
    isVideo: false,
    status: "scheduled",
    ...overrides,
  };
}

const stored = (value: PortalVisit, missing = false, fetchedAt = NOW): PortalVisitRecord => ({
  visit: value,
  missing,
  fetchedAt,
});

/** `/Date(<ms>)/`, the portal's own instant encoding. */
const wcf = (iso: string): string => `/Date(${String(Date.parse(iso))})/`;

/** One synthetic `LoadUpcoming` row. */
function row(csn: string, iso: string, type: string): Record<string, unknown> {
  return {
    CSN: csn,
    Instant: wcf(iso),
    TimeZone: "UTC",
    VisitType: type,
    HealthSystemName: "P. Example, MD",
    DepartmentName: "Example Clinic",
  };
}

/**
 * A `LoadUpcoming` body spread across all three buckets and about seven months,
 * which is the shape the owner's live schedule has: something today, two in the
 * next few days' bucket, and four in the "later" list stretching into winter.
 */
function sevenMonthPayload(): Record<string, unknown> {
  return {
    InProgressVisits: [row("csn-1", "2026-06-01T02:00:00Z", "Lab draw")],
    NextNDaysVisits: [
      row("csn-2", "2026-06-08T15:00:00Z", "Follow-up"),
      row("csn-3", "2026-06-20T16:30:00Z", "Imaging"),
    ],
    LaterVisitsList: [
      // Deliberately out of order inside the bucket: the answer's order is the
      // tool's doing, not the payload's.
      row("csn-5", "2026-09-14T14:00:00Z", "Physical therapy"),
      row("csn-4", "2026-08-03T13:15:00Z", "Consult"),
      row("csn-7", "2026-12-21T17:45:00Z", "Annual physical"),
      row("csn-6", "2026-11-02T18:00:00Z", "Follow-up"),
    ],
  };
}

const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

async function reconnect(): Promise<void> {
  world.client = await connectTools(fakeDeps(world.state));
}

beforeEach(async () => {
  world.state = fakeState();
  await reconnect();
});

function portalItems(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return items.filter((item) => item.source === "portal");
}

describe("upcoming portal visits", () => {
  it("returns a stored upcoming visit in the appointment shape, marked as the portal's", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-a", start: "2026-06-10T15:00:00+00:00", isVideo: true })),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const [item] = portalItems(answer.items);

    expect(item).toMatchObject({
      resourceType: "Encounter",
      source: "portal",
      healthSystem: NAME_A,
      healthSystemId: HEALTH_SYSTEM_A,
      start: "2026-06-10T15:00:00+00:00",
      status: "scheduled",
      visitType: "Follow-up",
      practitioner: "P. Example, MD",
      department: "Example Clinic",
      telehealth: true,
      csn: "csn-a",
    });
    expect(item?.location).toMatchObject({ name: "Example Tower", phone: "555-0199" });
    // No Encounter behind it, so no Encounter id -- and no second copy of the CSN.
    expect(item).not.toHaveProperty("encounterId");
    // The FHIR items are marked too.
    expect(answer.items.find((entry) => entry.encounterId === "enc-future")?.source).toBe("fhir");
  });

  it("returns every visit across all three buckets and seven months, soonest first", async () => {
    const parsed = parseUpcoming(sevenMonthPayload(), "UTC");
    expect(parsed.visits).toHaveLength(7);
    world.state.portalVisits.set(
      HEALTH_SYSTEM_A,
      parsed.visits.map((value) => stored(value)),
    );

    const answer = await callTool(world.client, "get_appointments");

    expect(portalItems(answer.items).map((item) => item.csn)).toStrictEqual([
      "csn-1",
      "csn-2",
      "csn-3",
      "csn-4",
      "csn-5",
      "csn-6",
      "csn-7",
    ]);
    // The FHIR items interleave by date, and nothing is cut by a default limit
    // or a default upper bound.
    const starts = answer.items.map((item) => Date.parse(String(item.start)));
    expect(starts.every((start, index) => index === 0 || (starts[index - 1] ?? 0) <= start)).toBe(
      true,
    );
    expect(answer.items).toHaveLength(9);
    expect(answer.truncated).toBe(false);
  });

  it("reports a future visit the portal stopped listing as canceled", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-gone", start: "2026-06-10T15:00:00+00:00" }), true),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(portalItems(answer.items)[0]?.status).toBe("canceled");
  });
});

describe("one visit, one item", () => {
  it("merges a portal visit into the FHIR Encounter within the dedupe tolerance", async () => {
    // enc-future starts 2026-07-01T09:00Z; the portal says 09:03, which is the
    // minute-or-two disagreement the two sources have been seen to have. With no
    // CSN on the Encounter, the same practitioner is what makes it one visit.
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(
        visit({
          csn: "csn-dup",
          start: "2026-07-01T09:03:00+00:00",
          isVideo: true,
          practitioner: "Rivers, Ada MD",
        }),
      ),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const july = answer.items.filter((item) => String(item.start).startsWith("2026-07-01"));

    expect(july).toHaveLength(1);
    expect(july[0]).toMatchObject({
      source: "fhir",
      encounterId: "enc-future",
      // FHIR's own values win where it has them...
      practitioner: "Dr Ada Rivers",
      start: "2026-07-01T09:00:00Z",
      // ...and the portal fills in what it lacks.
      department: "Example Clinic",
      telehealth: true,
    });
  });

  it("keeps two visits apart when they are further apart than the tolerance", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-later", start: "2026-07-01T09:30:00+00:00" })),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const july = answer.items.filter((item) => String(item.start).startsWith("2026-07-01"));

    expect(july.map((item) => item.source)).toStrictEqual(["fhir", "portal"]);
  });

  it("never merges across health systems", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b", start: "2026-07-01T09:00:00+00:00" })),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const july = answer.items.filter((item) => String(item.start).startsWith("2026-07-01"));

    expect(july.map((item) => item.healthSystem)).toStrictEqual([NAME_A, NAME_B]);
  });
});

describe("arguments", () => {
  beforeEach(() => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-june", start: "2026-06-10T15:00:00+00:00" })),
      stored(visit({ csn: "csn-october", start: "2026-10-10T15:00:00+00:00" })),
    ]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b-june", start: "2026-06-11T15:00:00+00:00" })),
    ]);
  });

  it("windows portal visits on from/to", async () => {
    const answer = await callTool(world.client, "get_appointments", {
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(portalItems(answer.items).map((item) => item.csn)).toStrictEqual([
      "csn-b-june",
      "csn-june",
    ]);
  });

  it("narrows portal visits to the health systems asked for", async () => {
    const answer = await callTool(world.client, "get_appointments", { healthSystems: [NAME_B] });

    expect(portalItems(answer.items).map((item) => item.csn)).toStrictEqual(["csn-b-june"]);
  });

  it("keeps a past portal visit out of the default window and in with includePast", async () => {
    world.state.portalVisits.clear();
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-past", start: "2026-05-20T15:00:00+00:00" })),
    ]);

    const upcoming = await callTool(world.client, "get_appointments");
    const everything = await callTool(world.client, "get_appointments", { includePast: true });

    expect(portalItems(upcoming.items)).toStrictEqual([]);
    expect(portalItems(everything.items).map((item) => item.csn)).toStrictEqual(["csn-past"]);
  });

  it("applies limit after merging", async () => {
    const answer = await callTool(world.client, "get_appointments", { limit: 2 });

    expect(answer.items.map((item) => item.csn)).toStrictEqual(["csn-june", "csn-b-june"]);
    expect(answer.truncated).toBe(true);
  });
});

describe("the policy reaches portal items", () => {
  beforeEach(() => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-a", start: "2026-06-10T15:00:00+00:00" })),
    ]);
  });

  it("strips a field denied in the appointment view's own vocabulary", async () => {
    world.state.rules = rules(
      { rule_type: "field", target: "Encounter.practitioner" },
      { rule_type: "field", target: "Encounter.location" },
    );

    const answer = await callTool(world.client, "get_appointments");

    expect(answer.text).not.toContain("P. Example, MD");
    expect(answer.text).not.toContain("1 Example Way");
    expect(answer.text).not.toContain("555-0199");
    expect(portalItems(answer.items)).toHaveLength(1);
  });

  it("strips the view's practitioner for a rule written against the Encounter shape or raw FHIR", async () => {
    for (const target of ["Encounter.practitioners", "Encounter.participant"]) {
      world.state.rules = rules({ rule_type: "field", target });

      const answer = await callTool(world.client, "get_appointments");

      expect(answer.text, target).not.toContain("P. Example, MD");
      expect(answer.text, target).not.toContain("Dr Ada Rivers");
    }
  });

  it("strips the new source field when asked to", async () => {
    world.state.rules = rules({ rule_type: "field", target: "Encounter.source" });

    const answer = await callTool(world.client, "get_appointments");

    expect(answer.items.every((item) => !Object.hasOwn(item, "source"))).toBe(true);
  });

  it("drops portal items with a resource rule on Encounter, and with their health system", async () => {
    world.state.rules = rules({ rule_type: "resource", target: "Encounter" });
    const denied = await callTool(world.client, "get_appointments");
    expect(denied.items).toStrictEqual([]);

    world.state.rules = rules({ rule_type: "health_system", target: HEALTH_SYSTEM_A });
    const hidden = await callTool(world.client, "get_appointments");
    expect(hidden.text).not.toContain("csn-a");
    expect(hidden.text).not.toContain(NAME_A);
  });

  it("gives a portal item a bare placeholder for raw, and says so", async () => {
    const answer = await callTool(world.client, "get_appointments", { raw: true });
    const index = answer.items.findIndex((item) => item.source === "portal");

    expect(answer.raw?.[index]?.resource).toStrictEqual({ resourceType: "Encounter" });
    expect(answer.raw).toHaveLength(answer.items.length);
    expect(answer.warnings).toContain(PORTAL_RAW_WARNING);
  });
});

describe("get_health_summary", () => {
  it("leads its appointments section with the next portal visits", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [
      stored(visit({ csn: "csn-next", start: "2026-06-03T15:00:00+00:00" })),
      stored(visit({ csn: "csn-far", start: "2027-01-05T15:00:00+00:00" })),
    ]);

    const answer = await callTool(world.client, "get_health_summary");
    const appointments = answer.items.filter(
      (item) => item.kind === "recent" && item.section === "appointments",
    );

    // Upcoming soonest first, then the latest past visit to fill the section.
    expect(appointments.map((item) => item.csn ?? item.encounterId)).toStrictEqual([
      "csn-next",
      "enc-future",
      "enc-b",
      "csn-far",
      "enc-past",
    ]);
  });
});

describe("one visit, one item, across organisations", () => {
  // A visit at health system A that health system B's portal also lists (shared records).
  // Same appointment, seen a minute apart, with B's copy marked second-hand.
  const firstHand = visit({ csn: "csn-a1", start: "2026-06-10T15:00:00+00:00" });
  const secondHand = visit({
    csn: "csn-b9",
    start: "2026-06-10T15:01:00+00:00",
    practitioner: "Dr P Example",
    external: true,
  });

  it("answers with the owning organisation's copy when both are present", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(firstHand)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [stored(secondHand)]);

    const answer = await callTool(world.client, "get_appointments");
    const june = portalItems(answer.items).filter((item) =>
      String(item.start).startsWith("2026-06-10"),
    );

    expect(june).toHaveLength(1);
    expect(june[0]).toMatchObject({
      healthSystemId: HEALTH_SYSTEM_A,
      csn: "csn-a1",
      firstParty: true,
    });
    expect(june[0]).not.toHaveProperty("via");
  });

  it("keeps the second-hand copy, marked as such, when the owner has none", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [stored(secondHand)]);

    const answer = await callTool(world.client, "get_appointments");
    const june = portalItems(answer.items).filter((item) =>
      String(item.start).startsWith("2026-06-10"),
    );

    expect(june).toHaveLength(1);
    expect(june[0]).toMatchObject({
      healthSystemId: HEALTH_SYSTEM_B,
      firstParty: false,
      via: HEALTH_SYSTEM_B,
    });
  });

  it("prefers a fresh second-hand copy over the owner's stale one", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(firstHand, false, NOW - 5 * 86_400)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [stored(secondHand)]);

    const answer = await callTool(world.client, "get_appointments");
    const june = portalItems(answer.items).filter((item) =>
      String(item.start).startsWith("2026-06-10"),
    );

    expect(june.map((item) => item.healthSystemId)).toStrictEqual([HEALTH_SYSTEM_B]);
  });

  it("keeps two different visits at the same time, one at each organisation", async () => {
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(firstHand)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(
        visit({
          csn: "csn-b2",
          start: "2026-06-10T15:00:00+00:00",
          practitioner: "Q. Other, DO",
          department: "Other Clinic Dermatology",
          locationName: "Other Building",
        }),
      ),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const june = portalItems(answer.items).filter((item) =>
      String(item.start).startsWith("2026-06-10"),
    );

    expect(june.map((item) => item.csn)).toStrictEqual(["csn-a1", "csn-b2"]);
  });

  it("lets a FHIR Encounter claim another organisation's portal copy of it", async () => {
    // enc-shared is health system A's; B's portal lists it second-hand, same CSN.
    world.state.pools.get(HEALTH_SYSTEM_A)?.Encounter?.push({
      resourceType: "Encounter",
      id: "enc-shared",
      status: "planned",
      class: { code: "AMB" },
      identifier: [{ type: { text: "CSN" }, value: "csn-shared" }],
      period: { start: "2026-06-12T15:00:00Z" },
    });
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(
        visit({
          csn: "csn-shared",
          start: "2026-06-12T15:00:00+00:00",
          external: true,
        }),
      ),
    ]);

    const answer = await callTool(world.client, "get_appointments");
    const day = answer.items.filter((item) => String(item.start).startsWith("2026-06-12"));

    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ source: "fhir", healthSystemId: HEALTH_SYSTEM_A });
  });
});

function denyA(): void {
  world.state.rules = rules({ rule_type: "health_system", target: HEALTH_SYSTEM_A });
}

function onDay(items: readonly Record<string, unknown>[], day: string): Record<string, unknown>[] {
  return items.filter((item) => String(item.start).startsWith(day));
}

describe("a health_system deny rule reaches another organisation's copy (security review M1)", () => {
  // Health system A is denied. B's portal lists A's visit through a shared record,
  // stored and tagged as B's. The copy is A's data and must not be answered.
  const ownCopy = visit({ csn: "csn-a1", start: "2026-06-10T15:00:00+00:00" });

  it("drops B's marked copy of a denied visit", async () => {
    denyA();
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(ownCopy)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b9", start: "2026-06-10T15:01:00+00:00", external: true })),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(onDay(answer.items, "2026-06-10")).toStrictEqual([]);
    expect(answer.text).not.toContain("csn-b9");
    expect(answer.text).not.toContain("csn-a1");
  });

  it("drops B's copy even when nothing marks it as second-hand", async () => {
    // The external flag is a guess; an undetected copy arrives as first-party.
    denyA();
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(ownCopy)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b9", start: "2026-06-10T15:01:00+00:00" })),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(onDay(answer.items, "2026-06-10")).toStrictEqual([]);
    expect(answer.text).not.toContain("csn-b9");
  });

  it("drops B's copy when the denied organisation's own copy is stale and would have lost", async () => {
    denyA();
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(ownCopy, false, NOW - 5 * 86_400)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b9", start: "2026-06-10T15:01:00+00:00", external: true })),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(onDay(answer.items, "2026-06-10")).toStrictEqual([]);
  });

  it("drops B's copy of a denied organisation's cached Encounter, matched by CSN", async () => {
    denyA();
    world.state.pools.get(HEALTH_SYSTEM_A)?.Encounter?.push({
      resourceType: "Encounter",
      id: "enc-denied",
      status: "planned",
      class: { code: "AMB" },
      identifier: [{ type: { text: "CSN" }, value: "csn-denied" }],
      period: { start: "2026-06-12T15:00:00Z" },
    });
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-denied", start: "2026-06-12T15:00:00+00:00", external: true })),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(onDay(answer.items, "2026-06-12")).toStrictEqual([]);
    expect(answer.text).not.toContain("csn-denied");
  });

  it("drops the copy from get_health_summary's appointments too", async () => {
    denyA();
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(ownCopy)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b9", start: "2026-06-10T15:01:00+00:00", external: true })),
    ]);

    const answer = await callTool(world.client, "get_health_summary");

    expect(answer.text).not.toContain("csn-b9");
    expect(answer.text).not.toContain("csn-a1");
    expect(answer.text).not.toContain(NAME_A);
  });

  it("keeps B's own, different visit at the same time", async () => {
    denyA();
    world.state.portalVisits.set(HEALTH_SYSTEM_A, [stored(ownCopy)]);
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(
        visit({
          csn: "csn-b2",
          start: "2026-06-10T15:00:00+00:00",
          practitioner: "Q. Other, DO",
          department: "Other Clinic Dermatology",
          locationName: "Other Building",
        }),
      ),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(onDay(answer.items, "2026-06-10").map((item) => item.csn)).toStrictEqual(["csn-b2"]);
  });

  it("keeps a copy it cannot attribute: the denied organisation has no record of it", async () => {
    // The documented residual gap (SECURITY.md): the copy does not say whose it
    // is, and the denied organisation has nothing stored to match it against.
    denyA();
    world.state.portalVisits.set(HEALTH_SYSTEM_B, [
      stored(visit({ csn: "csn-b9", start: "2026-06-10T15:01:00+00:00", external: true })),
    ]);

    const answer = await callTool(world.client, "get_appointments");

    expect(onDay(answer.items, "2026-06-10")).toMatchObject([
      { healthSystemId: HEALTH_SYSTEM_B, firstParty: false, via: HEALTH_SYSTEM_B },
    ]);
  });
});
