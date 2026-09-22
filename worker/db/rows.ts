/**
 * One interface per table, matching the migrations under `migrations/` column
 * for column.
 *
 * These are the *raw* row shapes: snake_case, unix seconds as numbers, NULLable
 * columns as `| null`, and `_enc` columns still sealed. Repos are what turn them
 * into something the rest of the Worker should see -- nothing outside
 * `worker/db/**` should ever hold a `*_enc` string.
 *
 * Kept free of Worker runtime types on purpose, so the unit tests can import it.
 */

// The one type imported rather than restated: a portal session's state is the
// same value in the column and in the DTO the admin UI reads, and two copies of
// it could drift into disagreeing about what the CHECK constraint allows.
import type { PortalSessionState } from "@shared/types.ts";

/** 'connected' | 'needs_reauth' | 'error' | 'disconnected' (CHECK-constrained). */
export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "disconnected";
/** 'active' | 'ghost' (CHECK-constrained). */
export type CalendarEventState = "active" | "ghost";
/** Which cron or button produced a run. */
export type RunKind = "calendar" | "full" | "refresh" | "manual";
/** What an exposure rule denies. */
export type PolicyRuleType = "tool" | "resource" | "field" | "provider";
/** Which Epic environment a provider points at. */
export type ProviderEnvironment = "prod" | "sandbox";
/** Which authorization flow an in-flight state belongs to. */
export type OAuthStateKind = "epic" | "google";
/** 'otp' | 'forward_verify' | 'other' (CHECK-constrained). */
export type MailKind = "otp" | "forward_verify" | "other";
/**
 * Where a calendar row came from.
 *
 * Not CHECK-constrained: SQLite cannot add one to an existing table, so the
 * repos and the sync are what keep the domain honest.
 */
export type CalendarEventSource = "fhir" | "portal";

export interface SettingRow {
  key: string;
  value_json: string;
  updated_at: number;
}

export interface ProviderRow {
  id: string;
  vendor: string;
  display_name: string;
  brand_key: string | null;
  fhir_base_url: string;
  portal_url: string | null;
  environment: ProviderEnvironment;
  client_secret_enc: string | null;
  config_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ConnectionRow {
  id: string;
  provider_id: string;
  patient_fhir_id_enc: string | null;
  access_token_enc: string | null;
  access_expires_at: number | null;
  refresh_token_enc: string | null;
  scope: string | null;
  status: ConnectionStatus;
  last_refresh_at: number | null;
  last_sync_at: number | null;
  last_full_refresh_at: number | null;
  last_error_code: string | null;
  needs_reauth_since: number | null;
  refresh_failures: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GoogleAccountRow {
  id: number;
  email_enc: string | null;
  access_token_enc: string | null;
  access_expires_at: number | null;
  refresh_token_enc: string | null;
  scope: string | null;
  status: ConnectionStatus;
  last_refresh_at: number | null;
  needs_reauth_since: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  connected_at: number | null;
  updated_at: number;
}

export interface OAuthStateRow {
  state: string;
  kind: OAuthStateKind;
  provider_id: string | null;
  code_verifier_enc: string;
  redirect_after: string | null;
  created_at: number;
  expires_at: number;
}

export interface FhirCacheRow {
  provider_id: string;
  resource_type: string;
  resource_id: string;
  payload_enc: string;
  content_hash: string;
  last_updated: number | null;
  fetched_at: number;
  expires_at: number;
}

export interface FhirSyncStateRow {
  provider_id: string;
  resource_type: string;
  last_full_at: number | null;
  /** 0 or 1: SQLite has no boolean. */
  last_ok: number;
  last_error_code: string | null;
  warnings_json: string;
}

export interface CalendarEventRow {
  event_key: string;
  provider_id: string;
  encounter_id: string;
  calendar_id: string;
  google_event_id: string;
  fingerprint: string;
  state: CalendarEventState;
  start_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
  ghosted_at: number | null;
  updated_at: number;
  /** Added by 0002_portal.sql; every pre-existing row reads 'fhir'. */
  source: CalendarEventSource;
  /** The portal's contact-serial number, set only when `source` is 'portal'. */
  portal_csn: string | null;
}

export interface AlertRow {
  id: string;
  kind: "reconnect";
  /** 'provider:<id>' or 'google'. */
  subject: string;
  trello_card_id: string | null;
  opened_at: number;
  resolved_at: number | null;
}

export interface McpAuditRow {
  id: string;
  ts: number;
  client_id: string | null;
  grant_id: string | null;
  tool: string;
  providers_json: string;
  result_count: number;
  ok: number;
  error_code: string | null;
  duration_ms: number | null;
}

export interface McpPolicyRow {
  id: string;
  rule_type: PolicyRuleType;
  target: string;
  note: string | null;
  created_at: number;
}

export interface RunLogRow {
  id: string;
  kind: RunKind;
  started_at: number;
  finished_at: number | null;
  ok: number | null;
  summary_json: string;
}

export interface LoginAttemptRow {
  ip_hash: string;
  count: number;
  window_start: number;
}

export interface MailInboxRow {
  id: string;
  received_at: number;
  from_addr: string;
  subject: string | null;
  kind: MailKind;
  code_enc: string | null;
  consumed_at: number | null;
  expires_at: number | null;
  raw_size: number;
}

/**
 * One portal account per provider (0002_portal.sql).
 *
 * Three sealed columns, all bound to `portal_accounts.<column>.<providerId>`.
 * `cookie_jar_enc` is a whole serialised cookie jar rather than one value: the
 * trust-this-device cookie inside it is what lets a later run skip the emailed
 * code, so it is exactly as sensitive as the password.
 */
export interface PortalAccountRow {
  provider_id: string;
  base_url: string | null;
  mount_path: string | null;
  /**
   * The whole discovery result, as the portal adapter's own JSON (0003).
   *
   * Opaque outside `worker/providers/mychart/**`: it carries `baseUrl` and
   * `mountPath`, which the db layer validates, plus whatever else the adapter
   * needs to drive that deployment's login -- which varies, and is why this is
   * one JSON column rather than a column per field. NULL on a row written before
   * 0003 or by the CLI script; the sign-in then falls back to the two columns
   * above.
   */
  endpoint_json: string | null;
  username_enc: string | null;
  password_enc: string | null;
  cookie_jar_enc: string | null;
  session_state: PortalSessionState;
  last_login_at: number | null;
  last_ok_at: number | null;
  last_error_code: string | null;
  login_attempts_today: number;
  /** Whole UTC days since the epoch the counter above belongs to. */
  login_attempts_day: number | null;
  needs_reauth_since: number | null;
  updated_at: number;
}
