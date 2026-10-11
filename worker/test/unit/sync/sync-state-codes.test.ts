// What each code `fhir_sync_state` records means, as get_sync_status and
// coverage report it.

import { describe, expect, it } from "vitest";

import {
  EPIC_DOCUMENT_CAP,
  EPIC_FILTERED_VIEW,
  EPIC_NOT_AUTHORIZED,
  EPIC_NO_RESULTS,
  EPIC_OPTIONAL_PARAM_INVALID,
  EPIC_PAGING_EXPIRED,
  EPIC_UNKNOWN_PARAM,
} from "../../../src/fhir/operation-outcome.ts";
import {
  UNSUPPORTED_ERROR_CODE,
  explainSyncCode,
  explainSyncWarnings,
} from "../../../src/sync/sync-state-codes.ts";

describe("explainSyncCode", () => {
  it.each([
    [EPIC_NO_RESULTS, "info"],
    [EPIC_PAGING_EXPIRED, "warning"],
    [EPIC_NOT_AUTHORIZED, "error"],
    [EPIC_FILTERED_VIEW, "info"],
    [EPIC_UNKNOWN_PARAM, "info"],
    [EPIC_DOCUMENT_CAP, "warning"],
    [EPIC_OPTIONAL_PARAM_INVALID, "info"],
    ["59204", "info"],
    [UNSUPPORTED_ERROR_CODE, "info"],
    ["category_rejected:longitudinal", "warning"],
  ])("explains every code the sync classifies by: %s is %s", (code, severity) => {
    const explained = explainSyncCode(code);
    expect(explained.severity).toBe(severity);
    expect(explained.meaning.length).toBeGreaterThan(10);
  });

  it("calls a code it has no meaning for unknown, and does not guess", () => {
    expect(explainSyncCode("59001")).toStrictEqual({
      meaning: "No documented meaning for this code.",
      severity: "unknown",
    });
    expect(explainSyncCode("constructor").severity).toBe("unknown");
  });

  it("explains a failure by its Epic suffix, and never as less than an error", () => {
    expect(explainSyncCode("upstream_error:4118")).toStrictEqual({
      ...explainSyncCode("4118"),
      severity: "error",
    });
    expect(explainSyncCode("upstream_error:4101").severity).toBe("error");
    // An unknown suffix falls back to the failure's own meaning.
    expect(explainSyncCode("upstream_error:12345")).toStrictEqual(
      explainSyncCode("upstream_error"),
    );
  });

  it("keeps each warning row's code and count", () => {
    expect(explainSyncWarnings([{ code: "4101", count: 2 }])).toStrictEqual([
      { code: "4101", count: 2, ...explainSyncCode("4101") },
    ]);
  });
});
