import { describe, expect, it } from "vitest";

import { splitEntries } from "../../../worker/fhir/bundle.ts";
import {
  classifyOutcome,
  EPIC_DOCUMENT_CAP,
  EPIC_FILTERED_VIEW,
  EPIC_NO_RESULTS,
  EPIC_NOT_AUTHORIZED,
  EPIC_OPTIONAL_PARAM_INVALID,
  EPIC_PAGING_EXPIRED,
  EPIC_UNKNOWN_PARAM,
  isOperationOutcome,
  parseIssues,
  toSearchWarnings,
} from "../../../worker/fhir/operation-outcome.ts";
import { loadFixture } from "../providers/fixtures.ts";

import type { OutcomeClass, ParsedIssue } from "../../../worker/fhir/operation-outcome.ts";
import type { Bundle, OperationOutcome } from "../../../worker/fhir/types.ts";

const pagingExpired = loadFixture<OperationOutcome>("outcome-4113.json");
const noResults = loadFixture<Bundle>("outcome-4101.json");
const mixed = loadFixture<Bundle>("outcome-4119-mixed.json");

/** Build an outcome with one issue carrying an Epic numeric code. */
function outcomeWith(severity: string, epicCode: string | null): unknown {
  return {
    resourceType: "OperationOutcome",
    issue: [
      {
        severity,
        code: "processing",
        ...(epicCode !== null && { details: { coding: [{ code: epicCode }] } }),
      },
    ],
  };
}

/** Parse and classify one synthetic issue in a single step. */
function classifyWith(severity: string, epicCode: string | null): OutcomeClass {
  return classifyOutcome(parseIssues(outcomeWith(severity, epicCode)));
}

describe("isOperationOutcome", () => {
  it("keys off resourceType only", () => {
    expect(isOperationOutcome(pagingExpired)).toBe(true);
    expect(isOperationOutcome(noResults)).toBe(false);
    expect(isOperationOutcome(undefined)).toBe(false);
  });
});

describe("parseIssues", () => {
  it("pulls severity, FHIR code, diagnostics and the Epic numeric code", () => {
    const issues = parseIssues(pagingExpired);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toStrictEqual<ParsedIssue>({
      severity: "error",
      code: "expired",
      diagnostics: "paging session expired",
      epicCode: EPIC_PAGING_EXPIRED,
      detailsText: "The paged search session has expired.",
    });
  });

  it("returns nothing for anything that is not an OperationOutcome", () => {
    expect(parseIssues(noResults)).toStrictEqual([]);
    expect(parseIssues("4101")).toStrictEqual([]);
    expect(parseIssues({ resourceType: "OperationOutcome" })).toStrictEqual([]);
  });

  it("prefers a numeric coding over a non-numeric one, and falls back to it", () => {
    const numericSecond = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "warning",
          code: "processing",
          details: { coding: [{ code: "epic-x" }, { code: "4119" }] },
        },
      ],
    };
    const noneNumeric = {
      resourceType: "OperationOutcome",
      issue: [
        { severity: "warning", code: "processing", details: { coding: [{ code: "epic-x" }] } },
      ],
    };

    expect(parseIssues(numericSecond)[0]?.epicCode).toBe(EPIC_FILTERED_VIEW);
    expect(parseIssues(noneNumeric)[0]?.epicCode).toBe("epic-x");
    expect(parseIssues(outcomeWith("error", null))[0]?.epicCode).toBeNull();
  });

  it("reads the outcome out of a bundle entry the same way", () => {
    const { outcomes } = splitEntries(mixed);
    const issues = outcomes.flatMap((outcome) => parseIssues(outcome));

    expect(issues.map((issue) => issue.epicCode)).toStrictEqual([
      EPIC_FILTERED_VIEW,
      EPIC_UNKNOWN_PARAM,
    ]);
  });
});

describe("classifyOutcome", () => {
  it("treats 4101 as an empty result, not a failure, whatever the severity", () => {
    for (const severity of ["information", "warning", "error"]) {
      const outcome = classifyWith(severity, EPIC_NO_RESULTS);

      expect(outcome.noResults, severity).toBe(true);
      expect(outcome.fatal, severity).toBe(false);
    }
  });

  it("treats 4119 and 4122 and 59109 as warnings", () => {
    for (const code of [EPIC_FILTERED_VIEW, EPIC_UNKNOWN_PARAM, EPIC_OPTIONAL_PARAM_INVALID]) {
      expect(classifyWith("error", code).fatal, code).toBe(false);
    }
    const bundleIssues = parseIssues(mixed);
    const entryIssues = parseIssues(splitEntries(mixed).outcomes[0]);

    expect(classifyOutcome(bundleIssues).filtered).toBe(false);
    expect(classifyOutcome(entryIssues).filtered).toBe(true);
  });

  it("flags 4113 as paging-expired and also as fatal, so it is never mistaken for success", () => {
    const outcome = classifyOutcome(parseIssues(pagingExpired));

    expect(outcome.pagingExpired).toBe(true);
    expect(outcome.fatal).toBe(true);
  });

  it("flags 4118 as not-authorized and 4135 as the document cap", () => {
    expect(classifyWith("error", EPIC_NOT_AUTHORIZED)).toMatchObject({
      notAuthorized: true,
      fatal: true,
    });
    expect(classifyWith("error", EPIC_DOCUMENT_CAP)).toMatchObject({
      documentCapReached: true,
      fatal: true,
    });
  });

  it("is fatal for an unrecognised error and quiet for an unrecognised warning", () => {
    expect(classifyWith("fatal", "59109999").fatal).toBe(true);
    expect(classifyWith("warning", "59109999").fatal).toBe(false);
    expect(classifyOutcome([]).fatal).toBe(false);
  });

  it("collects every Epic code it saw, in order", () => {
    const issues = splitEntries(mixed).outcomes.flatMap((outcome) => parseIssues(outcome));

    expect(classifyOutcome(issues).codes).toStrictEqual([EPIC_FILTERED_VIEW, EPIC_UNKNOWN_PARAM]);
  });
});

describe("toSearchWarnings", () => {
  it("tags each issue with the resource type it came from and keeps no resource data", () => {
    const warnings = toSearchWarnings("Encounter", parseIssues(pagingExpired));

    expect(warnings).toStrictEqual([
      {
        resourceType: "Encounter",
        severity: "error",
        code: "expired",
        epicCode: EPIC_PAGING_EXPIRED,
        diagnostics: "paging session expired",
      },
    ]);
  });
});
