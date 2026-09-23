// Health system selection and the limit clamp: the two decisions every tool makes
// before it reads anything.

import { describe, expect, it } from "vitest";

import { effectiveLimit, selectHealthSystems } from "../../../worker/mcp/collect.ts";
import { EMPTY_RULES, buildRules } from "../../../worker/policy/rules.ts";

import type { HealthSystemInfo } from "../../../worker/mcp/deps.ts";

function healthSystem(id: string, displayName: string): HealthSystemInfo {
  return {
    id,
    displayName,
    environment: "prod",
    portalUrl: null,
    enabled: true,
    status: "connected",
    lastSyncAt: null,
    lastFullRefreshAt: null,
    lastErrorCode: null,
    needsReauthSince: null,
  };
}

const ALL = [healthSystem("prov_a", "Example Health"), healthSystem("prov_b", "Other Clinic")];

describe("selectHealthSystems", () => {
  it("returns everything when nothing is asked for", () => {
    expect(selectHealthSystems(ALL, EMPTY_RULES, undefined)).toStrictEqual(ALL);
    expect(selectHealthSystems(ALL, EMPTY_RULES, [])).toStrictEqual(ALL);
  });

  it("matches an id exactly", () => {
    expect(selectHealthSystems(ALL, EMPTY_RULES, ["prov_b"]).map((p) => p.id)).toStrictEqual([
      "prov_b",
    ]);
  });

  it("matches a display-name substring, case-insensitively", () => {
    expect(selectHealthSystems(ALL, EMPTY_RULES, ["EXAMPLE"]).map((p) => p.id)).toStrictEqual([
      "prov_a",
    ]);
    expect(selectHealthSystems(ALL, EMPTY_RULES, ["clinic"]).map((p) => p.id)).toStrictEqual([
      "prov_b",
    ]);
  });

  it("accepts several names at once", () => {
    expect(selectHealthSystems(ALL, EMPTY_RULES, ["prov_a", "clinic"])).toHaveLength(2);
  });

  it("returns nothing for a name that matches nothing", () => {
    // Not "everything": a filter that quietly widens is worse than an empty answer.
    expect(selectHealthSystems(ALL, EMPTY_RULES, ["nonesuch"])).toStrictEqual([]);
  });

  it("removes a denied health system before the argument is applied", () => {
    const rules = buildRules([{ rule_type: "health_system", target: "prov_b" }]);

    expect(selectHealthSystems(ALL, rules, undefined).map((p) => p.id)).toStrictEqual(["prov_a"]);
    // Naming it explicitly cannot bring it back.
    expect(selectHealthSystems(ALL, rules, ["prov_b"])).toStrictEqual([]);
    expect(selectHealthSystems(ALL, rules, ["Other Clinic"])).toStrictEqual([]);
  });

  it("ignores blank and whitespace-only needles", () => {
    expect(selectHealthSystems(ALL, EMPTY_RULES, [" ".repeat(3)])).toStrictEqual([]);
  });
});

describe("effectiveLimit", () => {
  it("is undefined (no limit at all) when the caller passes none, with no ceiling otherwise", () => {
    expect(effectiveLimit(undefined)).toBeUndefined();
    expect(effectiveLimit(10)).toBe(10);
    expect(effectiveLimit(50_000)).toBe(50_000);
    expect(effectiveLimit(0)).toBe(1);
    expect(effectiveLimit(-5)).toBe(1);
    expect(effectiveLimit(7.9)).toBe(7);
  });
});
