/**
 * DTOs shared by the Worker's admin API (worker/api/**) and the Vue SPA (src/**).
 *
 * Rules: nothing here carries ciphertext, tokens or clinical content. Rows are projected
 * into these shapes on the Worker side; the SPA never sees a raw D1 row.
 */

export type Vendor = "epic";
export type ProviderEnvironment = "prod" | "sandbox";
export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "disconnected";
export type RunKind = "calendar" | "full" | "refresh" | "manual";
export type PolicyRuleType = "tool" | "resource" | "field" | "provider";

/** Per-provider configuration, editable in the UI. */
export interface ProviderConfig {
  /** Title template with {visitType} {practitioner} {specialty} {orgShort} {org} {department} {apptTime}. */
  titleTemplate?: string;
  /** Google event colorId from the live palette. */
  colorId?: string;
  /** Minutes before the reported time the owner is expected to arrive. */
  arrivalOffsetMin?: number;
  /** Overrides keyed by visit type text (case-insensitive). */
  arrivalOffsetsByVisitType?: Record<string, number>;
  /** Short org label used by {orgShort}. */
  orgShort?: string;
  /** Sync on/off without removing the connection. */
  enabled?: boolean;
}

export interface ProviderDto {
  id: string;
  vendor: Vendor;
  displayName: string;
  brandKey: string | null;
  fhirBaseUrl: string;
  portalUrl: string | null;
  environment: ProviderEnvironment;
  hasClientSecret: boolean;
  config: ProviderConfig;
  connection: ConnectionDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionDto {
  id: string;
  providerId: string;
  status: ConnectionStatus;
  /** ISO; when the current access token expires. */
  accessExpiresAt: string | null;
  hasRefreshToken: boolean;
  scope: string | null;
  lastRefreshAt: string | null;
  lastSyncAt: string | null;
  lastFullRefreshAt: string | null;
  lastErrorCode: string | null;
  needsReauthSince: string | null;
  refreshFailures: number;
  /** Path (not absolute URL) the UI turns into the reconnect link. */
  reconnectPath: string;
}

export interface GoogleAccountDto {
  status: ConnectionStatus | "not_connected";
  /** Primary calendar id doubles as the account label; masked for display (e.g. "p…n@gmail.com"). */
  accountLabel: string | null;
  accessExpiresAt: string | null;
  lastRefreshAt: string | null;
  needsReauthSince: string | null;
  connectedAt: string | null;
  calendarId: string;
}

export interface CalendarOptionDto {
  id: string;
  summary: string;
  primary: boolean;
  timeZone: string | null;
  backgroundColor: string | null;
}

export interface ColorOptionDto {
  id: string;
  background: string;
  foreground: string;
}

export interface SettingsDto {
  timezone: string | null;
  calendarId: string;
  defaultTitleTemplate: string;
  defaultColorId: string | null;
  ghostColorId: string;
  defaultArrivalOffsetMin: number;
  windowPastDays: number;
  syncBackoffUntil: string | null;
  mcpEnabled: boolean;
}

export type SettingsPatch = Partial<SettingsDto>;

export interface RunSummary {
  providers: number;
  encountersSeen: number;
  eventsInserted: number;
  eventsPatched: number;
  eventsGhosted: number;
  eventsRestored: number;
  resourcesCached: number;
  warnings: number;
  filteredView: boolean;
  backedOff: boolean;
  errors: { providerId: string; code: string }[];
}

export interface RunDto {
  id: string;
  kind: RunKind;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  summary: RunSummary | null;
}

export interface AlertDto {
  id: string;
  kind: "reconnect";
  subject: string;
  providerId: string | null;
  trelloCardId: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export interface PolicyRuleDto {
  id: string;
  ruleType: PolicyRuleType;
  /** tool name | resource type | field path "ResourceType.path.to.field" | provider id */
  target: string;
  note: string | null;
  createdAt: string;
}

export interface McpGrantDto {
  id: string;
  clientId: string;
  clientName: string | null;
  scope: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface McpAuditDto {
  id: string;
  ts: string;
  clientId: string;
  tool: string;
  providerIds: string[];
  resultCount: number;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
}

export interface McpToolInfoDto {
  name: string;
  description: string;
  resourceTypes: string[];
}

export interface OverviewDto {
  providers: ProviderDto[];
  google: GoogleAccountDto;
  openAlerts: AlertDto[];
  lastRuns: RunDto[];
  /** Counts of cached FHIR resources per type per provider; numbers only. */
  cacheCounts: { providerId: string; resourceType: string; count: number }[];
  calendarEvents: { active: number; ghost: number };
  mcp: { enabled: boolean; grants: number; auditLast24h: number; policyRules: number };
  settings: SettingsDto;
}

export interface BrandDto {
  id: string;
  name: string;
  aliases: string[];
  fhirBaseUrl: string;
  portalUrl: string | null;
  locations: string[];
}

export interface CreateProviderRequest {
  displayName: string;
  /** Either a brand id from /api/brands or a manual fhirBaseUrl (discovery is run either way). */
  brandId?: string;
  fhirBaseUrl?: string;
  portalUrl?: string;
  environment: ProviderEnvironment;
  /** Per-org client secret from the Epic developer portal; write-only. */
  clientSecret?: string;
  config?: ProviderConfig;
}

export interface UpdateProviderRequest {
  displayName?: string;
  portalUrl?: string | null;
  config?: ProviderConfig;
}

export interface SetProviderSecretRequest {
  clientSecret: string;
}

/**
 * `GET /health`, the one route an unauthenticated stranger can read.
 *
 * Deliberately says nothing else: no version, no build, no connection count. Every
 * extra field would be information disclosure on a public endpoint.
 */
export interface HealthResponse {
  ok: true;
}

export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** Header every state-changing /api request must carry (value "1"). */
export const CSRF_HEADER = "x-healthy-csrf";
/** Header the Worker sets on 401/403 responses that require re-authentication. */
export const AUTH_REQUIRED_HEADER = "x-healthy-auth";
