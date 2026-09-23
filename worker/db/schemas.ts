/**
 * Schemas for every JSON-bearing D1 column, and the settings catalogue.
 *
 * SQLite has no JSON type, so `settings.value_json`, `health_systems.config_json`,
 * `run_log.summary_json`, `fhir_sync_state.warnings_json` and
 * `mcp_audit.health_systems_json` are all TEXT. Parsing them through zod at the
 * boundary is what keeps a hand-edited row, or a shape left behind by an older
 * deploy, from becoming an `undefined` three layers up.
 *
 * This module is deliberately free of Worker runtime types: it is the half of the
 * db layer the plain-Node unit tests can import.
 *
 * Note what is NOT here: a default timezone. `timezone` defaults to `null`,
 * because a real default in source would say where the owner lives. The accessor
 * in settings.ts falls back to UTC and warns; see there.
 */

import { z } from "zod";

import { isHttpsUrl } from "@shared/url.ts";

import { AppError } from "../lib/errors.ts";
import { DEFAULT_MAIL_SENDER_ALLOWLIST_CSV } from "../mail/classify.ts";

/** Parse one JSON column, reporting where the bad value came from. */
export function parseJsonColumn<T>(schema: z.ZodType<T>, value: string, what: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new AppError("internal", `${what} is not valid JSON`, undefined, { cause: error });
  }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    // The issues name paths and expected types only -- never the offending
    // value, which in the FHIR cache's case would be clinical content.
    throw new AppError("internal", `${what} failed validation`, {
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`),
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * One schema per settings key. The set of keys is closed: a typo in an API
 * payload is rejected rather than silently stored under a key nothing reads.
 */
export const settingSchemas = {
  /** IANA zone used for every display and for the local-day sync window. */
  timezone: z.string().min(1).nullable(),
  /** Google calendar the sync writes to. "primary" means the owner's own. */
  calendar_id: z.string().min(1),
  /** Fallback event title template; a health system may override it. */
  default_title_template: z.string().min(1),
  /** Fallback Google colorId, or null to leave the calendar's default. */
  default_color_id: z.string().min(1).nullable(),
  /** colorId applied to a ghosted event. "8" is graphite in Google's palette. */
  ghost_color_id: z.string().min(1),
  /** How far back the rolling sync window reaches. */
  window_past_days: z.number().int().min(0).max(3650),
  /** Minutes before the appointment the event should start, by default. */
  default_arrival_offset_min: z.number().int().min(0).max(1440),
  /** Unix second before which no sync runs, set when an org returns 429. */
  sync_backoff_until: z.number().int().nonnegative().nullable(),
  /** Master switch for the MCP surface. */
  mcp_enabled: z.boolean(),
  /** Comma-separated sender domains the inbound email handler accepts mail from. */
  mail_sender_allowlist: z.string().min(1),
  /**
   * Sign-in attempts one patient-portal account may make per UTC day.
   *
   * A setting rather than a constant because it is a safety limit against the
   * portal's own lockout, and the one time it has to move is live QA against a
   * real portal, where three attempts is a short afternoon. The default is three.
   */
  portal_login_attempt_limit: z.number().int().min(1).max(20),
  /**
   * The patient-portal login shell's API path prefix, for the rare deployment
   * that needs one and that discovery could not learn on its own.
   *
   * No default in source is possible either way -- unlike a real default, this
   * is genuinely absent for almost every install, not merely undisclosed. See
   * `PortalAdapterDeps.custom` in `worker/ehr/mychart/index.ts`.
   */
  portal_api_base_path: z.string().min(1).max(200).nullable(),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type Settings = { [K in SettingKey]: z.infer<(typeof settingSchemas)[K]> };

/**
 * The value each key takes when the row is absent.
 *
 * `timezone` and `default_color_id` have no usable default, so they are null and
 * their callers decide what that means.
 */
export const SETTING_DEFAULTS: Settings = {
  timezone: null,
  calendar_id: "primary",
  default_title_template: "{visitType} · {practitioner}",
  default_color_id: null,
  ghost_color_id: "8",
  window_past_days: 90,
  default_arrival_offset_min: 0,
  sync_backoff_until: null,
  mcp_enabled: true,
  mail_sender_allowlist: DEFAULT_MAIL_SENDER_ALLOWLIST_CSV,
  portal_login_attempt_limit: 3,
  portal_api_base_path: null,
};

export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingSchemas, key);
}

/**
 * Parse a stored `value_json` for one key.
 *
 * The cast is unavoidable: indexing a heterogeneous record of schemas by a
 * generic key gives TypeScript a union of parsers, and it cannot see that the
 * parser for key K produces Settings[K]. The mapped type above is what ties the
 * two together, and the runtime check is the schema itself.
 *
 * `security/detect-object-injection` warns on both lookups below. Both index a
 * const map by `K extends SettingKey`, a closed union of literals, so the key can
 * only be one this module declared.
 */
export function parseSetting<K extends SettingKey>(key: K, valueJson: string): Settings[K] {
  const schema = settingSchemas[key] as unknown as z.ZodType<Settings[K]>;
  return parseJsonColumn(schema, valueJson, `settings.${key}`);
}

/** Validate a value for one key and render it for storage. */
export function encodeSetting<K extends SettingKey>(key: K, value: Settings[K]): string {
  const schema = settingSchemas[key] as unknown as z.ZodType<Settings[K]>;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError("bad_request", `settings.${key} is not a valid value`, {
      issues: result.error.issues.map((issue) => issue.code),
    });
  }
  return JSON.stringify(result.data);
}

// ---------------------------------------------------------------------------
// health systems.config_json
// ---------------------------------------------------------------------------

const offsetMinutes = z.number().int().min(0).max(1440);

/**
 * Per-health system overrides. Every field is optional: an absent one means "use the
 * matching `settings` default", which is why nothing here has a value baked in
 * except `enabled`.
 */
export const healthSystemConfigSchema = z.object({
  title_template: z.string().min(1).optional(),
  color_id: z.string().min(1).optional(),
  arrival_offset_min: offsetMinutes.optional(),
  /** Visit-type display string -> minutes to arrive early for that type. */
  arrival_offsets_by_visit_type: z.record(z.string(), offsetMinutes).default({}),
  /** Short label for the org, used in title templates. */
  org_short: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
});

export type HealthSystemConfig = z.infer<typeof healthSystemConfigSchema>;
/** What a caller may pass: the defaulted fields are optional on the way in. */
export type HealthSystemConfigInput = z.input<typeof healthSystemConfigSchema>;

// ---------------------------------------------------------------------------
// run_log.summary_json
// ---------------------------------------------------------------------------

const count = z.number().int().nonnegative().default(0);

/**
 * Counts and codes only. Nothing in here may identify an appointment, a person
 * or an organisation -- the run log is the one table an operator reads casually.
 */
export const runSummarySchema = z.object({
  healthSystems: count,
  inserted: count,
  patched: count,
  ghosted: count,
  restored: count,
  unchanged: count,
  resources: count,
  /** Stable error codes, one per health system that failed. */
  errors: z.array(z.string()).default([]),
  /** OperationOutcome codes an org returned, e.g. "4119" -- which, not how many. */
  warnings: z.array(z.string()).default([]),
  /**
   * How many warnings there were, as opposed to how many distinct codes.
   * One org repeating 4119 for every Encounter is a different situation from one
   * that said it once, and `warnings` alone cannot tell them apart.
   */
  warningCount: count,
  /**
   * An organisation served a patient-facing, filtered view of the schedule.
   *
   * On the summary rather than derived, because it is the reason a run may have
   * seen fewer appointments than exist -- and therefore the reason it refused to
   * ghost anything.
   */
  filteredView: z.boolean().default(false),
  /** The run stopped early, or never started, because of a rate-limit backoff. */
  backedOff: z.boolean().default(false),
  /** Upcoming visits the patient-portal pass read. Zero on a row written before it existed. */
  portalVisits: count,
  /** Portal visits skipped because a FHIR-sourced event already covered them. */
  portalSkipped: count,
  /** Stable codes from portal accounts that failed. Codes only; see `RunSummary`. */
  portalErrors: z.array(z.string()).default([]),
});

export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunSummaryInput = z.input<typeof runSummarySchema>;

// ---------------------------------------------------------------------------
// fhir_sync_state.warnings_json and mcp_audit.health_systems_json
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// portal_accounts.endpoint_json
// ---------------------------------------------------------------------------

/**
 * The stored discovery result.
 *
 * Deliberately loose: `worker/ehr/mychart/**` owns this shape and adds to
 * it as deployments turn out to differ (which login application to drive, for
 * one). Validating the fields the db layer and the sign-in actually read, and
 * passing everything else through untouched, is what lets the adapter evolve
 * without a migration or a schema change here. A strict object would silently
 * strip the field that decides how to sign in.
 *
 * The two origins are checked as **https URLs**, not merely as non-empty
 * strings. They are what the sign-in rebuilds a credential-bearing URL from, so
 * a stored `http://…` (or a stored anything-else) would put the owner's portal
 * password on the wire in cleartext. A row that fails this makes the sign-in
 * fail closed -- see `portalAccounts.getEndpoint`.
 */
const httpsOrigin = z
  .string()
  .min(1)
  .max(2048)
  .refine(isHttpsUrl, { error: "must be an https URL" });

export const portalEndpointSchema = z.looseObject({
  baseUrl: httpsOrigin,
  mountPath: z.string().min(1),
  /** `custom_oidc` only, and just as credential-bearing as `baseUrl`. */
  authBaseUrl: httpsOrigin.optional(),
});

export type StoredPortalEndpoint = z.infer<typeof portalEndpointSchema>;

export const syncWarningsSchema = z.array(
  z.object({ code: z.string(), count: z.number().int().nonnegative() }),
);

export type SyncWarning = z.infer<typeof syncWarningsSchema>[number];

/** `mcp_audit.health_systems_json`: which health systems a tool call touched. */
export const healthSystemIdsSchema = z.array(z.string());
