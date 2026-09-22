// The DTO projections, and the one property that matters most about them: a
// response body never carries a sealed column or a secret.
//
// The rows below are built with plausible ciphertext in every `*_enc` column and
// with the *plaintext* of a token as a separate constant, so the assertions can
// look for both shapes -- the envelope (`v1:...`), the column name (`_enc`) and the
// secret value itself. A projection that grew a spread of the whole row would fail
// all three.

import { describe, expect, it } from "vitest";

import {
  fromProviderConfigDto,
  fromSettingsPatch,
  maskAccountLabel,
  reconnectPathFor,
  toAlertDto,
  toAuditDto,
  toConnectionDto,
  toGoogleAccountDto,
  toPolicyRuleDto,
  toProviderConfigDto,
  toProviderDto,
  toRunDto,
  toRunSummaryDto,
} from "../../../worker/api/dto.ts";
import { SETTING_DEFAULTS, providerConfigSchema } from "../../../worker/db/schemas.ts";

import type {
  AlertRow,
  ConnectionRow,
  McpPolicyRow,
  ProviderRow,
} from "../../../worker/db/rows.ts";

/** A stable comparator, so the key assertions do not depend on locale ordering. */
const alphabetical = (a: string, b: string): number => a.localeCompare(b, "en");

/** An arbitrary fixed instant: 2026-01-01T00:00:00Z, in unix seconds. */
const T0 = 1_767_225_600;

/** Plaintext secrets that must never appear in a body, whatever happens above. */
const SECRETS = {
  clientSecret: "the-per-org-client-secret",
  accessToken: "the-access-token",
  refreshToken: "the-refresh-token",
  patientId: "patient-12345",
  email: "someone@example.test",
};

const providerRow: ProviderRow = {
  id: "PROV1",
  vendor: "epic",
  display_name: "Example Health",
  brand_key: "brand-1",
  fhir_base_url: "https://fhir.example.test/R4",
  portal_url: "https://portal.example.test",
  environment: "sandbox",
  client_secret_enc: "v1:c2VhbGVkLWNsaWVudC1zZWNyZXQ",
  config_json: JSON.stringify({ title_template: "{visitType}", enabled: false }),
  created_at: T0,
  updated_at: T0 + 60,
  deleted_at: null,
};

const connectionRow: ConnectionRow = {
  id: "CONN1",
  provider_id: "PROV1",
  patient_fhir_id_enc: "v1:c2VhbGVkLXBhdGllbnQ",
  access_token_enc: "v1:c2VhbGVkLWFjY2Vzcw",
  access_expires_at: T0 + 3600,
  refresh_token_enc: "v1:c2VhbGVkLXJlZnJlc2g",
  scope: "openid fhirUser offline_access",
  status: "connected",
  last_refresh_at: T0,
  last_sync_at: T0 + 10,
  last_full_refresh_at: null,
  last_error_code: null,
  needs_reauth_since: null,
  refresh_failures: 0,
  lease_owner: "worker-1",
  lease_expires_at: T0 + 60,
  created_at: T0,
  updated_at: T0,
};

/** Every string a body is checked against. Fails loudly if any of them leaks. */
function assertNoSecrets(value: unknown): void {
  const json = JSON.stringify(value);
  // The column suffix, not the substring "enc": `encountersSeen` is a legitimate
  // DTO field and a naive check would match it.
  expect(json).not.toMatch(/[a-z]_enc/);
  expect(json).not.toContain("v1:");
  for (const secret of Object.values(SECRETS)) expect(json).not.toContain(secret);
}

describe("toConnectionDto", () => {
  it("reports that a refresh token exists without carrying it", () => {
    const dto = toConnectionDto(connectionRow);

    expect(dto.hasRefreshToken).toBe(true);
    assertNoSecrets(dto);
  });

  it("reports no refresh token when the column is null", () => {
    expect(toConnectionDto({ ...connectionRow, refresh_token_enc: null }).hasRefreshToken).toBe(
      false,
    );
  });

  it("renders every timestamp as an ISO instant", () => {
    const dto = toConnectionDto(connectionRow);

    expect(dto.accessExpiresAt).toBe("2026-01-01T01:00:00.000Z");
    expect(dto.lastRefreshAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.lastFullRefreshAt).toBeNull();
  });

  it("carries the reconnect path the Trello card links to", () => {
    expect(toConnectionDto(connectionRow).reconnectPath).toBe("/oauth/reconnect/CONN1");
    expect(reconnectPathFor("google")).toBe("/oauth/reconnect/google");
  });

  it("does not leak the lease, which is internal bookkeeping", () => {
    expect(JSON.stringify(toConnectionDto(connectionRow))).not.toContain("worker-1");
  });
});

describe("toProviderDto", () => {
  const config = providerConfigSchema.parse(JSON.parse(providerRow.config_json));

  it("reports that a client secret is set without carrying it", () => {
    const dto = toProviderDto({ row: providerRow, config, connection: connectionRow });

    expect(dto.hasClientSecret).toBe(true);
    assertNoSecrets(dto);
  });

  it("reports hasClientSecret false for a provider that still needs one", () => {
    const dto = toProviderDto({
      row: { ...providerRow, client_secret_enc: null },
      config,
      connection: null,
    });

    expect(dto.hasClientSecret).toBe(false);
    expect(dto.connection).toBeNull();
  });

  it("does not carry config_json, only the parsed camelCase config", () => {
    const dto = toProviderDto({ row: providerRow, config, connection: null });

    expect(JSON.stringify(dto)).not.toContain("config_json");
    expect(JSON.stringify(dto)).not.toContain("title_template");
    expect(dto.config.titleTemplate).toBe("{visitType}");
  });
});

describe("the provider config mapping", () => {
  it("round-trips through both directions", () => {
    const stored = providerConfigSchema.parse({
      title_template: "{visitType} · {practitioner}",
      color_id: "5",
      arrival_offset_min: 15,
      arrival_offsets_by_visit_type: { "new patient": 30 },
      org_short: "EX",
      enabled: false,
    });

    const dto = toProviderConfigDto(stored);
    expect(dto).toStrictEqual({
      titleTemplate: "{visitType} · {practitioner}",
      colorId: "5",
      arrivalOffsetMin: 15,
      arrivalOffsetsByVisitType: { "new patient": 30 },
      orgShort: "EX",
      enabled: false,
    });

    expect(providerConfigSchema.parse(fromProviderConfigDto(dto))).toStrictEqual(stored);
  });

  it("omits the optional keys that were absent rather than sending undefined", () => {
    const dto = toProviderConfigDto(providerConfigSchema.parse({}));

    expect(Object.keys(dto).toSorted(alphabetical)).toStrictEqual([
      "arrivalOffsetsByVisitType",
      "enabled",
    ]);
    expect(Object.keys(fromProviderConfigDto({}))).toStrictEqual([]);
  });
});

describe("maskAccountLabel", () => {
  it("keeps the first and last characters of the local part and the whole domain", () => {
    expect(maskAccountLabel("person@example.test")).toBe("p…n@example.test");
  });

  it("collapses a very short local part to one character", () => {
    expect(maskAccountLabel("ab@example.test")).toBe("a…@example.test");
    expect(maskAccountLabel("a@example.test")).toBe("a…@example.test");
  });

  it("masks a label that is not an address at all", () => {
    // Google hands back the calendar id, which is normally the address but is not
    // guaranteed to be one.
    expect(maskAccountLabel("some-calendar-id")).toBe("s…d");
  });

  it("uses the last @, so a local part containing one cannot expose the domain", () => {
    expect(maskAccountLabel("odd@name@example.test")).toBe("o…e@example.test");
  });

  it("passes null and empty through as null", () => {
    expect(maskAccountLabel(null)).toBeNull();
    expect(maskAccountLabel("")).toBeNull();
  });
});

describe("toGoogleAccountDto", () => {
  it("masks the label and never carries the address", () => {
    const dto = toGoogleAccountDto({
      status: "connected",
      label: SECRETS.email,
      accessExpiresAt: T0 + 3600,
      lastRefreshAt: T0,
      needsReauthSince: null,
      connectedAt: T0 - 86_400,
      calendarId: "primary",
    });

    expect(dto.accountLabel).toBe("s…e@example.test");
    assertNoSecrets(dto);
    expect(dto.connectedAt).toBe("2025-12-31T00:00:00.000Z");
  });
});

describe("the settings mapping", () => {
  it("maps snake_case rows to the camelCase DTO", () => {
    const dto = fromSettingsPatch({ calendarId: "work@group.calendar.google.com" });

    expect(dto).toStrictEqual({ calendar_id: "work@group.calendar.google.com" });
  });

  it("writes only the keys the patch actually carries", () => {
    expect(fromSettingsPatch({})).toStrictEqual({});
    expect(fromSettingsPatch({ mcpEnabled: false })).toStrictEqual({ mcp_enabled: false });
  });

  it("accepts a null timezone, which means 'unset', not 'absent'", () => {
    expect(fromSettingsPatch({ timezone: null })).toStrictEqual({ timezone: null });
  });

  it("never writes syncBackoffUntil, which only the sync engine owns", () => {
    expect(fromSettingsPatch({ syncBackoffUntil: "2026-01-01T00:00:00.000Z" })).toStrictEqual({});
  });

  it("has a DTO field for every settings key, so nothing is silently unreachable", () => {
    // `sync_backoff_until` is deliberately read-only; every other key must be
    // writable through the API or the UI cannot configure it at all.
    const writable = Object.keys(
      fromSettingsPatch({
        timezone: "UTC",
        calendarId: "primary",
        defaultTitleTemplate: "x",
        defaultColorId: "1",
        ghostColorId: "8",
        defaultArrivalOffsetMin: 0,
        windowPastDays: 90,
        mcpEnabled: true,
      }),
    );
    const expected = Object.keys(SETTING_DEFAULTS).filter((key) => key !== "sync_backoff_until");

    expect(writable.toSorted(alphabetical)).toStrictEqual(expected.toSorted(alphabetical));
  });
});

describe("toRunSummaryDto", () => {
  const stored = {
    providers: 2,
    inserted: 3,
    patched: 1,
    ghosted: 4,
    restored: 2,
    unchanged: 10,
    resources: 120,
    // Bare codes, no provider prefix -- `toStoredSummary` writes them this way
    // by design, so this fixture does too rather than exercising a shape that
    // never actually reaches this function.
    errors: ["upstream_unavailable", "needs_reauth"],
    warnings: ["4119", "4101"],
    warningCount: 9,
    filteredView: true,
    backedOff: false,
  };

  it("counts an appointment as seen when it was inserted, patched, restored or unchanged", () => {
    // Ghosts are excluded: a ghost is an appointment that was NOT there upstream.
    expect(toRunSummaryDto(stored).encountersSeen).toBe(16);
  });

  it("renames the event counters to the UI's vocabulary", () => {
    const dto = toRunSummaryDto(stored);

    expect(dto.eventsInserted).toBe(3);
    expect(dto.eventsPatched).toBe(1);
    expect(dto.eventsGhosted).toBe(4);
    expect(dto.eventsRestored).toBe(2);
    expect(dto.resourcesCached).toBe(120);
  });

  it("reports how many warnings there were, not how many distinct codes", () => {
    expect(toRunSummaryDto(stored).warnings).toBe(9);
  });

  it("falls back to the distinct codes for a row written before the count existed", () => {
    // `warningCount` defaults to 0 on an older `summary_json`, and two codes cannot
    // have arrived in fewer than two warnings.
    expect(toRunSummaryDto({ ...stored, warningCount: 0 }).warnings).toBe(2);
  });

  it("carries the flags that explain a run with no changes", () => {
    expect(toRunSummaryDto(stored).filteredView).toBe(true);
    expect(toRunSummaryDto({ ...stored, backedOff: true }).backedOff).toBe(true);
  });

  it("passes the stored error codes straight through, with no provider to reconstruct", () => {
    expect(toRunSummaryDto(stored).errors).toStrictEqual(["upstream_unavailable", "needs_reauth"]);
  });

  it("exposes the distinct warning codes, not just the count", () => {
    expect(toRunSummaryDto(stored).warningCodes).toStrictEqual(["4119", "4101"]);
  });
});

describe("toRunDto", () => {
  it("reports a run that never finished as unfinished rather than failed", () => {
    const dto = toRunDto({
      id: "RUN1",
      kind: "calendar",
      startedAt: T0,
      finishedAt: null,
      ok: null,
      summary: {
        providers: 0,
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
      },
    });

    expect(dto.finishedAt).toBeNull();
    expect(dto.ok).toBeNull();
    expect(dto.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("toAlertDto", () => {
  const row: AlertRow = {
    id: "ALERT1",
    kind: "reconnect",
    subject: "provider:PROV1",
    trello_card_id: "card-1",
    opened_at: T0,
    resolved_at: null,
  };

  it("extracts the provider id from the subject", () => {
    expect(toAlertDto(row).providerId).toBe("PROV1");
  });

  it("reports no provider id for the Google subject", () => {
    expect(toAlertDto({ ...row, subject: "google" }).providerId).toBeNull();
  });
});

describe("toPolicyRuleDto and toAuditDto", () => {
  it("renders a policy rule with an ISO createdAt", () => {
    const row: McpPolicyRow = {
      id: "RULE1",
      rule_type: "field",
      target: "Observation.valueQuantity",
      note: null,
      created_at: T0,
    };

    expect(toPolicyRuleDto(row)).toStrictEqual({
      id: "RULE1",
      ruleType: "field",
      target: "Observation.valueQuantity",
      note: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      unparsed: false,
    });
  });

  it("flags a field rule the policy engine cannot parse", () => {
    // "Observation" alone is a resource type, not a field path: stored, listed, and
    // denying nothing. The DTO says so rather than letting the UI imply otherwise.
    expect(
      toPolicyRuleDto({
        id: "RULE2",
        rule_type: "field",
        target: "Observation",
        note: null,
        created_at: T0,
      }).unparsed,
    ).toBe(true);
    // A tool target is taken literally, so it can never be unparsed.
    expect(
      toPolicyRuleDto({
        id: "RULE3",
        rule_type: "tool",
        target: "anything at all",
        note: null,
        created_at: T0,
      }).unparsed,
    ).toBe(false);
  });

  it("names an unknown client rather than leaving it blank", () => {
    const dto = toAuditDto({
      id: "AUD1",
      ts: T0,
      clientId: null,
      tool: "get_appointments",
      providers: ["PROV1"],
      resultCount: 3,
      ok: true,
      errorCode: null,
      durationMs: null,
    });

    expect(dto.clientId).toBe("unknown");
    expect(dto.durationMs).toBe(0);
    expect(dto.providerIds).toStrictEqual(["PROV1"]);
  });
});
