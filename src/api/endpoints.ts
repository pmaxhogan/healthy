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
  CreateProviderRequest,
  GoogleAccountDto,
  McpAuditDto,
  McpGrantDto,
  McpToolInfoDto,
  OverviewDto,
  PolicyRuleDto,
  ProviderDto,
  RunDto,
  SettingsDto,
  SettingsPatch,
  UpdateProviderRequest,
} from "@shared/types.ts";

/** The 202 body of every route whose work outlives the response. */
export interface Accepted {
  accepted: boolean;
}

export const endpoints = {
  /** Session probe. Answers `{ ok: true }` or triggers the re-auth navigation. */
  whoami: (): Promise<{ ok: boolean }> => api.get("/api/whoami"),

  overview: (signal?: AbortSignal): Promise<OverviewDto> => api.get("/api/overview", signal),

  providers: (signal?: AbortSignal): Promise<ProviderDto[]> => api.get("/api/providers", signal),
  createProvider: (body: CreateProviderRequest): Promise<ProviderDto> =>
    api.post("/api/providers", body),
  /**
   * PATCH, not PUT: the FHIR base is not editable, so this is a partial update by
   * construction. The `config` it carries, however, replaces the stored config
   * wholesale -- the Worker says so -- which is how a blank field clears back to
   * the global default.
   */
  updateProvider: (id: string, body: UpdateProviderRequest): Promise<ProviderDto> =>
    api.patch(`/api/providers/${encodeURIComponent(id)}`, body),
  setProviderSecret: (id: string, clientSecret: string): Promise<ProviderDto> =>
    api.post(`/api/providers/${encodeURIComponent(id)}/secret`, { clientSecret }),
  /** 202 `{ accepted: true }`: the sync outlives the response, so /api/runs is where the result lands. */
  syncProvider: (id: string): Promise<Accepted> =>
    api.post(`/api/providers/${encodeURIComponent(id)}/sync`),
  /** Awaited server-side, so this one does answer with the connection's new state. */
  refreshProviderToken: (id: string): Promise<ConnectionDto> =>
    api.post(`/api/providers/${encodeURIComponent(id)}/refresh-token`),
  fullRefreshProvider: (id: string): Promise<Accepted> =>
    api.post(`/api/providers/${encodeURIComponent(id)}/full-refresh`),
  deleteProvider: (id: string): Promise<void> =>
    api.delete(`/api/providers/${encodeURIComponent(id)}`),

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

  alerts: (signal?: AbortSignal): Promise<AlertDto[]> => api.get("/api/alerts", signal),
  sendTestAlert: (): Promise<AlertTestResponse> => api.post("/api/alerts/test"),
  archiveTestAlert: (id: string): Promise<void> =>
    api.delete(`/api/alerts/test/${encodeURIComponent(id)}`),

  runs: (signal?: AbortSignal): Promise<RunDto[]> => api.get("/api/runs", signal),
  runSync: (): Promise<Accepted> => api.post("/api/sync/run"),

  brands: (q: string, signal?: AbortSignal): Promise<BrandDto[]> =>
    api.get(`/api/brands?q=${encodeURIComponent(q)}`, signal),
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
