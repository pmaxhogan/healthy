// Every URL the SPA knows, in one file, typed against shared/types.ts.
//
// Nothing else in src/** writes a path string. That is what makes the admin API
// a contract rather than a habit: if the Worker moves a route, exactly one file
// here changes and the compiler finds the call sites.
//
// Two shapes are NOT in shared/types.ts and are declared locally, flagged as
// contract gaps: the response to POST /api/alerts/test, and the payload of
// POST /api/mcp/policy (which is PolicyRuleDto without its server-assigned
// fields).

import { api, ApiRequestError } from "./client.ts";

import type {
  AlertDto,
  BrandDto,
  CalendarOptionDto,
  ConnectionDto,
  ColorOptionDto,
  CreateProviderRequest,
  GoogleAccountDto,
  McpAuditDto,
  McpGrantDto,
  McpToolInfoDto,
  OverviewDto,
  PolicyRuleDto,
  PolicyRuleType,
  ProviderDto,
  RunDto,
  SettingsDto,
  SettingsPatch,
  UpdateProviderRequest,
} from "@shared/types.ts";

/**
 * CONTRACT GAP: the test-card response is not in shared/types.ts.
 *
 * `POST /api/alerts/test` answers `201 { cardId }` -- the Trello card id, not an
 * alert id, because the endpoint deliberately writes no `alerts` row.
 */
export interface TestAlertDto {
  cardId: string;
}

/** The 202 body of every route whose work outlives the response. */
export interface Accepted {
  accepted: boolean;
}

/**
 * CONTRACT GAP: the create-rule payload is not in shared/types.ts.
 *
 * Matches `policyRuleSchema` on the Worker side, which is a strict object -- an
 * extra key is a 400, and `note` must be absent rather than empty.
 */
export interface CreatePolicyRuleRequest {
  ruleType: PolicyRuleType;
  target: string;
  note?: string;
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
  sendTestAlert: (): Promise<TestAlertDto> => api.post("/api/alerts/test"),
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
