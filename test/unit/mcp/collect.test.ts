// Provider selection and the limit clamp: the two decisions every tool makes
// before it reads anything.

import { describe, expect, it } from "vitest";

import { effectiveLimit, selectProviders } from "../../../worker/mcp/collect.ts";
import { EMPTY_RULES, buildRules } from "../../../worker/policy/rules.ts";

import type { ProviderInfo } from "../../../worker/mcp/deps.ts";

function provider(id: string, displayName: string): ProviderInfo {
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

const ALL = [provider("prov_a", "Example Health"), provider("prov_b", "Other Clinic")];

describe("selectProviders", () => {
  it("returns everything when nothing is asked for", () => {
    expect(selectProviders(ALL, EMPTY_RULES, undefined)).toStrictEqual(ALL);
    expect(selectProviders(ALL, EMPTY_RULES, [])).toStrictEqual(ALL);
  });

  it("matches an id exactly", () => {
    expect(selectProviders(ALL, EMPTY_RULES, ["prov_b"]).map((p) => p.id)).toStrictEqual([
      "prov_b",
    ]);
  });

  it("matches a display-name substring, case-insensitively", () => {
    expect(selectProviders(ALL, EMPTY_RULES, ["EXAMPLE"]).map((p) => p.id)).toStrictEqual([
      "prov_a",
    ]);
    expect(selectProviders(ALL, EMPTY_RULES, ["clinic"]).map((p) => p.id)).toStrictEqual([
      "prov_b",
    ]);
  });

  it("accepts several names at once", () => {
    expect(selectProviders(ALL, EMPTY_RULES, ["prov_a", "clinic"])).toHaveLength(2);
  });

  it("returns nothing for a name that matches nothing", () => {
    // Not "everything": a filter that quietly widens is worse than an empty answer.
    expect(selectProviders(ALL, EMPTY_RULES, ["nonesuch"])).toStrictEqual([]);
  });

  it("removes a denied provider before the argument is applied", () => {
    const rules = buildRules([{ rule_type: "provider", target: "prov_b" }]);

    expect(selectProviders(ALL, rules, undefined).map((p) => p.id)).toStrictEqual(["prov_a"]);
    // Naming it explicitly cannot bring it back.
    expect(selectProviders(ALL, rules, ["prov_b"])).toStrictEqual([]);
    expect(selectProviders(ALL, rules, ["Other Clinic"])).toStrictEqual([]);
  });

  it("ignores blank and whitespace-only needles", () => {
    expect(selectProviders(ALL, EMPTY_RULES, [" ".repeat(3)])).toStrictEqual([]);
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
