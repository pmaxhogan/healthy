// Every URL the SPA knows, in one file, typed against shared/types.ts.
//
// Nothing else in src/** writes a path string. That is what makes the admin API
// a contract rather than a habit: if the Worker moves a route, exactly one file
// here changes and the compiler finds the call sites.
//
// Every request and response shape lives in shared/types.ts, including the ones
// that used to be declared here as contract gaps: the POST /api/alerts/test
// response and the POST /api/mcp/policy payload.

import { api, ApiRequestError } from "./client.ts";

import type {
  AlertDto,
  AlertTestResponse,
  BrandDto,
  CalendarOptionDto,
  ConnectionDto,
  ColorOptionDto,
  CreatePolicyRuleRequest,
  CreateHealthSystemRequest,
  GoogleAccountDto,
  MailInboxEntryDto,
  MailSettingsDto,
  McpAuditDto,
  McpGrantDto,
  McpToolCallResponse,
  McpToolInfoDto,
  McpToolSchemaDto,
  OverviewDto,
  PolicyRuleDto,
  PortalAccountStatusDto,
  PortalDiscoverRequest,
  PortalDiscoveryDto,
  PortalSignInPhase,
  HealthSystemDto,
  PutPortalAccountRequest,
  RunDto,
  SettingsDto,
  SettingsPatch,
  UpdateHealthSystemRequest,
} from "@shared/types.ts";

/** The 202 body of every route whose work outlives the response. */
export interface Accepted {
  accepted: boolean;
}

const IN_PROGRESS_SIGNIN_PHASES: ReadonlySet<PortalSignInPhase> = new Set([
  "logging_in",
  "awaiting_code",
  "validating",
]);

/** Whether a sign-in is still working, and so still worth polling for. */
export function isPortalSignInInProgress(phase: PortalSignInPhase): boolean {
  return IN_PROGRESS_SIGNIN_PHASES.has(phase);
}

export const endpoints = {
  /** Session probe. Answers `{ ok: true }` or triggers the re-auth navigation. */
  whoami: (): Promise<{ ok: boolean }> => api.get("/api/whoami"),

  overview: (signal?: AbortSignal): Promise<OverviewDto> => api.get("/api/overview", signal),

  healthSystems: (signal?: AbortSignal): Promise<HealthSystemDto[]> =>
    api.get("/api/health-systems", signal),
  createHealthSystem: (body: CreateHealthSystemRequest): Promise<HealthSystemDto> =>
    api.post("/api/health-systems", body),
  /**
   * PATCH, not PUT: the FHIR base is not editable, so this is a partial update by
   * construction. The `config` it carries, however, replaces the stored config
   * wholesale -- the Worker says so -- which is how a blank field clears back to
   * the global default.
   */
  updateHealthSystem: (id: string, body: UpdateHealthSystemRequest): Promise<HealthSystemDto> =>
    api.patch(`/api/health-systems/${encodeURIComponent(id)}`, body),
  setHealthSystemSecret: (id: string, clientSecret: string): Promise<HealthSystemDto> =>
    api.post(`/api/health-systems/${encodeURIComponent(id)}/secret`, { clientSecret }),
  /** 202 `{ accepted: true }`: the sync outlives the response, so /api/runs is where the result lands. */
  syncHealthSystem: (id: string): Promise<Accepted> =>
    api.post(`/api/health-systems/${encodeURIComponent(id)}/sync`),
  /** Awaited server-side, so this one does answer with the connection's new state. */
  refreshHealthSystemToken: (id: string): Promise<ConnectionDto> =>
    api.post(`/api/health-systems/${encodeURIComponent(id)}/refresh-token`),
  fullRefreshHealthSystem: (id: string): Promise<Accepted> =>
    api.post(`/api/health-systems/${encodeURIComponent(id)}/full-refresh`),
  deleteHealthSystem: (id: string): Promise<void> =>
    api.delete(`/api/health-systems/${encodeURIComponent(id)}`),

  /**
   * Always answered, even for a health system that has never had a portal account --
   * the Worker synthesizes a `state: "none"` default rather than 404ing, so the
   * card can always render Save. See `PortalAccountStatusDto` in shared/types.ts.
   */
  portalAccount: (healthSystemId: string, signal?: AbortSignal): Promise<PortalAccountStatusDto> =>
    api.get(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal`, signal),
  /**
   * Probe for the portal without storing anything, so the owner can confirm the
   * origin before a credential is sealed against it. Step one of `savePortalAccount`.
   */
  discoverPortal: (
    healthSystemId: string,
    body: PortalDiscoverRequest,
  ): Promise<PortalDiscoveryDto> =>
    api.post(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal/discover`, body),
  /**
   * PUT, not POST: this replaces the login wholesale. `username`, `password` and
   * `confirmedOrigin` are all required on every call, never a partial update.
   */
  savePortalAccount: (
    healthSystemId: string,
    body: PutPortalAccountRequest,
  ): Promise<PortalAccountStatusDto> =>
    api.put(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal`, body),
  /** 202 `{ accepted, started }`: the sign-in outlives the response -- poll `portalAccount` for it. */
  startPortalSignIn: (healthSystemId: string): Promise<Accepted & { started: boolean }> =>
    api.post(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal/sign-in`),
  /** Drops the stored cookie jar without touching the saved credentials. */
  forgetPortalSession: (healthSystemId: string): Promise<void> =>
    api.delete(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal/session`),
  /** Removes the credentials and the session both. */
  removePortalAccount: (healthSystemId: string): Promise<void> =>
    api.delete(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal`),
  syncPortalNow: (healthSystemId: string): Promise<Accepted> =>
    api.post(`/api/health-systems/${encodeURIComponent(healthSystemId)}/portal/sync`),

  google: (signal?: AbortSignal): Promise<GoogleAccountDto> => api.get("/api/google", signal),
  googleCalendars: (signal?: AbortSignal): Promise<CalendarOptionDto[]> =>
    api.get("/api/google/calendars", signal),
  googleColors: (signal?: AbortSignal): Promise<ColorOptionDto[]> =>
    api.get("/api/google/colors", signal),
  disconnectGoogle: (): Promise<void> => api.delete("/api/google"),

  settings: (signal?: AbortSignal): Promise<SettingsDto> => api.get("/api/settings", signal),
  saveSettings: (patch: SettingsPatch): Promise<SettingsDto> => api.put("/api/settings", patch),

  policyRules: (signal?: AbortSignal): Promise<PolicyRuleDto[]> =>
    api.get("/api/mcp/policy", signal),
  createPolicyRule: (body: CreatePolicyRuleRequest): Promise<PolicyRuleDto> =>
    api.post("/api/mcp/policy", body),
  deletePolicyRule: (id: string): Promise<void> =>
    api.delete(`/api/mcp/policy/${encodeURIComponent(id)}`),

  mcpGrants: (signal?: AbortSignal): Promise<McpGrantDto[]> => api.get("/api/mcp/grants", signal),
  revokeMcpGrant: (id: string): Promise<void> =>
    api.delete(`/api/mcp/grants/${encodeURIComponent(id)}`),
  mcpAudit: (limit: number, signal?: AbortSignal): Promise<McpAuditDto[]> =>
    api.get(`/api/mcp/audit?limit=${String(limit)}`, signal),
  /** Every tool's real, live JSON input schema -- for the "Try a tool" panel. */
  mcpToolSchemas: (signal?: AbortSignal): Promise<McpToolSchemaDto[]> =>
    api.get("/api/mcp/tools/schema", signal),
  /** Runs one tool exactly as an MCP client would: same validation, same policy, same audit. */
  callMcpTool: (name: string, args: Record<string, unknown>): Promise<McpToolCallResponse> =>
    api.post(`/api/mcp/tools/${encodeURIComponent(name)}/call`, args),

  alerts: (signal?: AbortSignal): Promise<AlertDto[]> => api.get("/api/alerts", signal),
  sendTestAlert: (): Promise<AlertTestResponse> => api.post("/api/alerts/test"),
  archiveTestAlert: (id: string): Promise<void> =>
    api.delete(`/api/alerts/test/${encodeURIComponent(id)}`),

  runs: (signal?: AbortSignal): Promise<RunDto[]> => api.get("/api/runs", signal),
  runSync: (): Promise<Accepted> => api.post("/api/sync/run"),

  brands: (q: string, signal?: AbortSignal): Promise<BrandDto[]> =>
    api.get(`/api/brands?q=${encodeURIComponent(q)}`, signal),

  mailInbox: (signal?: AbortSignal): Promise<MailInboxEntryDto[]> =>
    api.get("/api/mail/inbox", signal),
  mailSettings: (signal?: AbortSignal): Promise<MailSettingsDto> =>
    api.get("/api/mail/settings", signal),
  saveMailSettings: (allowlist: string[]): Promise<MailSettingsDto> =>
    api.put("/api/mail/settings", { allowlist }),
  sendMailTest: (): Promise<MailInboxEntryDto> => api.post("/api/mail/test"),
};

/**
 * The MCP tool catalogue, used to offer tool names as policy-rule targets.
 *
 * Optional by design: the route is a convenience, so a deployment that has not
 * got it yet loses the autocomplete and nothing else.
 */
export async function mcpToolsOrNone(signal?: AbortSignal): Promise<McpToolInfoDto[]> {
  try {
    return await api.get<McpToolInfoDto[]>("/api/mcp/tools", signal);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return [];
    throw error;
  }
}

/** Ends the session. The caller reloads afterwards so the server re-gates. */
export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}
