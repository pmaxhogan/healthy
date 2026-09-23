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
export type MailKind = "otp" | "forward_verify" | "other";

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
  /**
   * Sign-in attempts one patient-portal account may make per UTC day.
   *
   * Editable so that live QA against a real portal can raise it for an afternoon;
   * the default of three is chosen against the portal's own lockout, not against
   * our convenience.
   */
  portalLoginAttemptLimit: number;
  /**
   * The patient-portal login shell's API path prefix, when the deployment needs
   * one and discovery could not learn it on its own.
   *
   * Null for almost every deployment: the value normally comes out of discovery
   * and is stored on the account's own endpoint instead. This is the fallback of
   * last resort, and there is no admin UI for it today -- it is set directly in
   * D1 for the rare account that needs it.
   */
  portalApiBasePath: string | null;
}

export type SettingsPatch = Partial<SettingsDto>;

/**
 * The sync engine's own working shape for a run in progress -- see
 * `worker/sync/run.ts` for why `errors` still names a provider here. None of that
 * survives being written to `run_log`, so it is `RunSummaryDto`, not this, that
 * `RunDto` actually carries.
 */
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
  /** Upcoming visits the patient-portal pass read, across every portal account. */
  portalVisits: number;
  /** Portal visits not calendared because a FHIR event already covers them. */
  portalSkipped: number;
  /**
   * Stable codes from portal accounts that failed, and only codes.
   *
   * Deliberately *not* folded into `errors`: a portal session that needs the
   * owner's attention is an expected state that can persist for days, and putting
   * it in `errors` would mark every hourly run `ok = 0` and drown the failures
   * that really are failures. The portal's own state machine
   * (`portal_accounts.session_state`, plus the Trello card) is what escalates it.
   */
  portalErrors: string[];
}

/**
 * What `RunDto.summary` actually contains: the same counts as `RunSummary`, but
 * `errors` and `warningCodes` are the bare, stable codes `run_log.summary_json`
 * stores -- never a provider id, which is one join away from naming a health
 * system. `warnings` stays a count; `warningCodes` is the distinct codes behind
 * it, e.g. an Epic OperationOutcome code -- which, not how many.
 */
export interface RunSummaryDto extends Omit<RunSummary, "errors"> {
  errors: string[];
  warningCodes: string[];
}

export interface RunDto {
  id: string;
  kind: RunKind;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  summary: RunSummaryDto | null;
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
  /**
   * True when the policy engine could make nothing of this target.
   *
   * A stored rule that parses to nothing is the worst kind of wrong: the owner
   * believes an exposure is denied and it is not. Only a malformed `field` target
   * (or a blank one) can land here -- a `tool`, `resource` or `provider` target is
   * taken literally, so a valid-looking name that simply matches no tool is not
   * reported. The admin UI shows a warning next to the row.
   */
  unparsed: boolean;
}

/**
 * The payload of `POST /api/mcp/policy`: a rule without its server-assigned parts.
 *
 * Mirrors `policyRuleSchema` on the Worker side, which is strict -- an extra key is
 * a 400, and `note` must be absent rather than empty.
 */
export interface CreatePolicyRuleRequest {
  ruleType: PolicyRuleType;
  target: string;
  /**
   * `| undefined` explicitly, under `exactOptionalPropertyTypes`: this is the type
   * the Worker's own parser produces for an absent optional field, and the route
   * is typed against this interface so the two cannot drift.
   */
  note?: string | undefined;
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

/**
 * One tool's real, live input schema -- draft-07 JSON Schema, generated from the
 * same zod schema the MCP server validates arguments against. Backs the admin
 * console's "Try a tool" panel: the tool picker's descriptions and the argument
 * editor's skeleton and live validation all come from this, not from the
 * hand-maintained {@link McpToolInfoDto} list (which has no schema to give).
 */
export interface McpToolSchemaDto {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * `POST /api/mcp/tools/:name/call`.
 *
 * The whole point is transparency: the exact arguments sent and the exact answer
 * the tool gave, so the owner can see what an MCP client would see. `result.data`
 * is the tool's JSON envelope (`{ items, warnings, truncated, ... }` on success, or
 * `{ error, message }` on a tool-level failure such as `policy_denied`) -- both
 * shapes are valid outcomes of a call that reached the tool, which is why they
 * share one 200 response rather than one being an HTTP error. A request that never
 * reached the tool at all (an unknown name, arguments that fail the input schema)
 * is a 4xx `ApiError` instead; see `worker/api/routes/mcp.ts`.
 */
export interface McpToolCallResponse {
  request: {
    name: string;
    arguments: Record<string, unknown>;
  };
  result: {
    isError: boolean;
    data: unknown;
  };
  durationMs: number;
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
 * The 201 body of `POST /api/alerts/test`.
 *
 * A Trello card id, not an alert id: the endpoint deliberately writes no `alerts`
 * row, because a test is not an alert and one there would make the dashboard's
 * open-alert count lie.
 */
export interface AlertTestResponse {
  cardId: string;
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

/**
 * One `mail_inbox` row, as the Mail admin page shows it.
 *
 * `fromDomain` only -- never the full sender address, matching the page's own
 * design ("table of recent entries ... sender domain"). `pendingCode` and
 * `pendingUrl` are only ever non-null for `kind === "forward_verify"`: the
 * Worker never returns an 'otp' row's code over this API, even though the
 * value exists sealed in D1 -- see `worker/db/repos/mail-inbox.ts`.
 */
export interface MailInboxEntryDto {
  id: string;
  receivedAt: string;
  fromDomain: string;
  subject: string | null;
  kind: MailKind;
  consumedAt: string | null;
  expiresAt: string | null;
  rawSize: number;
  pendingCode: string | null;
  pendingUrl: string | null;
}

/** `GET /api/mail/settings` and the body of its `PUT`. */
export interface MailSettingsDto {
  /** Sender domains the inbound email handler accepts mail from. */
  allowlist: string[];
}

/** Health of a provider's portal session. Mirrors `portal_accounts.session_state`. */
export type PortalSessionState = "none" | "active" | "needs_reauth";

/**
 * How far a sign-in attempt got.
 *
 * Two values, because the portal's own flow has two outcomes: the password was
 * enough, or it now wants a code that will arrive by email. The admin UI polls
 * for this and shows "waiting for the emailed code" on the second one.
 */
export type PortalSignInStatus = "signed_in" | "awaiting_code";

/**
 * One provider's portal account.
 *
 * Write-only credentials: `hasCredentials` is the whole of what the UI learns
 * about the username and password, and nothing here reflects the cookie jar's
 * contents either -- a session cookie is as good as the password.
 */
export interface PortalAccountDto {
  providerId: string;
  /** Origin only, as discovery settled on it. Null until it has been probed. */
  baseUrl: string | null;
  /** The prefix the portal is mounted under, with both slashes. */
  mountPath: string | null;
  /** True when both a username and a password are stored. */
  hasCredentials: boolean;
  /** True when a cookie jar is stored, whether or not it still works. */
  hasSession: boolean;
  /** True when an address to email a verification code to is stored. */
  hasMfaContact: boolean;
  /**
   * True when the domain this account's verification codes come from is known.
   *
   * The domain itself is never reported -- it names the health system. What the
   * card shows is that the binding exists: until it does, a code from any
   * allowlisted sender is eligible for this account's sign-in.
   */
  hasOtpSender: boolean;
  state: PortalSessionState;
  lastLoginAt: string | null;
  lastOkAt: string | null;
  lastErrorCode: string | null;
  needsReauthSince: string | null;
  /** Sign-in attempts used today, against the daily cap. */
  loginAttemptsToday: number;
  updatedAt: string | null;
}

/**
 * What the repo's `setCredentials` takes, and what the CLI script writes.
 *
 * `baseUrl` and `mountPath` are optional: the owner can save credentials against
 * an already-discovered endpoint, or supply the URL at the same time. The admin
 * API's own body is `PutPortalAccountRequest` below, which carries a mount
 * *hint* rather than a mount path -- the path is whatever discovery settles on.
 */
export interface SetPortalCredentialsRequest {
  username: string;
  password: string;
  baseUrl?: string | undefined;
  mountPath?: string | undefined;
  /**
   * Where the portal should email a verification code, when its own login
   * response does not say. Omitted leaves whatever is already stored alone;
   * there is no way to clear it once set except storing a new value.
   */
  mfaContact?: string | undefined;
  /**
   * The domain the portal's verification-code emails come from.
   *
   * Narrows which `mail_inbox` row may be claimed as this account's code.
   * Omitted leaves whatever is already stored (or learned) alone.
   */
  otpSenderDomain?: string | undefined;
}

/**
 * The body of `PUT /api/providers/:id/portal`.
 *
 * `baseUrl` is any URL on the portal's host; the handler keeps only its origin
 * and runs discovery from there. `mountHint` is a prefix the owner already knows
 * (`/MyChart/`), probed first. Both are optional once an endpoint is stored:
 * saving a new password against a known portal is the common case.
 */
export interface PutPortalAccountRequest {
  username: string;
  password: string;
  baseUrl?: string | undefined;
  mountHint?: string | undefined;
  /**
   * Where the portal should email a verification code, when its own login
   * response does not say. Optional, and left alone when omitted -- most
   * deployments never need it.
   */
  mfaContact?: string | undefined;
  /**
   * The domain the portal's verification-code emails come from, e.g. the part
   * after the `@` of the sender.
   *
   * Optional: left alone when omitted, and learned from the first code the
   * portal accepts when it has never been set. Setting it is what stops any
   * other allowlisted sender's code from being claimed for this account.
   */
  otpSenderDomain?: string | undefined;
  /**
   * The origin `POST .../portal/discover` reported, echoed back by the owner.
   *
   * Required. A discovery chain can follow a vanity alias to a different origin,
   * and that origin is where the portal password is POSTed on every later
   * sign-in -- so it is not something one unattended call may decide. The Worker
   * refuses with `portal_origin_unconfirmed` when the origin it lands on is not
   * this one.
   */
  confirmedOrigin: string;
}

/**
 * The body of `POST /api/providers/:id/portal/discover`.
 *
 * Deliberately carries no credential: this probes for a login page and stores
 * nothing at all, so the owner can be shown where the portal actually is before
 * anything is sealed against it.
 */
export interface PortalDiscoverRequest {
  /** Any URL on the portal's host. Only its origin is probed. */
  baseUrl: string;
  /** A mount prefix the owner already knows (`/MyChart/`), probed first. */
  mountHint?: string | undefined;
}

/**
 * What discovery found, and nothing more.
 *
 * `origin` is the value the owner has to echo back as `confirmedOrigin` before
 * credentials are stored. `flavor` is which login application drives the
 * deployment, shown so "the portal moved" and "the portal changed how it signs
 * you in" do not look like the same thing.
 */
export interface PortalDiscoveryDto {
  origin: string;
  mountPath: string;
  flavor: string;
}

/**
 * How far the current (or last) sign-in attempt got.
 *
 * Reported by `GET /api/providers/:id/portal` for the admin UI to poll while a
 * sign-in is in flight. It lives in the sign-in runner's own Durable Object
 * storage, not in D1: it is progress, and the durable answer is
 * `PortalAccountDto.state` plus `lastErrorCode`.
 *
 * The phases are the portal's own flow. `awaiting_code` is the one that lasts --
 * the Worker has asked the portal to email a code and is waiting for it to
 * arrive in the inbox, which takes seconds to a couple of minutes.
 */
export type PortalSignInPhase =
  "idle" | "logging_in" | "awaiting_code" | "validating" | "signed_in" | "failed";

export interface PortalSignInState {
  phase: PortalSignInPhase;
  /**
   * The stable failure code when `phase` is "failed", e.g. `portal_login_failed`.
   *
   * **Never the emailed verification code.** A one-time code is read from the
   * inbox, handed straight to the portal and never leaves the Worker -- it is not
   * in any DTO, any log line or any error body.
   */
  code: string | null;
  /** Unix seconds -- not an ISO instant, unlike the rest of this DTO. */
  startedAt: number | null;
  /** Unix seconds. Moves on every phase change, so a poller can show progress. */
  updatedAt: number | null;
}

/**
 * `GET /api/providers/:id/portal`: the stored account plus live sign-in progress.
 *
 * Always answered, even for a provider that has never had a portal account: the
 * admin UI's portal card renders from this, so a missing row is a synthesized
 * default (`state: "none"`, everything else null) rather than a 404.
 */
export interface PortalAccountStatusDto extends PortalAccountDto {
  signIn: PortalSignInState;
  /**
   * Upcoming visits currently tracked from this portal, as of the last time it
   * answered. Null when it never has.
   */
  lastVisitCount: number | null;
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
