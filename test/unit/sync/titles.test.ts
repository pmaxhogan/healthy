// The owner's title edits must never be overwritten; these pin the pieces the
// two passes share. The ownership rules themselves are in plan.test.ts, where
// they meet the rest of the diff.

import { describe, expect, it } from "vitest";

import { blinderFor } from "../../../worker/db/blind.ts";
import {
  titleDigest,
  titleDigestsFor,
  titledBody,
  titleSeeds,
} from "../../../worker/sync/titles.ts";

import type { CalendarEventRow } from "../../../worker/db/rows.ts";
import type {
  CalendarEventBody,
  CalendarEventModel,
  EventRecord,
} from "../../../worker/google/types.ts";

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}
const BLINDER = blinderFor(randomKey());

const BODY: CalendarEventBody = {
  summary: "Office Visit",
  description: "block",
  start: { dateTime: "2026-10-01T15:30:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-10-01T16:00:00Z", timeZone: "UTC" },
  visibility: "private",
  transparency: "opaque",
  extendedProperties: { private: { healthy: "1", key: "k", fp: "f", healthSystem: "hs" } },
  reminders: { useDefault: true },
};

describe("titleDigest", () => {
  it("is keyed and deterministic, and never the title itself", async () => {
    const one = await titleDigest(BLINDER, "hs-1", "Office Visit · Casey Example");
    expect(await titleDigest(BLINDER, "hs-1", "Office Visit · Casey Example")).toBe(one);
    expect(one).not.toContain("Casey");
    expect(await titleDigest(BLINDER, "hs-2", "Office Visit · Casey Example")).not.toBe(one);
  });
});

describe("titleDigestsFor", () => {
  it("digests Google's title and both models' by event key", async () => {
    const event = {
      id: "g-1",
      summary: "Mine",
      extendedProperties: null,
    } as unknown as EventRecord;
    const model = { title: "Office Visit" } as CalendarEventModel;
    const out = await titleDigestsFor(BLINDER, "hs-1", {
      events: [event],
      keyOf: () => "key-1",
      models: new Map([["key-1", model]]),
      ghosts: new Map([["key-1", { title: "Cancelled: Office Visit" } as CalendarEventModel]]),
    });

    expect(out.get("key-1")).toStrictEqual({
      google: await titleDigest(BLINDER, "hs-1", "Mine"),
      active: await titleDigest(BLINDER, "hs-1", "Office Visit"),
      ghost: await titleDigest(BLINDER, "hs-1", "Cancelled: Office Visit"),
    });
  });
});

describe("titledBody", () => {
  it("leaves `summary` out only when the owner holds the title", () => {
    expect(titledBody(BODY, { keepTitle: false })).toBe(BODY);
    const kept = titledBody(BODY, { keepTitle: true });
    expect("summary" in kept).toBe(false);
    expect(kept.description).toBe("block");
  });
});

describe("titleSeeds", () => {
  it("seeds only rows that have no digest yet", () => {
    const rows = [
      { event_key: "a", title_digest: null },
      { event_key: "b", title_digest: "~kept" },
    ] as CalendarEventRow[];
    const seeds = titleSeeds(
      [
        { key: "a", titleDigest: "~new" },
        { key: "b", titleDigest: "~other" },
        { key: "c", titleDigest: null },
      ],
      rows,
    );

    expect(seeds).toStrictEqual([{ eventKey: "a", titleDigest: "~new" }]);
  });
});
