import { describe, expect, it } from "vitest";

import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  encodeSetting,
  isSettingKey,
  parseJsonColumn,
  parseSetting,
  healthSystemConfigSchema,
  healthSystemIdsSchema,
  runSummarySchema,
  settingSchemas,
  syncWarningsSchema,
} from "../../../worker/db/schemas.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import type { HealthSystemConfig, SettingKey, Settings } from "../../../worker/db/schemas.ts";

/** Run `fn`, which must throw, and hand back what it threw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("the settings catalogue", () => {
  it("has a schema and a default for exactly the same keys", () => {
    expect(SETTING_KEYS.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      Object.keys(SETTING_DEFAULTS).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("carries the documented defaults", () => {
    expect(SETTING_DEFAULTS).toStrictEqual<Settings>({
      // No timezone default in source: a real one would say where the owner
      // lives. getTimezone() falls back to UTC and warns instead.
      timezone: null,
      calendar_id: "primary",
      default_title_template: "{visitType} · {practitioner}",
      default_color_id: null,
      ghost_color_id: "8",
      window_past_days: 90,
      default_arrival_offset_min: 0,
      sync_backoff_until: null,
      mcp_enabled: true,
      // Gmail's own forwarding-verification sender and nothing else: a health
      // system's sending domain names an organisation, so it has no default in
      // source, and the generic fragment this used to ship was matched by
      // containment.
      mail_sender_allowlist: "google.com",
      // Three, chosen against the portal's own lockout rather than against our
      // convenience. A setting so live QA can raise it for an afternoon.
      portal_login_attempt_limit: 3,
      // No default is possible: absent for almost every deployment, and there is
      // no admin UI for it -- set directly in D1 for the rare account that needs it.
      portal_api_base_path: null,
    });
  });

  it("accepts its own defaults through its own schemas", () => {
    // `SETTING_DEFAULTS[key]`: `SETTING_KEYS` is the key list of that same const.
    for (const key of SETTING_KEYS) {
      const encoded = encodeSetting(key, SETTING_DEFAULTS[key]);

      expect(parseSetting(key, encoded), key).toStrictEqual(SETTING_DEFAULTS[key]);
    }
  });

  it("closes the key set", () => {
    expect(isSettingKey("calendar_id")).toBe(true);
    expect(isSettingKey("calender_id")).toBe(false);
    expect(isSettingKey("toString")).toBe(false);
    expect(Object.keys(settingSchemas)).toContain("mcp_enabled");
  });
});

describe("parseSetting", () => {
  it("round-trips each type of value", () => {
    expect(parseSetting("timezone", '"Europe/Paris"')).toBe("Europe/Paris");
    expect(parseSetting("timezone", "null")).toBeNull();
    expect(parseSetting("window_past_days", "365")).toBe(365);
    expect(parseSetting("mcp_enabled", "false")).toBe(false);
    expect(parseSetting("sync_backoff_until", "1767225600")).toBe(1_767_225_600);
  });

  it("rejects a stored value of the wrong type rather than passing it on", () => {
    // The row can only get this way by hand, but a `90` where a string belongs
    // would otherwise reach the sync as a number and fail somewhere unhelpful.
    expect(() => parseSetting("calendar_id", "90")).toThrow(AppError);
    expect(() => parseSetting("window_past_days", '"90"')).toThrow(/failed validation/);
    expect(() => parseSetting("mcp_enabled", '"true"')).toThrow(AppError);
    expect(() => parseSetting("window_past_days", "-1")).toThrow(AppError);
    expect(() => parseSetting("window_past_days", "1.5")).toThrow(AppError);
    expect(() => parseSetting("calendar_id", '""')).toThrow(AppError);
  });

  it("rejects malformed JSON with the column named", () => {
    expect(() => parseSetting("calendar_id", "not json")).toThrow(/settings\.calendar_id/);
  });

  it("does not put the offending value in the error", () => {
    // Error messages end up in logs; a settings value is tame but the same code
    // path parses cached clinical payloads.
    const thrown = thrownBy(() => parseSetting("window_past_days", '"secret-ish"'));

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ message: "settings.window_past_days failed validation" });
    expect(JSON.stringify(thrown)).not.toContain("secret-ish");
    expect(String(thrown)).not.toContain("secret-ish");
  });
});

describe("encodeSetting", () => {
  it("validates before it serialises, and reports a bad value as a bad request", () => {
    expect(encodeSetting("timezone", "UTC")).toBe('"UTC"');
    expect(encodeSetting("window_past_days", 30)).toBe("30");

    const bad = (): string => encodeSetting("window_past_days", 4000);

    expect(bad).toThrow(AppError);
    expect(bad).toThrow(/not a valid value/);
    // A caller's mistake is a 400, not a 500 -- unlike a corrupt stored row.
    expect(thrownBy(bad)).toMatchObject({ code: "bad_request" });
  });

  it("rejects a key the catalogue does not know, via the type and at runtime", () => {
    const key = "nope" as SettingKey;

    expect(() => encodeSetting(key, "x")).toThrow();
  });
});

describe("healthSystemConfigSchema", () => {
  it("fills in the two fields that have defaults and leaves the rest absent", () => {
    expect(healthSystemConfigSchema.parse({})).toStrictEqual<HealthSystemConfig>({
      arrival_offsets_by_visit_type: {},
      enabled: true,
    });
  });

  it("keeps the overrides it is given", () => {
    expect(
      healthSystemConfigSchema.parse({
        title_template: "{visitType} at {orgShort}",
        color_id: "5",
        arrival_offset_min: 20,
        arrival_offsets_by_visit_type: { Imaging: 45 },
        org_short: "EH",
        enabled: false,
      }),
    ).toStrictEqual<HealthSystemConfig>({
      title_template: "{visitType} at {orgShort}",
      color_id: "5",
      arrival_offset_min: 20,
      arrival_offsets_by_visit_type: { Imaging: 45 },
      org_short: "EH",
      enabled: false,
    });
  });

  it("rejects an offset that is negative, fractional, or more than a day", () => {
    for (const arrival_offset_min of [-1, 0.5, 1441]) {
      expect(
        healthSystemConfigSchema.safeParse({ arrival_offset_min }).success,
        String(arrival_offset_min),
      ).toBe(false);
    }
  });

  it("drops a key it does not know rather than storing it", () => {
    expect(healthSystemConfigSchema.parse({ colour_id: "5" })).not.toHaveProperty("colour_id");
  });
});

describe("runSummarySchema", () => {
  it("defaults every counter to zero and every list to empty", () => {
    expect(runSummarySchema.parse({})).toStrictEqual({
      healthSystems: 0,
      inserted: 0,
      patched: 0,
      ghosted: 0,
      restored: 0,
      unchanged: 0,
      resources: 0,
      errors: [],
      warnings: [],
      warningCount: 0,
      filteredView: false,
      backedOff: false,
      portalVisits: 0,
      portalSkipped: 0,
      portalErrors: [],
    });
  });

  it("keeps counts and codes", () => {
    const parsed = runSummarySchema.parse({
      healthSystems: 2,
      inserted: 3,
      ghosted: 1,
      errors: ["needs_reauth"],
      warnings: ["4119"],
    });

    expect(parsed.inserted).toBe(3);
    expect(parsed.errors).toStrictEqual(["needs_reauth"]);
    expect(parsed.warnings).toStrictEqual(["4119"]);
  });

  it("keeps the flags a run needs to explain itself", () => {
    const parsed = runSummarySchema.parse({
      warnings: ["4119"],
      warningCount: 12,
      filteredView: true,
      backedOff: true,
    });

    // Twelve warnings carrying one code: the count and the codes say different
    // things, and the run log needs both.
    expect(parsed.warningCount).toBe(12);
    expect(parsed.filteredView).toBe(true);
    expect(parsed.backedOff).toBe(true);
  });

  it("rejects a negative or fractional count", () => {
    expect(runSummarySchema.safeParse({ inserted: -1 }).success).toBe(false);
    expect(runSummarySchema.safeParse({ inserted: 1.5 }).success).toBe(false);
  });
});

describe("syncWarningsSchema and healthSystemIdsSchema", () => {
  it("parse the shapes their columns hold", () => {
    expect(syncWarningsSchema.parse([{ code: "4119", count: 2 }])).toStrictEqual([
      { code: "4119", count: 2 },
    ]);
    expect(syncWarningsSchema.safeParse([{ code: "4119" }]).success).toBe(false);
    expect(healthSystemIdsSchema.parse(["p1", "p2"])).toStrictEqual(["p1", "p2"]);
    expect(healthSystemIdsSchema.safeParse([1]).success).toBe(false);
  });
});

describe("parseJsonColumn", () => {
  it("names the column in both failure modes", () => {
    expect(() =>
      parseJsonColumn(healthSystemIdsSchema, "{", "mcp_audit.health_systems_json.x"),
    ).toThrow(/mcp_audit\.health_systems_json\.x is not valid JSON/);
    expect(() =>
      parseJsonColumn(healthSystemIdsSchema, "{}", "mcp_audit.health_systems_json.x"),
    ).toThrow(/mcp_audit\.health_systems_json\.x failed validation/);
  });

  it("reports issues as paths and codes, with no values", () => {
    const thrown = thrownBy(() =>
      parseJsonColumn(syncWarningsSchema, '[{"code":1,"count":"two"}]', "warnings"),
    );
    const details = JSON.stringify((thrown as AppError).details);

    expect(details).toContain("0.code");
    expect(details).not.toContain("two");
  });

  it("treats a corrupt stored column as an internal failure, not a bad request", () => {
    // Nobody sent it: it is already in the database, so it is our problem.
    expect(thrownBy(() => parseJsonColumn(healthSystemIdsSchema, "{}", "x"))).toMatchObject({
      code: "internal",
    });
  });
});
