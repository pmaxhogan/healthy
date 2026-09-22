import { describe, expect, it } from "vitest";

import {
  address,
  codeText,
  dedupeStrings,
  humanName,
  period,
  phone,
  pickDate,
  quantity,
} from "../../../../worker/fhir/normalize/helpers.ts";

describe("codeText", () => {
  it("prefers .text", () => {
    expect(codeText({ text: "Office visit", coding: [{ display: "Other" }] })).toBe("Office visit");
  });

  it("falls back to the first coding's display, then code", () => {
    expect(codeText({ coding: [{ display: "Video visit" }] })).toBe("Video visit");
    expect(codeText({ coding: [{ code: "VR" }] })).toBe("VR");
  });

  it("is undefined for empty input", () => {
    expect(codeText()).toBeUndefined();
    expect(codeText({})).toBeUndefined();
  });
});

describe("humanName", () => {
  it("prefers an official name over other uses", () => {
    const name = humanName([
      { use: "nickname", text: "Nickname" },
      { use: "official", family: "Example", given: ["Ada"], prefix: ["Dr."] },
    ]);
    expect(name).toBe("Dr. Ada Example");
  });

  it("accepts a single HumanName", () => {
    expect(humanName({ text: "Dr. Ada Example" })).toBe("Dr. Ada Example");
  });

  it("builds from parts when .text is absent", () => {
    expect(humanName({ given: ["Ada"], family: "Example" })).toBe("Ada Example");
  });

  it("is undefined for empty input", () => {
    expect(humanName()).toBeUndefined();
    expect(humanName([])).toBeUndefined();
  });
});

describe("address", () => {
  it("extracts lines/city/state/postalCode from the first address", () => {
    expect(
      address([
        { line: ["100 Example St"], city: "Example City", state: "EX", postalCode: "00000" },
      ]),
    ).toEqual({
      lines: ["100 Example St"],
      city: "Example City",
      state: "EX",
      postalCode: "00000",
    });
  });

  it("accepts a single Address", () => {
    expect(address({ city: "Example City" })).toEqual({ city: "Example City" });
  });

  it("is undefined when there is nothing to report", () => {
    expect(address()).toBeUndefined();
    expect(address({})).toBeUndefined();
    expect(address([])).toBeUndefined();
  });
});

describe("phone", () => {
  it("prefers a work phone", () => {
    expect(
      phone([
        { system: "phone", value: "555-010-0111", use: "home" },
        { system: "phone", value: "555-010-0199", use: "work" },
      ]),
    ).toBe("555-010-0199");
  });

  it("falls back to the first phone entry", () => {
    expect(phone([{ system: "phone", value: "555-010-0111" }])).toBe("555-010-0111");
  });

  it("ignores non-phone entries and is undefined without one", () => {
    expect(phone([{ system: "email", value: "ada@example.com" }])).toBeUndefined();
    expect(phone()).toBeUndefined();
  });
});

describe("period", () => {
  it("returns start/end when present", () => {
    expect(period({ start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" })).toEqual({
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
    });
  });

  it("is undefined for an empty or missing period", () => {
    expect(period({})).toBeUndefined();
    expect(period()).toBeUndefined();
  });
});

describe("quantity", () => {
  it("keeps value and unit", () => {
    expect(quantity({ value: 98.6, unit: "degF" })).toEqual({ value: 98.6, unit: "degF" });
  });

  it("is undefined without a value", () => {
    expect(quantity({ unit: "degF" })).toBeUndefined();
    expect(quantity()).toBeUndefined();
  });
});

describe("pickDate", () => {
  it("returns the first defined date", () => {
    expect(pickDate(undefined, "", "2026-01-01")).toBe("2026-01-01");
  });

  it("is undefined when nothing is defined", () => {
    expect(pickDate(undefined, undefined)).toBeUndefined();
  });
});

describe("dedupeStrings", () => {
  it("drops undefined/empty and de-duplicates, preserving order", () => {
    expect(dedupeStrings(["a", undefined, "b", "a", ""])).toEqual(["a", "b"]);
  });
});
