import { describe, expect, it } from "vitest";

import { mapResolver } from "../../../../worker/fhir/normalize/refs.ts";

import { EXAMPLE_ORGANIZATION, EXAMPLE_PRACTITIONER } from "./fixtures.ts";

describe("mapResolver", () => {
  it("get() resolves a relative reference to the matching resource", () => {
    const refs = mapResolver([EXAMPLE_PRACTITIONER]);
    expect(refs.get({ reference: "Practitioner/prac-1" })).toEqual(EXAMPLE_PRACTITIONER);
  });

  it("get() resolves an absolute-URL reference and strips version history", () => {
    const refs = mapResolver([EXAMPLE_PRACTITIONER]);
    expect(
      refs.get({
        reference: "https://fhir.example.org/api/FHIR/R4/Practitioner/prac-1/_history/2",
      }),
    ).toEqual(EXAMPLE_PRACTITIONER);
  });

  it("get() is undefined for an unresolvable or missing reference", () => {
    const refs = mapResolver([EXAMPLE_PRACTITIONER]);
    expect(refs.get({ reference: "Practitioner/does-not-exist" })).toBeUndefined();
    expect(refs.get(undefined)).toBeUndefined();
  });

  it("display() derives a name from the resolved resource, by type", () => {
    const refs = mapResolver([EXAMPLE_PRACTITIONER, EXAMPLE_ORGANIZATION]);
    expect(refs.display({ reference: "Practitioner/prac-1" })).toBe("Dr. Ada Example");
    expect(refs.display({ reference: "Organization/org-1" })).toBe("Example Health System");
  });

  it("display() falls back to reference.display when the resource is not in the pool", () => {
    const refs = mapResolver([]);
    expect(refs.display({ reference: "Practitioner/prac-1", display: "Dr. Ada Example" })).toBe(
      "Dr. Ada Example",
    );
  });

  it("display() prefers the resolved resource's name over a stale reference.display", () => {
    const refs = mapResolver([EXAMPLE_PRACTITIONER]);
    expect(refs.display({ reference: "Practitioner/prac-1", display: "Stale Name" })).toBe(
      "Dr. Ada Example",
    );
  });

  it("display() is undefined with no reference and no display", () => {
    const refs = mapResolver([]);
    expect(refs.display(undefined)).toBeUndefined();
    expect(refs.display({})).toBeUndefined();
  });
});
