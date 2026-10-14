import { describe, expect, it } from "vitest";

import { buildSyncFailingCard } from "../../../src/alerts/sync-failing.ts";

// Privacy: a synthetic health system name and URL only, per this module's test convention.
const HEALTH_SYSTEM_NAME = "Test Health";
const PAGE_URL = "https://healthy.example.test/health-systems";
const FAILING_SINCE = new Date("2026-09-21T21:34:56.000Z");

function card(overrides: Partial<Parameters<typeof buildSyncFailingCard>[0]> = {}) {
  return buildSyncFailingCard({
    kind: "health_system",
    healthSystemName: HEALTH_SYSTEM_NAME,
    check: "calendar",
    errorCode: "upstream_unavailable",
    failures: 3,
    failingSince: FAILING_SINCE,
    pageUrl: PAGE_URL,
    ...overrides,
  });
}

describe("buildSyncFailingCard", () => {
  it("titles the card by what cannot be synced", () => {
    expect(card().title).toBe(`Healthy cannot sync ${HEALTH_SYSTEM_NAME}`);
    expect(card({ kind: "portal" }).title).toBe(
      `Healthy cannot sync ${HEALTH_SYSTEM_NAME} patient portal`,
    );
    expect(card({ kind: "google" }).title).toBe("Healthy cannot sync Google Calendar");
    expect(card({ kind: "run" }).title).toBe("Healthy's sync keeps stopping");
  });

  it("says what is failing, the code, how many runs, since when in UTC, and where to look", () => {
    const { description } = card();

    expect(description).toContain(`The appointment sync for ${HEALTH_SYSTEM_NAME} has failed`);
    expect(description).toContain("3 runs in a row");
    expect(description).toContain("since 2026-09-21 21:34 UTC");
    expect(description).toContain("(upstream_unavailable)");
    expect(description).toContain(PAGE_URL);
    expect(description).toMatch(/1\. Open/u);
    expect(description).toMatch(/2\. Nothing needs/u);
    expect(description).toMatch(/3\. Done — this card completes itself/u);
    expect(description.length).toBeLessThanOrEqual(900);
  });

  it("names the pass that is failing", () => {
    expect(card({ check: "refresh" }).description).toContain("The refresh of the full record for");
    expect(card({ kind: "portal", check: "visits" }).description).toContain(
      "The sync of portal visits for",
    );
    expect(card({ kind: "portal", check: "messages" }).description).toContain(
      "Reading portal messages for",
    );
    expect(card({ kind: "google" }).description).toContain(
      "Reading or writing the calendar for Google Calendar",
    );
  });

  it("never tells the owner to reconnect or re-enter anything", () => {
    for (const kind of ["health_system", "portal", "google", "run"] as const) {
      const { title, description } = card({ kind });
      const text = `${title}\n${description}`;

      expect(text).not.toMatch(/\breconnect\b(?!ing)/iu);
      expect(text).not.toMatch(/re-enter (?:the|your) password/iu);
      expect(text).not.toContain("consent");
      expect(text).toMatch(/Nothing needs (?:reconnecting|re-entering)/u);
    }
  });

  it("tells the owner of a portal the one thing they can do", () => {
    const { description } = card({ kind: "portal", check: "visits" });

    expect(description).toContain('press "Sign in now"');
    expect(card().description).not.toContain("Sign in now");
  });

  it("describes a run that stopped without naming a health system", () => {
    const { description } = card({ kind: "run", errorCode: "internal" });

    expect(description).toContain(
      "The appointment sync has stopped before reaching any health system 3 runs in a row",
    );
    expect(description).toContain("(internal)");
    expect(description).not.toContain(HEALTH_SYSTEM_NAME);
    expect(card({ kind: "run", check: "refresh" }).description).toContain(
      "The refresh of the full record has stopped",
    );
  });

  it("keeps a very long name or code from crowding everything else out", () => {
    const { title, description } = card({
      healthSystemName: "x".repeat(2000),
      errorCode: "y".repeat(2000),
    });

    expect(title.length).toBeLessThan(120);
    expect(description.length).toBeLessThanOrEqual(900);
    expect(description).toContain("1. Open");
  });
});
