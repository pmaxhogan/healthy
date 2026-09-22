// The brand index loader and its search.
//
// Two notes on how this file is written.
//
// The pure projection (`toBrandDto`) is tested against synthetic records, which is
// where the canonical-name behaviour is pinned precisely.
//
// The tests that need the real committed index derive their inputs from it at
// runtime -- "the first record that has more than one name" -- rather than naming a
// health system. That is not squeamishness about a public directory: it keeps the
// test from breaking every time the weekly data job reshuffles the file, and it
// keeps organisation names out of the test source, which is the rule the rest of
// this repository follows.

import { describe, expect, it } from "vitest";

import {
  BRAND_SEARCH_LIMIT,
  allBrands,
  brandById,
  brandsGeneratedAt,
  searchBrands,
  toBrandDto,
} from "../../../worker/brands.ts";

import type { BrandRecord } from "../../../worker/brands.ts";

const shared: BrandRecord = {
  id: "shared-endpoint",
  names: ["Canonical Health", "Second System", "Third Clinic"],
  fhirBaseUrl: "https://fhir.example.test/R4",
  portalUrl: "https://portal.example.test",
  locations: ["Springfield, ZZ"],
};

describe("toBrandDto", () => {
  it("uses the canonical name when nothing matched", () => {
    const dto = toBrandDto(shared);

    expect(dto.name).toBe("Canonical Health");
    expect(dto.aliases).toStrictEqual(["Second System", "Third Clinic"]);
  });

  it("renders the matched alias as the name, and the rest as aliases", () => {
    // This is the whole point of the flattening: a system that shares an Epic
    // instance with another is shown under its own name, not its neighbour's.
    const dto = toBrandDto(shared, "Second System");

    expect(dto.name).toBe("Second System");
    expect(dto.aliases).toStrictEqual(["Canonical Health", "Third Clinic"]);
  });

  it("ignores a matched name that is not one of the record's", () => {
    expect(toBrandDto(shared, "Somewhere Else").name).toBe("Canonical Health");
  });

  it("keeps the endpoint, the portal and the locations untouched", () => {
    const dto = toBrandDto(shared, "Third Clinic");

    expect(dto.fhirBaseUrl).toBe(shared.fhirBaseUrl);
    expect(dto.portalUrl).toBe(shared.portalUrl);
    expect(dto.locations).toStrictEqual(shared.locations);
    expect(dto.id).toBe("shared-endpoint");
  });
});

describe("the committed index", () => {
  it("loads every record with at least one name and an https endpoint", () => {
    const brands = allBrands();

    expect(brands.length).toBeGreaterThan(100);
    for (const brand of brands) {
      expect(brand.names.length).toBeGreaterThan(0);
      expect(brand.names[0]).not.toBe("");
      expect(brand.fhirBaseUrl.startsWith("https://")).toBe(true);
    }
  });

  it("reports when it was generated", () => {
    const generatedAt = Date.parse(brandsGeneratedAt());

    expect(Number.isNaN(generatedAt)).toBe(false);
  });

  it("has at least one endpoint shared by several systems, which is why names exists", () => {
    expect(allBrands().some((brand) => brand.names.length > 1)).toBe(true);
  });
});

describe("searchBrands", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(searchBrands("")).toStrictEqual([]);
    expect(searchBrands(" ".repeat(3))).toStrictEqual([]);
  });

  it("returns at most the search limit", () => {
    // "a" matches most of the index; the cap is what keeps the type-ahead usable.
    const results = searchBrands("a");

    expect(results.length).toBeLessThanOrEqual(BRAND_SEARCH_LIMIT);
    expect(results.length).toBeGreaterThan(0);
  });

  it("honours an explicit limit", () => {
    expect(searchBrands("a", 3)).toHaveLength(3);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    const record = allBrands()[0];
    const needle = (record?.names[0] ?? "").slice(0, 6);

    const upper = searchBrands(needle.toUpperCase());
    const padded = searchBrands(`  ${needle.toLowerCase()}  `);

    expect(upper.length).toBeGreaterThan(0);
    expect(padded.map((brand) => brand.id)).toStrictEqual(upper.map((brand) => brand.id));
  });

  it("finds a shared endpoint by an alias, and names it by that alias", () => {
    const record = allBrands().find((brand) => brand.names.length > 1);
    const alias = record?.names[1] ?? "";

    const match = searchBrands(alias).find((brand) => brand.id === record?.id);

    expect(match).toBeDefined();
    expect(match?.name).toBe(alias);
    // The canonical name is still reachable, as an alias of this rendering.
    expect(match?.aliases).toContain(record?.names[0]);
  });

  it("ranks a name prefix above a name substring", () => {
    const results = searchBrands("health");
    const firstPrefix = results.findIndex((brand) => brand.name.toLowerCase().startsWith("health"));
    const firstSubstring = results.findIndex(
      (brand) => !brand.name.toLowerCase().startsWith("health"),
    );

    // Only meaningful when the query produced both kinds, which "health" does.
    expect(firstPrefix).toBeGreaterThanOrEqual(0);
    expect(firstSubstring).toBeGreaterThan(firstPrefix);
  });

  it("never returns a DTO whose name is not one of the record's names", () => {
    for (const brand of searchBrands("clinic")) {
      const record = allBrands().find((candidate) => candidate.id === brand.id);

      expect(record?.names).toContain(brand.name);
      expect(brand.aliases).not.toContain(brand.name);
    }
  });
});

describe("brandById", () => {
  it("finds a brand by the id the search handed out", () => {
    const first = searchBrands("a")[0];

    expect(brandById(first?.id ?? "")?.fhirBaseUrl).toBe(first?.fhirBaseUrl);
  });

  it("returns null for an unknown id", () => {
    expect(brandById("not-a-brand-id")).toBeNull();
  });
});
