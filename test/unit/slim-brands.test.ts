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

// A second synthetic bundle, purpose-built to exercise canonical-name selection
// for a shared endpoint: the first-seen Organization is not always the right
// display name, and the slimmer has to pick a better one instead of just taking
// whichever the bundle happened to list first.
//
//  - Endpoint "shared-by-locations": "Tiny Affiliate" (first-seen, 0 locations)
//    and "Big Health System" (second-seen, 3 locations) -- the one with more
//    locations should become canonical, even though it was seen second.
//  - Endpoint "shared-by-managing-org": "Some Clinic" (first-seen, 2 locations)
//    and "Regional Health" (second-seen, 1 location, but its name matches the
//    Endpoint's own `managingOrganization.display`) -- the managing-org match
//    outranks the location count.
//  - Endpoint "shared-tie": two organizations with equal (zero) location counts
//    and no managing-org match -- the first-seen one stays canonical, so the
//    weekly refresh does not reshuffle a tie for no reason.
//  - Endpoint "solo": a single organization, not shared with anyone -- must come
//    out with no `aliases` field at all.
function buildCanonicalNameBundle() {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      // shared-by-locations: Tiny Affiliate (first-seen) vs. Big Health System.
      {
        fullUrl: "urn:uuid:tiny-affiliate",
        resource: {
          resourceType: "Organization",
          id: "tiny-affiliate",
          name: "Tiny Affiliate",
          endpoint: [{ reference: "urn:uuid:endpoint-locations" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-locations",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-locations",
          status: "active",
          address: "https://shared.example.test/api/FHIR/R4",
        },
      },
      {
        fullUrl: "urn:uuid:big-health-system",
        resource: {
          resourceType: "Organization",
          id: "big-health-system",
          name: "Big Health System",
          endpoint: [{ reference: "urn:uuid:endpoint-locations-2" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-locations-2",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-locations-2",
          status: "active",
          // Same base URL as endpoint-locations -- shares the endpoint.
          address: "https://shared.example.test/api/FHIR/R4",
        },
      },
      {
        fullUrl: "urn:uuid:big-loc-1",
        resource: {
          resourceType: "Organization",
          id: "big-loc-1",
          name: "Big Health System North",
          partOf: { reference: "urn:uuid:big-health-system" },
          address: [{ city: "Northtown", state: "ZZ" }],
        },
      },
      {
        fullUrl: "urn:uuid:big-loc-2",
        resource: {
          resourceType: "Organization",
          id: "big-loc-2",
          name: "Big Health System South",
          partOf: { reference: "urn:uuid:big-health-system" },
          address: [{ city: "Southtown", state: "ZZ" }],
        },
      },
      {
        fullUrl: "urn:uuid:big-loc-3",
        resource: {
          resourceType: "Organization",
          id: "big-loc-3",
          name: "Big Health System East",
          partOf: { reference: "urn:uuid:big-health-system" },
          address: [{ city: "Easttown", state: "ZZ" }],
        },
      },

      // shared-by-managing-org: Some Clinic (first-seen, more locations) vs.
      // Regional Health (second-seen, fewer locations, but named on the endpoint).
      {
        fullUrl: "urn:uuid:some-clinic",
        resource: {
          resourceType: "Organization",
          id: "some-clinic",
          name: "Some Clinic",
          endpoint: [{ reference: "urn:uuid:endpoint-managing" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-managing",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-managing",
          status: "active",
          address: "https://managed.example.test/api/FHIR/R4",
          managingOrganization: { display: "Regional Health" },
        },
      },
      {
        fullUrl: "urn:uuid:some-clinic-loc",
        resource: {
          resourceType: "Organization",
          id: "some-clinic-loc",
          name: "Some Clinic Annex",
          partOf: { reference: "urn:uuid:some-clinic" },
          address: [{ city: "Clinicville", state: "ZZ" }],
        },
      },
      {
        fullUrl: "urn:uuid:regional-health",
        resource: {
          resourceType: "Organization",
          id: "regional-health",
          // Matches the endpoint's managingOrganization.display ("Regional
          // Health") modulo case, which the comparison must ignore.
          name: "REGIONAL HEALTH",
          endpoint: [{ reference: "urn:uuid:endpoint-managing-2" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-managing-2",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-managing-2",
          status: "active",
          address: "https://managed.example.test/api/FHIR/R4",
          // A separate Endpoint resource for the same shared instance (as real
          // Epic data occasionally has), but naming the same managing
          // organisation -- the signal is read per-candidate, from each
          // Organization's own referenced Endpoint.
          managingOrganization: { display: "Regional Health" },
        },
      },

      // shared-tie: two organizations, equal (zero) location counts, no
      // managing-org match -- first-seen must stay canonical.
      {
        fullUrl: "urn:uuid:tie-first",
        resource: {
          resourceType: "Organization",
          id: "tie-first",
          name: "Tie First Seen",
          endpoint: [{ reference: "urn:uuid:endpoint-tie" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-tie",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-tie",
          status: "active",
          address: "https://tie.example.test/api/FHIR/R4",
        },
      },
      {
        fullUrl: "urn:uuid:tie-second",
        resource: {
          resourceType: "Organization",
          id: "tie-second",
          name: "Tie Second Seen",
          endpoint: [{ reference: "urn:uuid:endpoint-tie-2" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-tie-2",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-tie-2",
          status: "active",
          address: "https://tie.example.test/api/FHIR/R4",
        },
      },

      // solo: a single organization, not shared with anyone.
      {
        fullUrl: "urn:uuid:solo-org",
        resource: {
          resourceType: "Organization",
          id: "solo-org",
          name: "Solo Health",
          endpoint: [{ reference: "urn:uuid:endpoint-solo" }],
        },
      },
      {
        fullUrl: "urn:uuid:endpoint-solo",
        resource: {
          resourceType: "Endpoint",
          id: "endpoint-solo",
          status: "active",
          address: "https://solo.example.test/api/FHIR/R4",
        },
      },
    ],
  };
}

describe("canonical name selection for a shared endpoint", () => {
  const result = slimBrandsBundle(buildCanonicalNameBundle());

  it("picks the organisation with the most locations as canonical, not whichever came first", () => {
    const brand = result.find((b) => b.fhirBaseUrl === "https://shared.example.test/api/FHIR/R4");

    expect(brand?.name).toBe("Big Health System");
    expect(brand?.aliases).toEqual(["Tiny Affiliate"]);
    // The id follows the winning organisation, not the first-seen one.
    expect(brand?.id).toBe("big-health-system");
  });

  it("prefers a name matching the endpoint's managingOrganization.display over location count", () => {
    const brand = result.find((b) => b.fhirBaseUrl === "https://managed.example.test/api/FHIR/R4");

    // "REGIONAL HEALTH" wins even though "Some Clinic" has more locations,
    // because its name matches the endpoint's managingOrganization.display
    // (case-insensitively).
    expect(brand?.name).toBe("REGIONAL HEALTH");
    expect(brand?.aliases).toEqual(["Some Clinic"]);
    expect(brand?.id).toBe("regional-health");
  });

  it("keeps the first-seen organisation canonical when neither signal breaks the tie", () => {
    const brand = result.find((b) => b.fhirBaseUrl === "https://tie.example.test/api/FHIR/R4");

    expect(brand?.name).toBe("Tie First Seen");
    expect(brand?.aliases).toEqual(["Tie Second Seen"]);
  });

  it("leaves a single-organisation endpoint with no aliases at all", () => {
    const brand = result.find((b) => b.fhirBaseUrl === "https://solo.example.test/api/FHIR/R4");

    expect(brand?.name).toBe("Solo Health");
    expect(brand?.aliases).toBeUndefined();
  });

  it("still finds a flipped brand by the alias the old canonical name became", () => {
    // "Tiny Affiliate" no longer names the record, but it must still be
    // searchable -- someone who knows only the small affiliate's name should
    // still find the (correctly-labelled) shared endpoint.
    const matches = searchBrands(result, "Tiny Affiliate");

    expect(matches.map((b) => b.name)).toContain("Big Health System");
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
