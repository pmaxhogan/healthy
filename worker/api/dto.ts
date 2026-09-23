/**
 * Row -> DTO projections for the admin API.
 *
 * This module is the *only* place a D1 row turns into something the SPA sees, and
 * it is a pure function of its argument: no D1, no Env, no fetch. That is what
 * makes the guarantee testable, and the guarantee is the reason the file exists --
 * **no projection here ever reads a `*_enc` column.** The sealed columns are not
 * merely omitted from the output; the functions below do not take a row's sealed
 * fields as an input at all, so a future field cannot be added by copying a
 * spread. Where the UI needs to know that a secret exists, the caller passes a
 * boolean (`hasClientSecret`, `hasRefreshToken`) that it derived from the row.
 *
 * Two representation mismatches are bridged here rather than in the handlers:
 *
 *  - **camelCase vs snake_case.** `shared/types.ts` is the SPA's vocabulary and is
 *    camelCase; `health_systems.config_json` and the `settings` table are snake_case
 *    because that is what the columns are called. Both directions live here.
 *  - **seconds vs ISO.** Every D1 timestamp is an integer unix second; every DTO
 *    field is an ISO-8601 instant, because that is what `Date` parses and what
 *    `Intl` formats.
 */

import { toIso } from "../lib/time.ts";
import { parseAllowlistCsv } from "../mail/classify.ts";
import { buildRules } from "../policy/rules.ts";

import type {
  AlertRow,
  ConnectionRow,
  MailKind,
  McpPolicyRow,
  HealthSystemRow,
} from "../db/rows.ts";
import type {
  HealthSystemConfig as DbHealthSystemConfig,
  HealthSystemConfigInput,
  RunSummary as DbRunSummary,
  Settings,
} from "../db/schemas.ts";
import type {
  AlertDto,
  ConnectionDto,
  GoogleAccountDto,
  MailInboxEntryDto,
  MailSettingsDto,
  McpAuditDto,
  PolicyRuleDto,
  HealthSystemConfig,
  HealthSystemDto,
  RunDto,
  RunKind,
  RunSummaryDto,
  SettingsDto,
  SettingsPatch,
  Vendor,
} from "@shared/types.ts";

/**
 * The same properties, but every optional one may also be explicitly `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, which makes `{ titleTemplate?: string }` and
 * `{ titleTemplate?: string | undefined }` genuinely different types -- and a zod
 * `.optional()` produces the second. Rather than loosen the DTOs in `shared/`
 * (where the stricter shape is right: the SPA should not send an explicit
 * `undefined`), the two functions that *accept* a DTO accept this widening of it.
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * The decoded `run_log` and `mcp_audit` rows, mirrored rather than imported.
 *
 * `db/repos/*.ts` reach the Worker runtime types (`D1Database`), and this module is
 * deliberately importable from the plain-Node unit tests -- the same reason
 * `db/schemas.ts` is written the way it is. These two shapes are structural, so the
 * repos' own return types satisfy them and a divergence is a compile error at the
 * call site in `worker/api/routes/`.
 */
export interface RunEntryLike {
  id: string;
  kind: RunKind;
  startedAt: number;
  finishedAt: number | null;
  /** null while the run is still going. */
  ok: boolean | null;
  summary: DbRunSummary;
}

export interface AuditEntryLike {
  id: string;
  ts: number;
  clientId: string | null;
  tool: string;
  healthSystems: string[];
  resultCount: number;
  ok: boolean;
  errorCode: string | null;
  durationMs: number | null;
}

/** A unix second as an ISO instant, passing null through. */
function isoOrNull(seconds: number | null): string | null {
  return seconds === null ? null : toIso(seconds);
}

/**
 * `health_systems.vendor` is CHECK-constrained by the migration to the vendors the
 * adapter registry knows, so the column cannot hold anything else. The assertion
 * carries that fact across the db boundary without a runtime branch that could
 * never be taken.
 */
function toVendor(value: string): Vendor {
  return value as Vendor;
}

// ---------------------------------------------------------------------------
// health systems
// ---------------------------------------------------------------------------

/** `health_systems.config_json` -> the SPA's camelCase `HealthSystemConfig`. */
export function toHealthSystemConfigDto(config: DbHealthSystemConfig): HealthSystemConfig {
  const dto: HealthSystemConfig = {
    arrivalOffsetsByVisitType: { ...config.arrival_offsets_by_visit_type },
    enabled: config.enabled,
  };
  if (config.title_template !== undefined) dto.titleTemplate = config.title_template;
  if (config.color_id !== undefined) dto.colorId = config.color_id;
  if (config.arrival_offset_min !== undefined) dto.arrivalOffsetMin = config.arrival_offset_min;
  if (config.org_short !== undefined) dto.orgShort = config.org_short;
  return dto;
}

/** The SPA's `HealthSystemConfig` -> what `health_systems.update` takes. */
export function fromHealthSystemConfigDto(
  config: Loose<HealthSystemConfig>,
): HealthSystemConfigInput {
  const input: HealthSystemConfigInput = {};
  if (config.titleTemplate !== undefined) input.title_template = config.titleTemplate;
  if (config.colorId !== undefined) input.color_id = config.colorId;
  if (config.arrivalOffsetMin !== undefined) input.arrival_offset_min = config.arrivalOffsetMin;
  if (config.arrivalOffsetsByVisitType !== undefined) {
    input.arrival_offsets_by_visit_type = { ...config.arrivalOffsetsByVisitType };
  }
  if (config.orgShort !== undefined) input.org_short = config.orgShort;
  if (config.enabled !== undefined) input.enabled = config.enabled;
  return input;
}

/** Where the UI sends the owner to re-authorise one connection. */
export function reconnectPathFor(connectionId: string): string {
  return `/oauth/reconnect/${connectionId}`;
}

/**
 * A connection row -> `ConnectionDto`.
 *
 * `hasRefreshToken` is the only thing said about the sealed columns, and it is
 * derived from the column being non-null -- the ciphertext itself never leaves
 * the db layer, and this function never sees the plaintext either.
 */
export function toConnectionDto(row: ConnectionRow): ConnectionDto {
  return {
    id: row.id,
    healthSystemId: row.health_system_id,
    status: row.status,
    accessExpiresAt: isoOrNull(row.access_expires_at),
    hasRefreshToken: row.refresh_token_enc !== null,
    scope: row.scope,
    lastRefreshAt: isoOrNull(row.last_refresh_at),
    lastSyncAt: isoOrNull(row.last_sync_at),
    lastFullRefreshAt: isoOrNull(row.last_full_refresh_at),
    lastErrorCode: row.last_error_code,
    needsReauthSince: isoOrNull(row.needs_reauth_since),
    refreshFailures: row.refresh_failures,
    reconnectPath: reconnectPathFor(row.id),
  };
}

export interface HealthSystemProjection {
  row: HealthSystemRow;
  config: DbHealthSystemConfig;
  connection: ConnectionRow | null;
}

/** A health system row (plus its parsed config and connection) -> `HealthSystemDto`. */
export function toHealthSystemDto(input: HealthSystemProjection): HealthSystemDto {
  return {
    id: input.row.id,
    vendor: toVendor(input.row.vendor),
    displayName: input.row.display_name,
    brandKey: input.row.brand_key,
    fhirBaseUrl: input.row.fhir_base_url,
    portalUrl: input.row.portal_url,
    environment: input.row.environment,
    // The boolean, never the ciphertext: the admin UI only has to know whether
    // the per-organisation secret still needs to be pasted in.
    hasClientSecret: input.row.client_secret_enc !== null,
    config: toHealthSystemConfigDto(input.config),
    connection: input.connection === null ? null : toConnectionDto(input.connection),
    createdAt: toIso(input.row.created_at),
    updatedAt: toIso(input.row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// google_account
// ---------------------------------------------------------------------------

/**
 * Mask an account label for display: `p…n@gmail.com`.
 *
 * The owner needs to recognise *which* Google account is connected; nothing else
 * about the address is useful in the UI, and the label is read back out of an
 * encrypted column, so the less of it that travels the better. A label with no
 * `@` (Google returns the calendar id, which is normally the address but need not
 * be) is masked the same way, minus a domain.
 */
export function maskAccountLabel(label: string | null): string | null {
  if (label === null || label === "") return null;
  const at = label.lastIndexOf("@");
  const local = at === -1 ? label : label.slice(0, at);
  const domain = at === -1 ? "" : label.slice(at);
  return local.length <= 2
    ? `${local.slice(0, 1)}…${domain}`
    : `${local.slice(0, 1)}…${local.slice(-1)}${domain}`;
}

/** What `toGoogleAccountDto` needs; the sealed columns are never passed in. */
export interface GoogleProjection {
  status: GoogleAccountDto["status"];
  /** The plaintext label, already opened by the repo. Masked on the way out. */
  label: string | null;
  accessExpiresAt: number | null;
  lastRefreshAt: number | null;
  needsReauthSince: number | null;
  connectedAt: number | null;
  calendarId: string;
}

export function toGoogleAccountDto(input: GoogleProjection): GoogleAccountDto {
  return {
    status: input.status,
    accountLabel: maskAccountLabel(input.label),
    accessExpiresAt: isoOrNull(input.accessExpiresAt),
    lastRefreshAt: isoOrNull(input.lastRefreshAt),
    needsReauthSince: isoOrNull(input.needsReauthSince),
    connectedAt: isoOrNull(input.connectedAt),
    calendarId: input.calendarId,
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export function toSettingsDto(settings: Settings): SettingsDto {
  return {
    timezone: settings.timezone,
    calendarId: settings.calendar_id,
    defaultTitleTemplate: settings.default_title_template,
    defaultColorId: settings.default_color_id,
    ghostColorId: settings.ghost_color_id,
    defaultArrivalOffsetMin: settings.default_arrival_offset_min,
    windowPastDays: settings.window_past_days,
    syncBackoffUntil: isoOrNull(settings.sync_backoff_until),
    mcpEnabled: settings.mcp_enabled,
    portalLoginAttemptLimit: settings.portal_login_attempt_limit,
    portalApiBasePath: settings.portal_api_base_path,
  };
}

/**
 * A `SettingsPatch` -> the `settings` keys to write.
 *
 * Only keys actually present in the patch are returned, so `setSettings` writes
 * exactly what the owner sent and leaves everything else alone.
 *
 * `syncBackoffUntil` is accepted but deliberately NOT written: the backoff is set
 * by the sync engine when an organisation answers 429 and cleared when the owner
 * presses "sync now". Letting the settings form move it would let a stale form
 * re-impose a backoff that had already expired.
 */
export function fromSettingsPatch(patch: Loose<SettingsPatch>): Partial<Settings> {
  const values: Partial<Settings> = {};
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.calendarId !== undefined) values.calendar_id = patch.calendarId;
  if (patch.defaultTitleTemplate !== undefined) {
    values.default_title_template = patch.defaultTitleTemplate;
  }
  if (patch.defaultColorId !== undefined) values.default_color_id = patch.defaultColorId;
  if (patch.ghostColorId !== undefined) values.ghost_color_id = patch.ghostColorId;
  if (patch.defaultArrivalOffsetMin !== undefined) {
    values.default_arrival_offset_min = patch.defaultArrivalOffsetMin;
  }
  if (patch.windowPastDays !== undefined) values.window_past_days = patch.windowPastDays;
  if (patch.mcpEnabled !== undefined) values.mcp_enabled = patch.mcpEnabled;
  if (patch.portalLoginAttemptLimit !== undefined) {
    values.portal_login_attempt_limit = patch.portalLoginAttemptLimit;
  }
  return values;
}

// ---------------------------------------------------------------------------
// run_log
// ---------------------------------------------------------------------------

/**
 * The stored summary -> the DTO the overview renders.
 *
 * The two vocabularies do not line up exactly, and the difference is worth
 * stating: the column holds what the sync engine counts, the DTO holds what the
 * UI shows.
 *
 *  - `encountersSeen` is the number of appointments the run actually saw
 *    upstream, which is everything it inserted, patched, restored or left
 *    unchanged. Ghosts are excluded on purpose: a ghost is an appointment that
 *    was *not* there.
 *  - `warnings` is how many warnings there were, not how many distinct codes.
 *    `warningCodes` is those distinct codes -- e.g. an Epic OperationOutcome code,
 *    which, not how many. A row written before `warningCount` existed has it at
 *    zero, so the number of distinct codes is the floor for `warnings` -- which is
 *    why that is a `max` and not a read.
 *  - `errors` is passed straight through: `run_log.summary_json.errors` is
 *    already bare, stable codes with no health system prefix, by design (see
 *    `worker/sync/run.ts`), so there is nothing here to parse.
 *  - `filteredView` and `backedOff` come straight off the stored summary. A run
 *    that saw a filtered schedule is the run that refused to ghost anything, and a
 *    backed-off one did almost nothing at all: both are the first thing to look at
 *    when a run reports no changes.
 */
export function toRunSummaryDto(summary: DbRunSummary): RunSummaryDto {
  return {
    healthSystems: summary.healthSystems,
    encountersSeen: summary.inserted + summary.patched + summary.restored + summary.unchanged,
    eventsInserted: summary.inserted,
    eventsPatched: summary.patched,
    eventsGhosted: summary.ghosted,
    eventsRestored: summary.restored,
    resourcesCached: summary.resources,
    warnings: Math.max(summary.warningCount, summary.warnings.length),
    warningCodes: [...summary.warnings],
    filteredView: summary.filteredView,
    backedOff: summary.backedOff,
    errors: [...summary.errors],
    portalVisits: summary.portalVisits,
    portalSkipped: summary.portalSkipped,
    portalErrors: [...summary.portalErrors],
  };
}

export function toRunDto(entry: RunEntryLike): RunDto {
  return {
    id: entry.id,
    kind: entry.kind,
    startedAt: toIso(entry.startedAt),
    finishedAt: isoOrNull(entry.finishedAt),
    ok: entry.ok,
    summary: toRunSummaryDto(entry.summary),
  };
}

// ---------------------------------------------------------------------------
// alerts, policy, audit
// ---------------------------------------------------------------------------

/**
 * `alerts.subject` is `health_system:<id>`, `portal:<id>` or the literal `google`.
 *
 * Both prefixes yield the same `healthSystemId`, because the UI groups alerts by the
 * health system they concern -- a dead FHIR grant and a dead portal session are
 * two alerts about one health system, and the subject string is still there for
 * anything that needs to tell them apart.
 */
const SUBJECT_PREFIXES = ["health_system:", "portal:"] as const;

/** The health system id a subject names, or null when it names none. */
function healthSystemIdOfSubject(subject: string): string | null {
  for (const prefix of SUBJECT_PREFIXES) {
    if (subject.startsWith(prefix)) return subject.slice(prefix.length);
  }
  return null;
}

export function toAlertDto(row: AlertRow): AlertDto {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    healthSystemId: healthSystemIdOfSubject(row.subject),
    trelloCardId: row.trello_card_id,
    openedAt: toIso(row.opened_at),
    resolvedAt: isoOrNull(row.resolved_at),
  };
}

/**
 * Project one policy rule, saying whether the engine could parse it.
 *
 * `unparsed` is answered by the engine itself, on this one row, rather than by a
 * second copy of the target grammar here. A rule the engine makes nothing of
 * enforces nothing, and the owner has no way to tell from the row: it looks
 * stored, because it is. That is the one lie this surface can tell, so the UI
 * gets told. See `PolicyRules.unparsed`.
 */
export function toPolicyRuleDto(row: McpPolicyRow): PolicyRuleDto {
  return {
    id: row.id,
    ruleType: row.rule_type,
    target: row.target,
    note: row.note,
    createdAt: toIso(row.created_at),
    unparsed: buildRules([row]).unparsed.length > 0,
  };
}

// ---------------------------------------------------------------------------
// mail_inbox
// ---------------------------------------------------------------------------

/**
 * The decoded `mail_inbox` entry `worker/db/repos/mail-inbox.ts` returns.
 *
 * Mirrored rather than imported, for the same reason as `RunEntryLike` above.
 * `senderDomain` is already only the domain: the repo opens `from_addr_enc`
 * and drops the local part, so the full address never reaches this layer.
 * `subject` is likewise already null for every kind but `forward_verify`, and
 * `pendingCode`/`pendingUrl` are the repo's own "never an otp row's code"
 * answer -- this function re-decides none of that.
 */
export interface MailInboxEntryLike {
  id: string;
  receivedAt: number;
  senderDomain: string;
  subject: string | null;
  kind: MailKind;
  consumedAt: number | null;
  expiresAt: number | null;
  rawSize: number;
  pendingCode: string | null;
  pendingUrl: string | null;
}

export function toMailInboxEntryDto(entry: MailInboxEntryLike): MailInboxEntryDto {
  return {
    id: entry.id,
    receivedAt: toIso(entry.receivedAt),
    fromDomain: entry.senderDomain,
    subject: entry.subject,
    kind: entry.kind,
    consumedAt: isoOrNull(entry.consumedAt),
    expiresAt: isoOrNull(entry.expiresAt),
    rawSize: entry.rawSize,
    pendingCode: entry.pendingCode,
    pendingUrl: entry.pendingUrl,
  };
}

/** The `mail_sender_allowlist` setting's stored CSV -> the SPA's array. */
export function toMailSettingsDto(allowlistCsv: string): MailSettingsDto {
  return { allowlist: parseAllowlistCsv(allowlistCsv) };
}

export function toAuditDto(entry: AuditEntryLike): McpAuditDto {
  return {
    id: entry.id,
    ts: toIso(entry.ts),
    // A grant that predates client registration has no client id; the DTO is a
    // string, so the unknown case is named rather than left empty.
    clientId: entry.clientId ?? "unknown",
    tool: entry.tool,
    healthSystemIds: entry.healthSystems,
    resultCount: entry.resultCount,
    ok: entry.ok,
    errorCode: entry.errorCode,
    durationMs: entry.durationMs ?? 0,
  };
}
