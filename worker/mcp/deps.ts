/**
 * What the tools are allowed to touch.
 *
 * The tool layer is written against this interface and never against `Repos`,
 * `Env` or `fetch`. Two reasons, both about being able to prove things:
 *
 *  - The surface is the audit. Anything a tool can reach is listed here, so
 *    "could a tool write to D1?" or "could a tool read a token?" is answered by
 *    reading one file rather than by trusting twenty.
 *  - Every tool becomes unit-testable in plain Node. The policy tests, the output
 *    shape tests and the "the audit row carries no content" test all run against
 *    an in-memory implementation of this interface, with no workerd and no D1.
 *
 * `worker/mcp/deps-d1.ts` is the one real implementation.
 */

import type { ConnectionStatus, HealthSystemEnvironment } from "../db/rows.ts";
import type { SyncWarning } from "../db/schemas.ts";
import type { PortalVisit } from "../ehr/mychart/index.ts";
import type { Logger } from "../lib/log.ts";
import type { PolicyRules } from "../policy/rules.ts";

/** Resource type the decoded text of a clinical document is cached under. */
export const BINARY_TEXT_TYPE = "_binary_text";

/** How long a decoded document body stays in the cache. */
export const BINARY_TEXT_TTL_MS = 30 * 24 * 3600 * 1000;

/** A connected (or connectable) health system, as the MCP sees it. */
export interface HealthSystemInfo {
  id: string;
  /** What every item is tagged with. Never an id in the model-facing output. */
  displayName: string;
  environment: HealthSystemEnvironment;
  portalUrl: string | null;
  /** `health_systems.config_json.enabled`: sync on/off without disconnecting. */
  enabled: boolean;
  status: ConnectionStatus | "not_connected";
  /** Unix seconds, or null when it has never happened. */
  lastSyncAt: number | null;
  lastFullRefreshAt: number | null;
  lastErrorCode: string | null;
  needsReauthSince: number | null;
}

/** One row out of the FHIR read cache, with just the metadata a tool uses. */
export interface CachedRow {
  resource: unknown;
  /** The organisation's own `meta.lastUpdated`, in unix seconds, if it gave one. */
  lastUpdated: number | null;
  fetchedAt: number;
}

/**
 * One visit the patient portal reported, as the portal pass last stored it.
 *
 * `missing` is the calendar's ghost rule: a visit that stopped being returned
 * while it was still ahead. Treated as cancelled.
 */
export interface PortalVisitRecord {
  visit: PortalVisit;
  missing: boolean;
  /** Unix seconds the portal pass last saw it. A stale copy loses cross-health system ties. */
  fetchedAt: number;
}

/** Live row counts, for `get_health_summary` and the admin overview. */
export interface CacheCount {
  healthSystemId: string;
  resourceType: string;
  count: number;
}

/** Per-health system, per-resource-type freshness, for `get_sync_status`. */
export interface SyncStatusEntry {
  healthSystemId: string;
  resourceType: string;
  lastFullAt: number | null;
  lastOk: boolean;
  lastErrorCode: string | null;
  warnings: SyncWarning[];
}

export interface DocumentTextRequest {
  healthSystemId: string;
  /** The DocumentReference id, as `get_documents` reported it. */
  documentId: string;
}

/**
 * Why a document could not be turned into text.
 *
 * A discriminated result rather than a thrown error on purpose: the failures here
 * are ordinary answers ("that org's daily cap is spent", "that is a PDF"), and
 * routing them through exceptions would mean the tool layer had to re-derive a
 * stable code from an upstream message.
 */
export type DocumentTextFailure = "cap_reached" | "not_found" | "unsupported" | "upstream";

export type DocumentTextResult =
  | {
      ok: true;
      documentId: string;
      contentType: string | null;
      text: string;
      /** True when the text came from the cache rather than from the organisation. */
      cached: boolean;
    }
  | { ok: false; reason: DocumentTextFailure };

/** One `mcp_audit` row. Metadata only -- there is nowhere to put content. */
export interface AuditRecord {
  tool: string;
  clientId: string | null;
  grantId: string | null;
  healthSystemIds: string[];
  resultCount: number;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
}

/** Who is calling, taken from the OAuth grant. Null when the grant said nothing. */
export interface CallerIdentity {
  clientId: string | null;
  grantId: string | null;
}

export interface ToolDeps {
  readonly log: Logger;
  /** The OAuth client behind this session, for the audit row. */
  readonly caller: CallerIdentity;
  /**
   * Called once at the start of every tool call, before anything is read.
   *
   * The real implementation drops its per-call caches here. It matters because a
   * Durable Object session outlives a single call by design: without this, an
   * exposure rule the owner added, or `mcp_enabled` being switched off, would not
   * take effect until the client reconnected -- which is the opposite of what a
   * kill switch is for.
   */
  beginCall(): void;
  /** Unix seconds. Injected so tests need no clock of their own. */
  now(): number;
  /** `settings.mcp_enabled`. False means every tool answers `mcp_disabled`. */
  mcpEnabled(): Promise<boolean>;
  /** The exposure deny-list, parsed. Resolved at most once per tool call. */
  rules(): Promise<PolicyRules>;
  /** Every health system that has not been soft-deleted, deny-list not yet applied. */
  healthSystems(): Promise<HealthSystemInfo[]>;
  /** Cached resources of one type for one health system, most recently updated first. */
  resources(healthSystemId: string, resourceType: string): Promise<CachedRow[]>;
  /**
   * The Practitioner / Location / Organization / PractitionerRole / Medication
   * rows one health system's references resolve against, for `mapResolver`.
   */
  referencePool(healthSystemId: string): Promise<unknown[]>;
  /**
   * The upcoming visits the patient-portal pass last stored for one health system
   * (`portal_visits`), earliest first. Epic's FHIR view never returns a visit
   * before it happens, so this is where `get_appointments` finds them.
   */
  portalVisits(healthSystemId: string): Promise<PortalVisitRecord[]>;
  counts(): Promise<CacheCount[]>;
  syncStatus(): Promise<SyncStatusEntry[]>;
  /**
   * Decode one clinical document to text, fetching and caching the Binary if
   * needed. The only tool path that talks to an organisation at request time.
   */
  documentText(input: DocumentTextRequest): Promise<DocumentTextResult>;
  /** Write the audit row. Never throws into the tool's own result. */
  recordAudit(entry: AuditRecord): Promise<void>;
  /** Drop audit rows past the one-year retention window. Sampled, not per call. */
  pruneAudit(): Promise<void>;
}
