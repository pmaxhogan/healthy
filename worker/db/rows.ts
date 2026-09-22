/**
 * One interface per table, matching `migrations/0001_init.sql` column for column.
 *
 * These are the *raw* row shapes: snake_case, unix seconds as numbers, NULLable
 * columns as `| null`, and `_enc` columns still sealed. Repos are what turn them
 * into something the rest of the Worker should see -- nothing outside
 * `worker/db/**` should ever hold a `*_enc` string.
 *
 * Kept free of Worker runtime types on purpose, so the unit tests can import it.
 */

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
