import { describe, expect, it } from "vitest";

import { buildParkedCard } from "../../../src/alerts/parked.ts";

// Privacy: a synthetic device name and URL only, per this module's test convention.
const DEVICE_NAME = "Example phone";
const PHONE_URL = "https://healthy.example.test/phone";
const OCCURRED_AT = new Date("2026-09-21T21:34:56.000Z");

function card(overrides: Partial<Parameters<typeof buildParkedCard>[0]> = {}) {
  return buildParkedCard({
    deviceName: DEVICE_NAME,
    phoneUrl: PHONE_URL,
    batches: 2,
    errorCodes: ["apply_gave_up"],
    occurredAt: OCCURRED_AT,
    ...overrides,
  });
}

describe("buildParkedCard", () => {
  it("titles the card by the phone's name", () => {
    expect(card().title).toBe(`Uploads from ${DEVICE_NAME} are waiting in Healthy`);
  });

  it("says how many, why by code, that nothing is lost, and where to look", () => {
    const { description } = card();

    expect(description).toContain("2 uploads");
    expect(description).toContain("(apply_gave_up)");
    expect(description).toContain("2026-09-21 21:34 UTC");
    expect(description).toContain("Nothing was lost");
    expect(description).toContain(PHONE_URL);
    expect(description).toMatch(/1\. Open/u);
    expect(description).toMatch(/2\. Find the phone/u);
    expect(description).toMatch(/3\. Done/u);
    expect(description.length).toBeLessThan(900);
  });

  it("counts one upload in the singular, and lists several codes", () => {
    expect(card({ batches: 1 }).description).toContain("1 upload from");
    expect(card({ errorCodes: ["crypto", "apply_gave_up"] }).description).toContain(
      "(crypto, apply_gave_up)",
    );
    expect(card({ errorCodes: [] }).description).toContain("could not be applied at");
  });

  it("keeps a very long name from crowding everything else out", () => {
    const { title, description } = card({ deviceName: "x".repeat(2000) });

    expect(title.length).toBeLessThan(140);
    expect(description.length).toBeLessThanOrEqual(900);
    expect(description).toContain("Nothing was lost");
  });
});
