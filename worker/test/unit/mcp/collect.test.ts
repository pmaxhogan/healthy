// Health system selection and the limit clamp: the two decisions every tool makes
// before it reads anything.

import { describe, expect, it } from "vitest";

import { effectiveLimit, selectHealthSystems, withinWindow } from "../../../src/mcp/collect.ts";
import { isIsoDateOrInstant } from "../../../src/mcp/window.ts";
import { EMPTY_RULES, buildRules } from "../../../src/policy/rules.ts";

import type { HealthSystemInfo } from "../../../src/mcp/deps.ts";

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
    portal: null,
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

describe("isIsoDateOrInstant", () => {
  it.each([
    "2026",
    "2026-01",
    "2026-01-31",
    "2026-01-31T09:00",
    "2026-01-31T09:00:00",
    "2026-01-31T09:00:00Z",
    "2026-01-31T09:00:00.123Z",
    "2026-01-31T09:00:00+02:00",
    "2026-01-31T09:00:00.5-05:30",
  ])("accepts %s", (value) => {
    expect(isIsoDateOrInstant(value)).toBe(true);
  });

  it.each([
    "",
    "26",
    "March 1, 2026",
    "03/01/2026",
    "2026-13",
    "2026-01-31T",
    "2026-01T09:00",
    "2026-01-31T9:00",
    "2026-01-31T09:00:00+0200",
    "2026-01-31T09:00:00ZT",
    "2026-01-31 09:00",
  ])("rejects %j", (value) => {
    expect(isIsoDateOrInstant(value)).toBe(false);
  });
});

describe("withinWindow", () => {
  it("is inclusive at both ends", () => {
    const at = "2026-03-01T00:00:00.000Z";
    expect(withinWindow(at, at, at)).toBe(true);
    expect(withinWindow("2026-03-01T00:00:00.001Z", undefined, at)).toBe(false);
  });

  it("reads a date-only `to` as the whole UTC day, month or year", () => {
    expect(withinWindow("2026-01-31T23:59:59.999Z", undefined, "2026-01-31")).toBe(true);
    expect(withinWindow("2026-02-01T00:00:00.000Z", undefined, "2026-01-31")).toBe(false);
    expect(withinWindow("2026-01-31T18:00:00Z", undefined, "2026-01")).toBe(true);
    expect(withinWindow("2026-02-01T00:00:00Z", undefined, "2026-01")).toBe(false);
    expect(withinWindow("2026-12-31T12:00:00Z", undefined, "2026")).toBe(true);
    expect(withinWindow("2027-01-01T00:00:00Z", undefined, "2026")).toBe(false);
    // February in a non-leap year still ends on the 28th.
    expect(withinWindow("2027-02-28T23:00:00Z", undefined, "2027-02")).toBe(true);
    expect(withinWindow("2027-03-01T00:00:00Z", undefined, "2027-02")).toBe(false);
  });

  it("reads a date-only `from` as the start of that UTC period", () => {
    expect(withinWindow("2026-01-01T00:00:00Z", "2026", undefined)).toBe(true);
    expect(withinWindow("2025-12-31T23:59:59Z", "2026", undefined)).toBe(false);
    expect(withinWindow("2026-03-01T00:00:00Z", "2026-03", undefined)).toBe(true);
    expect(withinWindow("2026-02-28T23:59:59Z", "2026-03-01", undefined)).toBe(false);
  });

  it("reads an instant without an offset as UTC, and honours an explicit one", () => {
    expect(withinWindow("2026-03-01T09:00:00Z", "2026-03-01T09:00", undefined)).toBe(true);
    expect(withinWindow("2026-03-01T08:59:59Z", "2026-03-01T09:00", undefined)).toBe(false);
    // 23:00 at +02:00 is 21:00 UTC.
    expect(withinWindow("2026-03-01T21:30:00Z", undefined, "2026-03-01T23:00:00+02:00")).toBe(
      false,
    );
    expect(withinWindow("2026-03-01T20:30:00Z", undefined, "2026-03-01T23:00:00+02:00")).toBe(true);
  });

  it("keeps a dateless item only when there is no window", () => {
    expect(withinWindow(undefined, undefined, undefined)).toBe(true);
    expect(withinWindow(undefined, "2026", undefined)).toBe(false);
  });
});
