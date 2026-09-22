// Shared synthetic fixtures for the normalize test suite. Not a *.test.ts
// file, so vitest's `test/unit/**/*.test.ts` include glob never picks it up
// as a test file on its own.

import { mapResolver } from "../../../../worker/fhir/normalize/refs.ts";

import type { NormalizeCtx } from "../../../../worker/fhir/normalize/types.ts";
import type * as fhir4 from "fhir/r4";

export const EXAMPLE_PRACTITIONER: fhir4.Practitioner = {
  resourceType: "Practitioner",
  id: "prac-1",
  name: [{ use: "official", family: "Example", given: ["Ada"], prefix: ["Dr."] }],
  qualification: [{ code: { text: "Family Medicine" } }],
};

export const EXAMPLE_ORGANIZATION: fhir4.Organization = {
  resourceType: "Organization",
  id: "org-1",
  name: "Example Health System",
  telecom: [{ system: "phone", value: "555-010-0100", use: "work" }],
};

const EXAMPLE_LOCATION: fhir4.Location = {
  resourceType: "Location",
  id: "loc-1",
  name: "Example Clinic",
  address: { line: ["100 Example St"], city: "Example City", state: "EX", postalCode: "00000" },
  telecom: [{ system: "phone", value: "555-010-0199", use: "work" }],
};

const EXAMPLE_PATIENT: fhir4.Patient = {
  resourceType: "Patient",
  id: "pat-1",
  name: [{ use: "official", family: "Example", given: ["Pat"] }],
  birthDate: "1990-01-01",
  gender: "unknown",
  address: [{ line: ["100 Example St"], city: "Example City", state: "EX", postalCode: "00000" }],
};

/** A resolver plus context over the standard fixture pool, for tests that
 * don't need to construct their own reference graph. */
export function testCtx(resources: fhir4.Resource[] = []): NormalizeCtx {
  return {
    provider: "example-provider",
    refs: mapResolver([
      EXAMPLE_PRACTITIONER,
      EXAMPLE_ORGANIZATION,
      EXAMPLE_LOCATION,
      EXAMPLE_PATIENT,
      ...resources,
    ]),
  };
}
