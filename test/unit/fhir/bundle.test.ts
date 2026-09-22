import { describe, expect, it } from "vitest";

import {
  entriesOf,
  isBundle,
  isRecord,
  nextLink,
  resourceKey,
  resourcesOfType,
  splitEntries,
} from "../../../worker/fhir/bundle.ts";
import { loadFixture } from "../providers/fixtures.ts";

import type { Bundle, BundleEntry, Encounter } from "../../../worker/fhir/types.ts";

const page1 = loadFixture<Bundle>("encounter-bundle-page1.json");
const page2 = loadFixture<Bundle>("encounter-bundle-page2.json");
const page3 = loadFixture<Bundle>("encounter-bundle-page3.json");
const mixed = loadFixture<Bundle>("outcome-4119-mixed.json");
const empty: Bundle = { resourceType: "Bundle", type: "searchset", total: 0 };

describe("isRecord", () => {
  it("accepts objects and arrays and rejects null and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("Bundle")).toBe(false);
  });
});

describe("isBundle", () => {
  it("keys off resourceType only", () => {
    expect(isBundle(page1)).toBe(true);
    expect(isBundle({ resourceType: "OperationOutcome" })).toBe(false);
    expect(isBundle(null)).toBe(false);
  });
});

describe("entriesOf", () => {
  it("returns the entries, or an empty array when the search matched nothing", () => {
    expect(entriesOf(page1)).toHaveLength(2);
    expect(entriesOf(empty)).toStrictEqual([]);
  });
});

describe("nextLink", () => {
  it("finds the next page and ignores self", () => {
    expect(nextLink(page1)).toContain("continue-token=synthetic-page-2");
    expect(nextLink(page2)).toContain("continue-token=synthetic-page-3");
  });

  it("returns null on the last page and on a bundle with no links", () => {
    expect(nextLink(page3)).toBeNull();
    expect(nextLink(empty)).toBeNull();
  });
});

describe("resourcesOfType", () => {
  it("picks out one type, including entries that came in as includes", () => {
    expect(resourcesOfType<Encounter>(page2, "Encounter")).toHaveLength(2);
    expect(resourcesOfType(page2, "Location")).toHaveLength(1);
    expect(resourcesOfType(page2, "Practitioner")).toStrictEqual([]);
  });
});

describe("splitEntries", () => {
  it("keeps OperationOutcome entries out of the matches", () => {
    const { matches, outcomes } = splitEntries(mixed);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.resourceType).toBe("Encounter");
    expect(outcomes).toHaveLength(1);
  });

  it("also treats an OperationOutcome with no search.mode as an outcome", () => {
    const bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        { resource: { resourceType: "OperationOutcome", issue: [] } },
        { resource: { resourceType: "Encounter", id: "enc-x" } },
      ],
    } as unknown as Bundle;

    const { matches, outcomes } = splitEntries(bundle);

    expect(outcomes).toHaveLength(1);
    expect(matches).toHaveLength(1);
  });

  it("drops entries with no resource at all", () => {
    const entry: BundleEntry[] = [
      { fullUrl: "https://fhir.example-health.test/api/FHIR/R4/Encounter/enc-y" },
    ];
    const bundle: Bundle = { resourceType: "Bundle", type: "searchset", entry };

    expect(splitEntries(bundle).matches).toStrictEqual([]);
    expect(splitEntries(bundle).outcomes).toStrictEqual([]);
  });
});

describe("resourceKey", () => {
  it("is Type/id, and stays usable when either half is missing", () => {
    expect(resourceKey({ resourceType: "Encounter", id: "enc-1" })).toBe("Encounter/enc-1");
    expect(resourceKey({ resourceType: "Encounter" })).toBe("Encounter/");
  });
});
