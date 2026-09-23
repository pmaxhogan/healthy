// Request validation, and the two predicates the routes lean on hardest.
//
// The timezone check is the one with consequences: it decides what lands in the
// `settings` row that the sync's local-day window is computed from, so a string
// that formats but is not a zone (a fixed offset) must not get through.

import { describe, expect, it } from "vitest";

import {
  brandQuerySchema,
  isHttpsUrl,
  isValidTimezone,
  policyRuleSchema,
  healthSystemCreateSchema,
  healthSystemSecretSchema,
  settingsPatchSchema,
  syncRequestSchema,
  updateHealthSystemSchema,
} from "../../../worker/api/schemas.ts";

describe("isValidTimezone", () => {
  it("accepts a canonical IANA zone", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Pacific/Auckland")).toBe(true);
  });

  it("accepts a legacy alias, which supportedValuesOf does not list", () => {
    // The fallback to the constructor is what makes this pass; a plain
    // `supportedValuesOf().includes(...)` check would reject it.
    expect(isValidTimezone("US/Central")).toBe(true);
  });

  it("rejects a zone that does not exist", () => {
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
    expect(isValidTimezone("Not A Zone")).toBe(false);
  });

  it("rejects a fixed offset, which has no daylight-saving rules", () => {
    expect(isValidTimezone("+05:00")).toBe(false);
    expect(isValidTimezone("-06:00")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("isHttpsUrl", () => {
  it("accepts an absolute https URL", () => {
    expect(isHttpsUrl("https://fhir.example.test/R4")).toBe(true);
  });

  it("refuses http, a relative path, and anything unparseable", () => {
    // eslint-disable-next-line unicorn/prefer-https -- the assertion IS that http is refused.
    expect(isHttpsUrl("http://fhir.example.test/R4")).toBe(false);
    expect(isHttpsUrl("/R4")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("settingsPatchSchema", () => {
  it("accepts a patch of one field", () => {
    expect(settingsPatchSchema.safeParse({ windowPastDays: 30 }).success).toBe(true);
  });

  it("accepts an empty patch", () => {
    expect(settingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an unknown key rather than dropping it", () => {
    // A key the Worker does not know is a bug in the Worker or the SPA; a setting
    // that appears to save and does not is far harder to notice.
    const result = settingsPatchSchema.safeParse({ timezone: "UTC", tiemzone: "UTC" });

    expect(result.success).toBe(false);
  });

  it("rejects a timezone that is not a zone", () => {
    expect(settingsPatchSchema.safeParse({ timezone: "Mars/Phobos" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ timezone: "+05:00" }).success).toBe(false);
  });

  it("accepts a null timezone, which is how the owner unsets it", () => {
    expect(settingsPatchSchema.safeParse({ timezone: null }).success).toBe(true);
  });

  it("rejects an out-of-range window and a fractional offset", () => {
    expect(settingsPatchSchema.safeParse({ windowPastDays: -1 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ windowPastDays: 4000 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ defaultArrivalOffsetMin: 12.5 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ defaultArrivalOffsetMin: 2000 }).success).toBe(false);
  });

  it("rejects an empty string where a value is required", () => {
    expect(settingsPatchSchema.safeParse({ calendarId: "" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ghostColorId: "" }).success).toBe(false);
  });
});

describe("healthSystemCreateSchema", () => {
  const base = { displayName: "Example Health", environment: "sandbox" as const };

  it("accepts a brand id", () => {
    expect(healthSystemCreateSchema.safeParse({ ...base, brandId: "brand-1" }).success).toBe(true);
  });

  it("accepts a manual https FHIR base", () => {
    const result = healthSystemCreateSchema.safeParse({
      ...base,
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(result.success).toBe(true);
  });

  it("refuses a non-https FHIR base at the schema, before any request is made", () => {
    const result = healthSystemCreateSchema.safeParse({
      ...base,
      // eslint-disable-next-line unicorn/prefer-https -- the assertion IS that http is refused.
      fhirBaseUrl: "http://fhir.example.test/R4",
    });

    expect(result.success).toBe(false);
  });

  it("requires a display name and a known environment", () => {
    expect(healthSystemCreateSchema.safeParse({ ...base, displayName: "" }).success).toBe(false);
    expect(
      healthSystemCreateSchema.safeParse({ ...base, environment: "staging", brandId: "b" }).success,
    ).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(
      healthSystemCreateSchema.safeParse({ ...base, brandId: "b", vendor: "oracle" }).success,
    ).toBe(false);
  });

  it("accepts a config, and rejects one with an unknown field", () => {
    expect(
      healthSystemCreateSchema.safeParse({ ...base, brandId: "b", config: { orgShort: "EX" } })
        .success,
    ).toBe(true);
    expect(
      healthSystemCreateSchema.safeParse({ ...base, brandId: "b", config: { org_short: "EX" } })
        .success,
    ).toBe(false);
  });
});

describe("the remaining schemas", () => {
  it("lets PATCH clear a portal URL with null but not with a bare string", () => {
    expect(updateHealthSystemSchema.safeParse({ portalUrl: null }).success).toBe(true);
    expect(updateHealthSystemSchema.safeParse({ portalUrl: "portal.example.test" }).success).toBe(
      false,
    );
  });

  it("requires a non-empty client secret", () => {
    expect(healthSystemSecretSchema.safeParse({ clientSecret: "" }).success).toBe(false);
    expect(healthSystemSecretSchema.safeParse({ clientSecret: "s3cret" }).success).toBe(true);
  });

  it("closes the policy rule type to the four the column allows", () => {
    for (const ruleType of ["tool", "resource", "field", "health_system"]) {
      expect(policyRuleSchema.safeParse({ ruleType, target: "x" }).success, ruleType).toBe(true);
    }
    expect(policyRuleSchema.safeParse({ ruleType: "everything", target: "x" }).success).toBe(false);
  });

  it("accepts an empty sync request, which means 'every health system'", () => {
    expect(syncRequestSchema.safeParse({}).success).toBe(true);
    expect(syncRequestSchema.safeParse({ healthSystemIds: ["PROV1"] }).success).toBe(true);
    expect(syncRequestSchema.safeParse({ healthSystemIds: "PROV1" }).success).toBe(false);
  });

  it("treats a missing brand query as absent rather than invalid", () => {
    const result = brandQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data?.q).toBeUndefined();
  });
});
