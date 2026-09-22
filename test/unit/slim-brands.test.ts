import { describe, expect, it } from "vitest";

import { searchBrands, slimBrandsBundle } from "../../scripts/lib/slim-brands.mjs";

// A tiny synthetic FHIR Bundle covering:
//  - Org A: R4 endpoint, active -> should be included
//  - Org B: shares the *same* fhirBaseUrl as Org A (different Endpoint resource,
//    identical address string, trailing slash) -> should be deduped into Org A's
//    record as an alias, not a separate brand
//  - Org C: DSTU2 endpoint -> excluded (not R4)
//  - Org D: R4 endpoint but status "suspended" (inactive) -> excluded
//  - Two location Organizations partOf Org A, for the `locations` field
function buildSyntheticBundle() {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        fullUrl: "urn:uuid:org-a",
        resource: {
          resourceType: "Organization",
          id: "org-a",
          name: "Riverside Health",
          endpoint: [{ reference: "urn:uuid:endpoint-a" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-a",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-a",
          status: "active",
          address: "https://riverside.example.com/api/FHIR/R4",
          extension: [
            {
              url: "https://hl7.org/fhir/StructureDefinition/endpoint-fhir-version",
              valueCode: "4.0.1",
            },
          ],
        },
      },
      {
        fullUrl: "urn:uuid:org-b",
        resource: {
          resourceType: "Organization",
          id: "org-b",
          name: "Riverside Medical Group",
          endpoint: [{ reference: "urn:uuid:endpoint-b" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-b",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-b",
          status: "active",
          // Same base URL as endpoint-a, just with a trailing slash — must
          // normalize and dedupe against Org A's record.
          address: "https://riverside.example.com/api/FHIR/R4/",
        },
      },
      {
        fullUrl: "urn:uuid:org-c",
        resource: {
          resourceType: "Organization",
          id: "org-c",
          name: "Legacy Clinic",
          endpoint: [{ reference: "urn:uuid:endpoint-c" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-c",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-c",
          status: "active",
          // DSTU2, not R4 - must be excluded.
          address: "https://legacy.example.com/api/DSTU2",
        },
      },
      {
        fullUrl: "urn:uuid:org-d",
        resource: {
          resourceType: "Organization",
          id: "org-d",
          name: "Suspended Health System",
          endpoint: [{ reference: "urn:uuid:endpoint-d" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-d",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-d",
          // Inactive - must be excluded even though it's R4.
          status: "suspended",
          address: "https://suspended.example.com/api/FHIR/R4",
        },
      },
      {
        fullUrl: "urn:uuid:loc-1",
        resource: {
          resourceType: "Organization",
          id: "loc-1",
          name: "Riverside Downtown Clinic",
          partOf: { reference: "urn:uuid:org-a" },
          address: [{ city: "Springfield", state: "IL" }],
        },
      },
      {
        fullUrl: "urn:uuid:loc-2",
        resource: {
          resourceType: "Organization",
          id: "loc-2",
          name: "Riverside North Clinic",
          partOf: { reference: "urn:uuid:org-a" },
          address: [{ city: "Decatur", state: "IL" }],
        },
      },
    ],
  };
}

describe("slimBrandsBundle", () => {
  it("filters out non-R4 and inactive endpoints", () => {
    const result = slimBrandsBundle(buildSyntheticBundle());
    const names = result.flatMap((b) => [b.name, ...(b.aliases || [])]);
    expect(names).not.toContain("Legacy Clinic");
    expect(names).not.toContain("Suspended Health System");
  });

  it("dedupes by normalized fhirBaseUrl and merges aliases", () => {
    const result = slimBrandsBundle(buildSyntheticBundle());
    const riverside = result.find((b) => b.name === "Riverside Health");
    expect(riverside).toBeDefined();
    expect(riverside?.fhirBaseUrl).toBe("https://riverside.example.com/api/FHIR/R4");
    expect(riverside?.aliases).toEqual(["Riverside Medical Group"]);

    // Only one brand record should exist for the shared base URL.
    const matchingRiverside = result.filter(
      (b) => b.fhirBaseUrl === "https://riverside.example.com/api/FHIR/R4",
    );
    expect(matchingRiverside).toHaveLength(1);
  });

  it("normalizes fhirBaseUrl to have no trailing slash", () => {
    const result = slimBrandsBundle(buildSyntheticBundle());
    for (const brand of result) {
      expect(brand.fhirBaseUrl.endsWith("/")).toBe(false);
    }
  });

  it('collects up to 5 locations as "city, state"', () => {
    const result = slimBrandsBundle(buildSyntheticBundle());
    const riverside = result.find((b) => b.name === "Riverside Health");
    expect(riverside?.locations).toEqual(
      expect.arrayContaining(["Springfield, IL", "Decatur, IL"]),
    );
    expect(riverside?.locations?.length).toBeLessThanOrEqual(5);
  });

  it("sorts the result by name (case-insensitive)", () => {
    const result = slimBrandsBundle(buildSyntheticBundle());
    const names = result.map((b) => b.name);
    const sorted = [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    expect(names).toEqual(sorted);
  });

  it("uses the Organization id as the stable key", () => {
    const result = slimBrandsBundle(buildSyntheticBundle());
    const riverside = result.find((b) => b.name === "Riverside Health");
    expect(riverside?.id).toBe("org-a");
  });
});

describe("searchBrands", () => {
  const brands = slimBrandsBundle(buildSyntheticBundle());

  it("matches case-insensitively on name", () => {
    const matches = searchBrands(brands, "riverside");
    expect(matches.map((b) => b.name)).toContain("Riverside Health");
  });

  it("matches on aliases", () => {
    const matches = searchBrands(brands, "medical group");
    expect(matches.map((b) => b.name)).toContain("Riverside Health");
  });

  it("matches on locations", () => {
    const matches = searchBrands(brands, "decatur");
    expect(matches.map((b) => b.name)).toContain("Riverside Health");
  });

  it("returns at most 20 results", () => {
    const manyBrands = Array.from({ length: 30 }, (_, i) => ({
      id: `brand-${i}`,
      name: `Test Brand ${i}`,
      fhirBaseUrl: `https://example${i}.com/api/FHIR/R4`,
    }));
    const matches = searchBrands(manyBrands, "test brand");
    expect(matches.length).toBeLessThanOrEqual(20);
  });

  it("returns an empty array for a non-matching query", () => {
    expect(searchBrands(brands, "nonexistent-brand-xyz")).toEqual([]);
  });
});
