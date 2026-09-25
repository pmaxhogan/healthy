// Coverage: telling "no data" apart from "we could not get it".

import { describe, expect, it } from "vitest";

import {
  STALE_AFTER_SECONDS,
  buildCoverage,
  coverageIncomplete,
  coverageWarnings,
  mergeCoverage,
} from "../../../worker/mcp/coverage.ts";
import { EMPTY_RULES, buildRules } from "../../../worker/policy/rules.ts";
import { UNSUPPORTED_ERROR_CODE } from "../../../worker/sync/sync-state-codes.ts";

import type { CoverageEntry } from "../../../worker/mcp/coverage.ts";
import type { HealthSystemInfo, SyncStatusEntry } from "../../../worker/mcp/deps.ts";

const NOW = 1_780_272_000;

const HEALTH_SYSTEM_A = "prov_a";
const HEALTH_SYSTEM_B = "prov_b";
const NAME_A = "Example Health";
const NAME_B = "Other Clinic";

function healthSystem(id: string, displayName: string): HealthSystemInfo {
  return {
    id,
    displayName,
    environment: "sandbox",
    portalUrl: null,
    enabled: true,
    status: "connected",
    lastSyncAt: null,
    lastFullRefreshAt: null,
    lastErrorCode: null,
    needsReauthSince: null,
  };
}

const HEALTH_SYSTEMS = [
  healthSystem(HEALTH_SYSTEM_A, NAME_A),
  healthSystem(HEALTH_SYSTEM_B, NAME_B),
];

function state(overrides: Partial<SyncStatusEntry> = {}): SyncStatusEntry {
  return {
    healthSystemId: HEALTH_SYSTEM_A,
    resourceType: "CarePlan",
    lastFullAt: NOW - 3600,
    lastOk: true,
    lastErrorCode: null,
    warnings: [],
    ...overrides,
  };
}

describe("buildCoverage", () => {
  it("reports ok for a recent successful sync, with lastOkAt", () => {
    const [entry] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["CarePlan"],
      syncStatus: [state()],
      rules: EMPTY_RULES,
      now: NOW,
    });

    expect(entry).toMatchObject({
      healthSystemId: HEALTH_SYSTEM_A,
      healthSystem: NAME_A,
      resourceType: "CarePlan",
      status: "ok",
      lastOkAt: new Date((NOW - 3600) * 1000).toISOString(),
    });
    expect(entry?.errorCode).toBeUndefined();
  });

  it("reports failed with the error code when the last attempt threw", () => {
    const [entry] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["CarePlan"],
      syncStatus: [state({ lastOk: false, lastErrorCode: "upstream_error:59109" })],
      rules: EMPTY_RULES,
      now: NOW,
    });

    expect(entry?.status).toBe("failed");
    expect(entry?.errorCode).toBe("upstream_error:59109");
  });

  it("reports never for a pair with no sync-state row at all", () => {
    const [entry] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["CarePlan"],
      syncStatus: [],
      rules: EMPTY_RULES,
      now: NOW,
    });

    expect(entry).toMatchObject({ status: "never" });
    expect(entry?.errorCode).toBeUndefined();
    expect(entry?.lastOkAt).toBeUndefined();
  });

  it("reports stale once the last success is older than the refresh's own cadence", () => {
    const justUnderThreshold = state({ lastFullAt: NOW - (STALE_AFTER_SECONDS - 60) });
    const overThreshold = state({ lastFullAt: NOW - (STALE_AFTER_SECONDS + 3600) });

    const [ok] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["CarePlan"],
      syncStatus: [justUnderThreshold],
      rules: EMPTY_RULES,
      now: NOW,
    });
    expect(ok?.status).toBe("ok");

    const [stale] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["CarePlan"],
      syncStatus: [overThreshold],
      rules: EMPTY_RULES,
      now: NOW,
    });
    expect(stale?.status).toBe("stale");
    expect(stale?.ageHours).toBe(Math.floor((STALE_AFTER_SECONDS + 3600) / 3600));
  });

  it("reports unsupported, not failed, when the organisation does not offer the type", () => {
    const [entry] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["Coverage"],
      syncStatus: [
        state({ resourceType: "Coverage", lastOk: false, lastErrorCode: UNSUPPORTED_ERROR_CODE }),
      ],
      rules: EMPTY_RULES,
      now: NOW,
    });

    expect(entry?.status).toBe("unsupported");
    // Never an error code: this is not a failure to explain.
    expect(entry?.errorCode).toBeUndefined();
  });

  it("reports partial when a category-scoped search had one rejected category", () => {
    const [entry] = buildCoverage({
      healthSystems: [healthSystem(HEALTH_SYSTEM_A, NAME_A)],
      resourceTypes: ["CarePlan"],
      syncStatus: [state({ warnings: [{ code: "category_rejected:encounter", count: 1 }] })],
      rules: EMPTY_RULES,
      now: NOW,
    });

    expect(entry?.status).toBe("partial");
  });

  it("never mentions a resource type the exposure policy denies, for any health system", () => {
    const rules = buildRules([{ rule_type: "resource", target: "CarePlan" }]);

    const coverage = buildCoverage({
      healthSystems: HEALTH_SYSTEMS,
      resourceTypes: ["CarePlan", "Condition"],
      syncStatus: [state(), state({ healthSystemId: HEALTH_SYSTEM_B })],
      rules,
      now: NOW,
    });

    expect(coverage.some((entry) => entry.resourceType === "CarePlan")).toBe(false);
    expect(coverage.every((entry) => entry.resourceType === "Condition")).toBe(true);
  });

  it("never mentions a health system the exposure policy denies, even if the caller forgot to filter it out first", () => {
    const rules = buildRules([{ rule_type: "health_system", target: HEALTH_SYSTEM_B }]);

    const coverage = buildCoverage({
      // Deliberately not pre-filtered, unlike a real tool call: this is the
      // second, redundant check the module comment describes.
      healthSystems: HEALTH_SYSTEMS,
      resourceTypes: ["CarePlan"],
      syncStatus: [state(), state({ healthSystemId: HEALTH_SYSTEM_B })],
      rules,
      now: NOW,
    });

    expect(coverage.some((entry) => entry.healthSystemId === HEALTH_SYSTEM_B)).toBe(false);
    expect(coverage.some((entry) => entry.healthSystem === NAME_B)).toBe(false);
    expect(coverage).toHaveLength(1);
  });
});

describe("mergeCoverage", () => {
  it("combines disjoint groups and lets a later group win a shared key", () => {
    const a: CoverageEntry[] = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Encounter",
        status: "ok",
      },
    ];
    const b: CoverageEntry[] = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Encounter",
        status: "failed",
        errorCode: "upstream_error",
      },
      {
        healthSystemId: HEALTH_SYSTEM_B,
        healthSystem: NAME_B,
        resourceType: "CarePlan",
        status: "never",
      },
    ];

    const merged = mergeCoverage(a, b);

    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.resourceType === "Encounter")?.status).toBe("failed");
    expect(merged.some((entry) => entry.resourceType === "CarePlan")).toBe(true);
  });
});

describe("coverageIncomplete", () => {
  it("is false when every pair is ok or unsupported", () => {
    const coverage: CoverageEntry[] = [
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Encounter",
        status: "ok",
      },
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Coverage",
        status: "unsupported",
      },
    ];

    expect(coverageIncomplete(coverage)).toBe(false);
  });

  it.each(["failed", "never", "stale", "partial"] as const)(
    "is true when a pair is %s",
    (status) => {
      const coverage: CoverageEntry[] = [
        { healthSystemId: HEALTH_SYSTEM_A, healthSystem: NAME_A, resourceType: "CarePlan", status },
      ];

      expect(coverageIncomplete(coverage)).toBe(true);
    },
  );

  it("is false for an empty array", () => {
    expect(coverageIncomplete([])).toBe(false);
  });
});

describe("coverageWarnings", () => {
  it("names the type, health system id and error code for a failed pair", () => {
    const warnings = coverageWarnings([
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "CarePlan",
        status: "failed",
        errorCode: "upstream_error:59109",
      },
    ]);

    expect(warnings).toStrictEqual(["sync_failed:CarePlan:prov_a:upstream_error:59109"]);
  });

  it("falls back to a stable placeholder when a failed pair carries no error code", () => {
    const warnings = coverageWarnings([
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "CarePlan",
        status: "failed",
      },
    ]);

    expect(warnings).toStrictEqual(["sync_failed:CarePlan:prov_a:unknown"]);
  });

  it("covers never, stale and partial with the task's own code shapes", () => {
    const warnings = coverageWarnings([
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "CarePlan",
        status: "never",
      },
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Encounter",
        status: "stale",
        ageHours: 50,
      },
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Condition",
        status: "partial",
      },
    ]);

    expect(warnings).toStrictEqual([
      "never_synced:CarePlan:prov_a",
      "stale:Encounter:prov_a:50h",
      "partial:Condition:prov_a",
    ]);
  });

  it("says nothing for ok or unsupported pairs", () => {
    const warnings = coverageWarnings([
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "CarePlan",
        status: "ok",
      },
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: NAME_A,
        resourceType: "Coverage",
        status: "unsupported",
      },
    ]);

    expect(warnings).toStrictEqual([]);
  });

  it("never names a health system, only its id", () => {
    const warnings = coverageWarnings([
      {
        healthSystemId: HEALTH_SYSTEM_A,
        healthSystem: "A Real Hospital Name",
        resourceType: "CarePlan",
        status: "failed",
        errorCode: "upstream_error",
      },
    ]);

    expect(warnings.join(" ")).not.toContain("A Real Hospital Name");
  });
});
