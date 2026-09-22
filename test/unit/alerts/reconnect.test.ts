import { describe, expect, it } from "vitest";

import { buildReconnectCard } from "../../../worker/alerts/reconnect.ts";

// Privacy: synthetic provider name and URL only, per this module's test convention.
const PROVIDER_NAME = "Test Health Provider";
const RECONNECT_URL = "https://healthy.example.test/reconnect/abc";
const OCCURRED_AT = new Date("2026-09-21T21:34:56.000Z");

describe("buildReconnectCard", () => {
  it("titles the card 'Reconnect <providerName> to Healthy'", () => {
    const { title } = buildReconnectCard({
      kind: "epic",
      providerName: PROVIDER_NAME,
      reconnectUrl: RECONNECT_URL,
      occurredAt: OCCURRED_AT,
    });

    expect(title).toBe(`Reconnect ${PROVIDER_NAME} to Healthy`);
  });

  it("includes the reconnect url, the provider name, and a 3-step numbered list, under 900 chars", () => {
    const { description } = buildReconnectCard({
      kind: "epic",
      providerName: PROVIDER_NAME,
      reconnectUrl: RECONNECT_URL,
      reason: "token expired",
      occurredAt: OCCURRED_AT,
    });

    expect(description).toContain(RECONNECT_URL);
    expect(description).toContain(PROVIDER_NAME);
    expect(description).toContain("token expired");
    expect(description).toMatch(/1\. Open/);
    expect(description).toMatch(/2\. Click/);
    expect(description).toMatch(/3\. Done/);
    expect(description.length).toBeLessThan(900);
  });

  it("adds the consent-screen note for kind 'epic' only", () => {
    const epic = buildReconnectCard({
      kind: "epic",
      providerName: PROVIDER_NAME,
      reconnectUrl: RECONNECT_URL,
      occurredAt: OCCURRED_AT,
    });
    const google = buildReconnectCard({
      kind: "google",
      providerName: "Google",
      reconnectUrl: RECONNECT_URL,
      occurredAt: OCCURRED_AT,
    });

    expect(epic.description).toContain("consent screen");
    expect(epic.description).toContain("data categories");
    expect(google.description).not.toContain("consent screen");
  });

  it("mentions Google, not 'the patient portal', for kind 'google'", () => {
    const { description } = buildReconnectCard({
      kind: "google",
      providerName: "Google",
      reconnectUrl: RECONNECT_URL,
      occurredAt: OCCURRED_AT,
    });

    expect(description).toContain("sign in to Google when redirected");
    expect(description).not.toContain("patient portal");
  });

  it("omits the parenthetical reason when none is given", () => {
    const { description } = buildReconnectCard({
      kind: "epic",
      providerName: PROVIDER_NAME,
      reconnectUrl: RECONNECT_URL,
      occurredAt: OCCURRED_AT,
    });

    expect(description).toMatch(new RegExp(`stopped working at `));
  });

  it("stays under 900 chars even with a very long reason", () => {
    const { description } = buildReconnectCard({
      kind: "epic",
      providerName: PROVIDER_NAME,
      reconnectUrl: RECONNECT_URL,
      reason: "x".repeat(5000),
      occurredAt: OCCURRED_AT,
    });

    expect(description.length).toBeLessThan(900);
  });

  it("renders the occurrence time in UTC without asserting a local timezone", () => {
    const { description } = buildReconnectCard({
      kind: "epic",
      providerName: PROVIDER_NAME,
      reconnectUrl: RECONNECT_URL,
      occurredAt: OCCURRED_AT,
    });

    expect(description).toContain("2026-09-21 21:34 UTC");
  });
});
