/**
 * The real {@link ToolDeps}: D1, the FHIR read cache, and one door to the sync
 * engine for document bodies.
 *
 * Everything is memoised for the length of one tool call and dropped at the start
 * of the next (`beginCall`). That is what makes a twenty-four-row summary one
 * query per resource type rather than one per item, while still letting the owner
 * switch the MCP off and have it take effect on the very next call rather than
 * whenever the client happens to reconnect.
 *
 * Note what this file does NOT expose upward: no `Env`, no `Repos`, no `fetch`, no
 * token, and two write paths only: the audit row, and `sync`, through which
 * `sync_health_systems` asks the sync engine for a run (see `SyncControls` in
 * `deps.ts`, and `makeSyncControls` below for exactly what that reaches). The
 * `ToolDeps` interface is the whole of what a tool can do, and this is the only
 * place that decides what that means.
 */

import { blindHcRecordId, blinderFor } from "../db/blind.ts";
import { reposFor } from "../db/index.ts";
import { parseJsonColumn, healthSystemConfigSchema } from "../db/schemas.ts";
import { getSetting, getTimezone } from "../db/settings.ts";
import {
  listOrigins,
  readDayRollups,
  readExerciseSessions,
  readHourRollups,
  readHrMinutes,
  readRecords,
  readSleepNights,
  storeBacklog,
} from "../hc/store/read.ts";
import { parseBatch } from "../hc/wire.ts";
import { makeLogger } from "../lib/log.ts";
import { nowSeconds } from "../lib/time.ts";
import { buildRules } from "../policy/rules.ts";
import {
  STALE_RUN_SECONDS,
  calendarSyncBusy,
  fullRefreshBusy,
  portalSignInState,
  startCalendarSync,
  startFullRefresh,
} from "../sync/index.ts";

import { documentText } from "./binary.ts";
import { REFERENCE_TYPES } from "./collect.ts";

import type {
  AuditRecord,
  CacheCount,
  CachedRow,
  CallerIdentity,
  DocumentTextRequest,
  DocumentTextResult,
  MessageAttachmentFile,
  PortalMessageRecord,
  PortalMessageSyncEntry,
  PortalVisitRecord,
  HealthSystemInfo,
  SyncControls,
  SyncStatusEntry,
  ToolDeps,
} from "./deps.ts";
import type { HcReads } from "./hc/reads.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { StoredAttachment } from "../db/repos/portal-message-attachments.ts";
import type { ConnectionRow, HealthSystemRow, PortalAccountRow } from "../db/rows.ts";
import type { Env } from "../env.ts";
import type { HcSyncState } from "../hc/wire.ts";
import type { Logger } from "../lib/log.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type { PortalSignInState } from "@shared/types.ts";

/**
 * The sync engine's entry points `sync_health_systems` is allowed to reach.
 *
 * The live ones are `worker/src/sync/index.ts`'s own: the queue the admin UI's
 * full-refresh button uses, the calendar job beside it (which never signs in to
 * a portal), whether either is in flight, and the portal sign-in's progress.
 * An option rather than a direct call so an integration test can stand in for
 * the Durable Objects.
 */
export interface SyncEngine {
  startCalendarSync(
    ctx: Ctx,
    options: { healthSystemIds: readonly string[]; portalOnly: boolean },
  ): Promise<{ started: boolean }>;
  startFullRefresh(ctx: Ctx, options: { healthSystemId: string }): Promise<{ started: boolean }>;
  calendarSyncBusy(ctx: Ctx): Promise<boolean>;
  fullRefreshBusy(ctx: Ctx, options: { healthSystemId: string }): Promise<boolean>;
  portalSignInState(ctx: Ctx, options: { healthSystemId: string }): Promise<PortalSignInState>;
}

const LIVE_SYNC_ENGINE: SyncEngine = {
  startCalendarSync,
  startFullRefresh,
  calendarSyncBusy,
  fullRefreshBusy,
  portalSignInState,
};

export interface ToolDepsOptions {
  env: Env;
  /** Taken from the OAuth grant's props. Recorded on every audit row. */
  caller: CallerIdentity;
  log?: Logger;
  /** Unix seconds. Overridden by tests. */
  now?: () => number;
  /** The sync engine. Production omits it; see {@link SyncEngine}. */
  syncEngine?: SyncEngine;
}

/** Everything memoised for one tool call. Replaced wholesale by `beginCall`. */
interface CallCache {
  enabled: Promise<boolean> | null;
  rules: Promise<PolicyRules> | null;
  healthSystems: Promise<HealthSystemInfo[]> | null;
  counts: Promise<CacheCount[]> | null;
  syncStatus: Promise<SyncStatusEntry[]> | null;
  pools: Map<string, Promise<unknown[]>>;
  resources: Map<string, Promise<CachedRow[]>>;
  visits: Map<string, Promise<PortalVisitRecord[]>>;
  messages: Map<string, Promise<LoadedMessages>>;
  messageSync: Promise<PortalMessageSyncEntry[]> | null;
  timezone: Promise<string> | null;
  /** Health Connect reads, by reader name and arguments. */
  hc: Map<string, Promise<unknown>>;
}

/** One health system's messages, and its attachments' storage keys by public id. */
interface LoadedMessages {
  records: PortalMessageRecord[];
  keys: Map<string, string>;
}

function emptyCache(): CallCache {
  return {
    enabled: null,
    rules: null,
    healthSystems: null,
    counts: null,
    syncStatus: null,
    pools: new Map(),
    resources: new Map(),
    visits: new Map(),
    messages: new Map(),
    messageSync: null,
    timezone: null,
    hc: new Map(),
  };
}

function healthSystemInfo(
  row: HealthSystemRow,
  connection: ConnectionRow | undefined,
  portal: PortalAccountRow | undefined,
): HealthSystemInfo {
  const config = parseJsonColumn(
    healthSystemConfigSchema,
    row.config_json,
    `health_systems.config_json.${row.id}`,
  );
  return {
    id: row.id,
    displayName: row.display_name,
    environment: row.environment,
    portalUrl: row.portal_url,
    enabled: config.enabled,
    status: connection?.status ?? "not_connected",
    lastSyncAt: connection?.last_sync_at ?? null,
    lastFullRefreshAt: connection?.last_full_refresh_at ?? null,
    lastErrorCode: connection?.last_error_code ?? null,
    needsReauthSince: connection?.needs_reauth_since ?? null,
    portal:
      portal === undefined
        ? null
        : {
            state: portal.session_state,
            hasCredentials: portal.username_enc !== null && portal.password_enc !== null,
            lastOkAt: portal.last_ok_at,
            lastErrorCode: portal.last_error_code,
            needsReauthSince: portal.needs_reauth_since,
          },
  };
}

async function loadRules(repos: Repos): Promise<PolicyRules> {
  return buildRules(await repos.mcpPolicy.list());
}

/** One resource type for one health system, projected to what the tools read. */
async function loadRows(
  repos: Repos,
  healthSystemId: string,
  resourceType: string,
): Promise<CachedRow[]> {
  const rows = await repos.fhirCache.listByType(healthSystemId, resourceType);
  return rows.map((row) => ({
    resource: row.resource,
    lastUpdated: row.lastUpdated,
    fetchedAt: row.fetchedAt,
  }));
}

/** Everything one health system's references can resolve against, in one pool. */
async function loadReferencePool(repos: Repos, healthSystemId: string): Promise<unknown[]> {
  const groups = await Promise.all(
    REFERENCE_TYPES.map((resourceType) => repos.fhirCache.listByType(healthSystemId, resourceType)),
  );
  return groups.flat().map((row) => row.resource);
}

/** One health system's stored portal visits, projected to what the tools read. */
async function loadPortalVisits(
  repos: Repos,
  healthSystemId: string,
): Promise<PortalVisitRecord[]> {
  const rows = await repos.portalVisits.list(healthSystemId);
  return rows.map((row) => ({
    visit: row.visit,
    missing: row.state === "missing",
    fetchedAt: row.fetchedAt,
  }));
}

/** Where one attachment's file stands, from its row (or the lack of one). */
function fileOf(
  id: string,
  row: StoredAttachment | undefined,
  unread: boolean | undefined,
): MessageAttachmentFile {
  if (row === undefined) {
    return { id, status: unread === true ? "waiting_until_read" : "not_fetched" };
  }
  if (row.state === "failed") {
    return { id, status: "failed", ...(row.errorCode !== null && { errorCode: row.errorCode }) };
  }
  return {
    id,
    status: "stored",
    ...(row.meta.contentType !== undefined && { contentType: row.meta.contentType }),
    ...(row.meta.size !== undefined && { size: row.meta.size }),
  };
}

/** One health system's stored secure messages, projected to what the tools read. */
async function loadPortalMessages(repos: Repos, healthSystemId: string): Promise<LoadedMessages> {
  const [rows, files] = await Promise.all([
    repos.portalMessages.list(healthSystemId),
    repos.portalMessageAttachments.list(healthSystemId),
  ]);
  const byKey = new Map(files.map((file) => [file.attachmentKey, file]));
  const keys = new Map<string, string>();
  const records = rows.map((row) => {
    for (const ids of row.attachments) keys.set(ids.id, ids.key);
    return {
      threadId: row.threadId,
      messageId: row.messageId,
      fingerprint: row.fingerprint,
      thread: row.thread,
      message: row.message,
      files: row.attachments.map((ids) => fileOf(ids.id, byKey.get(ids.key), row.message.unread)),
      missing: row.missing,
    };
  });
  return { records, keys };
}

async function loadMessageSync(repos: Repos): Promise<PortalMessageSyncEntry[]> {
  const rows = await repos.portalMessages.listSync();
  return rows.map((row) => ({
    healthSystemId: row.healthSystemId,
    lastAttemptAt: row.lastAttemptAt,
    lastOkAt: row.lastOkAt,
    lastErrorCode: row.lastErrorCode,
    complete: row.complete,
  }));
}

async function loadHealthSystems(repos: Repos): Promise<HealthSystemInfo[]> {
  const [rows, connections, portals] = await Promise.all([
    repos.healthSystems.list(),
    repos.connections.list(),
    repos.portalAccounts.list(),
  ]);
  const byHealthSystem = new Map(connections.map((row) => [row.health_system_id, row]));
  const portalBy = new Map(portals.map((row) => [row.health_system_id, row]));
  return rows.map((row) => healthSystemInfo(row, byHealthSystem.get(row.id), portalBy.get(row.id)));
}

/**
 * The phone's last sync report, as the wire schema reads it.
 *
 * It was validated when it arrived, but it is read back through the same
 * schema rather than cast: a report stored by an older Worker must not reach a
 * tool in a shape the tool was not written against.
 */
function parsePhoneReport(json: string | null): HcSyncState | null {
  if (json === null) return null;
  let syncState: unknown;
  try {
    syncState = JSON.parse(json);
  } catch {
    return null;
  }
  const batch = parseBatch({
    v: 1,
    deviceId: "report",
    appVersion: "report",
    batchId: "report-0000",
    phoneTime: 0,
    syncState,
  });
  return batch?.syncState ?? null;
}

/**
 * The memoised readers that hand back stored data, by the name they are
 * memoised under: what `releaseReads` lets go of. One window of a long walk is
 * megabytes of opened rows; the bookkeeping readers are a few rows each and
 * stay.
 */
const STORED_DATA_READERS: ReadonlySet<string> = new Set([
  "records",
  "hourRollups",
  "dayRollups",
  "hrMinutes",
  "sleepNights",
  "exerciseSessions",
  "sessionRecordIds",
]);

/**
 * The Health Connect half of the seam: thin, memoised calls into the store's
 * readers. A summary tool asks for the same day rollups several times in one
 * call, and every rollup read opens a chunk per origin to learn its name.
 */
function makeHcReads(repos: Repos, cache: () => CallCache): HcReads {
  const { ctx } = repos;
  const once = <T>(name: string, key: unknown, load: () => Promise<T>): Promise<T> => {
    const id = `${name}:${JSON.stringify(key)}`;
    const calls = cache().hc;
    let pending = calls.get(id) as Promise<T> | undefined;
    if (pending === undefined) {
      pending = load();
      calls.set(id, pending);
    }
    return pending;
  };
  return {
    devices: () =>
      once("devices", null, async () => {
        const devices = await repos.devices.list();
        return devices.map((device) => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          revokedAt: device.revokedAt,
          lastSeenAt: device.lastSeenAt,
          lastUploadAt: device.lastUploadAt,
          appVersion: device.appVersion,
        }));
      }),
    syncRows: (deviceId) => once("syncRows", deviceId, () => repos.hcStatus.syncRows(deviceId)),
    phoneReport: (deviceId) =>
      once("phoneReport", deviceId, async () =>
        parsePhoneReport(await repos.devices.syncStateJson(deviceId)),
      ),
    backlog: (deviceId) => once("backlog", deviceId, () => storeBacklog(ctx, deviceId)),
    ingestLog: (deviceId, limit) =>
      once("ingestLog", [deviceId, limit], () => repos.hcStatus.ingestLog(deviceId, limit)),
    recentUploads: (deviceId, limit) =>
      once("recentUploads", [deviceId, limit], () => repos.hcStatus.recentRuns(deviceId, limit)),
    origins: (deviceId, type) =>
      once("origins", [deviceId, type], async () => {
        const refs = await listOrigins(ctx, deviceId, type);
        return refs.map((ref) => ref.origin);
      }),
    records: (window) => once("records", window, () => readRecords(ctx, window)),
    hourRollups: (window) => once("hourRollups", window, () => readHourRollups(ctx, window)),
    dayRollups: (window) => once("dayRollups", window, () => readDayRollups(ctx, window)),
    hrMinutes: (window) => once("hrMinutes", window, () => readHrMinutes(ctx, window)),
    sleepNights: (window) => once("sleepNights", window, () => readSleepNights(ctx, window)),
    exerciseSessions: (window) =>
      once("exerciseSessions", window, () => readExerciseSessions(ctx, window)),
    sessionRecordIds: (window) =>
      once("sessionRecordIds", window, async () => {
        // A summary is in a window when the session ends AT its start; a record
        // only when it ends after it. One millisecond earlier reads the same set.
        const records = await readRecords(ctx, { ...window, startMs: window.startMs - 1 });
        const blinder = blinderFor(ctx.env);
        const keyed = await Promise.all(
          records.map(
            async (record) =>
              [await blindHcRecordId(blinder, window.deviceId, record.id), record.id] as const,
          ),
        );
        return new Map(keyed);
      }),
    releaseReads: () => {
      const calls = cache().hc;
      for (const id of calls.keys()) {
        const reader = id.slice(0, id.indexOf(":"));
        if (STORED_DATA_READERS.has(reader)) calls.delete(id);
      }
    },
  };
}

/**
 * How long a portal sign-in's phase is believed. The runner's own figure for an
 * abandoned job (`portal-runner.ts`): a phase older than this was left behind
 * by a job that no longer exists.
 */
const SIGN_IN_PHASE_STALE_SECONDS = 15 * 60;

/** The phases in which a sign-in is actually under way. */
const SIGN_IN_ACTIVE_PHASES: ReadonlySet<string> = new Set([
  "logging_in",
  "awaiting_code",
  "validating",
]);

/**
 * The real {@link SyncControls}.
 *
 * Reads: the backoff setting, open `run_log` rows, the two runners' "is a job
 * stored" answers, the sign-in phase and `mcp_sync_requests`. Writes: one
 * `mcp_sync_requests` row per claim, and a job on a runner. Nothing here
 * decides anything; `worker/src/mcp/sync-request.ts` does.
 */
function makeSyncControls(repos: Repos, engine: SyncEngine, caller: CallerIdentity): SyncControls {
  const { ctx } = repos;
  return {
    async backoffUntil(): Promise<number | null> {
      const until = await getSetting(ctx, "sync_backoff_until");
      return until !== null && until > ctx.now() ? until : null;
    },

    async runInFlight(): Promise<boolean> {
      const open = await repos.runLog.countOpen(ctx.now() - STALE_RUN_SECONDS);
      return open > 0 || (await engine.calendarSyncBusy(ctx));
    },

    fullRefreshInFlight(healthSystemId: string): Promise<boolean> {
      return engine.fullRefreshBusy(ctx, { healthSystemId });
    },

    async portalSignInInFlight(healthSystemId: string): Promise<boolean> {
      const state = await engine.portalSignInState(ctx, { healthSystemId });
      return (
        SIGN_IN_ACTIVE_PHASES.has(state.phase) &&
        state.updatedAt !== null &&
        ctx.now() - state.updatedAt < SIGN_IN_PHASE_STALE_SECONDS
      );
    },

    history: (kind) => repos.mcpSyncRequests.list(kind),

    claim: (healthSystemId, kind, limits) =>
      repos.mcpSyncRequests.claim(healthSystemId, kind, limits, caller.clientId),

    startCalendarSync: (healthSystemIds, startOptions) =>
      engine.startCalendarSync(ctx, { healthSystemIds, portalOnly: startOptions.portalOnly }),

    startFullRefresh: (healthSystemId) => engine.startFullRefresh(ctx, { healthSystemId }),
  };
}

export function makeToolDeps(options: ToolDepsOptions): ToolDeps {
  const log = options.log ?? makeLogger({ src: "mcp" });
  const now = options.now ?? ((): number => nowSeconds());
  const repos = reposFor(options.env.DB, options.env, { log, now });
  const sync = makeSyncControls(repos, options.syncEngine ?? LIVE_SYNC_ENGINE, options.caller);
  let cache = emptyCache();

  const loadedMessages = (healthSystemId: string): Promise<LoadedMessages> => {
    let pending = cache.messages.get(healthSystemId);
    if (pending === undefined) {
      pending = loadPortalMessages(repos, healthSystemId);
      cache.messages.set(healthSystemId, pending);
    }
    return pending;
  };

  const hc = makeHcReads(repos, () => cache);

  return {
    log,
    caller: options.caller,
    hc,
    sync,

    timezone(): Promise<string> {
      cache.timezone ??= getTimezone(repos.ctx);
      return cache.timezone;
    },

    beginCall(): void {
      cache = emptyCache();
    },

    now,

    mcpEnabled(): Promise<boolean> {
      cache.enabled ??= getSetting(repos.ctx, "mcp_enabled");
      return cache.enabled;
    },

    rules(): Promise<PolicyRules> {
      cache.rules ??= loadRules(repos);
      return cache.rules;
    },

    healthSystems(): Promise<HealthSystemInfo[]> {
      cache.healthSystems ??= loadHealthSystems(repos);
      return cache.healthSystems;
    },

    resources(healthSystemId: string, resourceType: string): Promise<CachedRow[]> {
      const key = `${healthSystemId}:${resourceType}`;
      let pending = cache.resources.get(key);
      if (pending === undefined) {
        pending = loadRows(repos, healthSystemId, resourceType);
        cache.resources.set(key, pending);
      }
      return pending;
    },

    referencePool(healthSystemId: string): Promise<unknown[]> {
      let pending = cache.pools.get(healthSystemId);
      if (pending === undefined) {
        pending = loadReferencePool(repos, healthSystemId);
        cache.pools.set(healthSystemId, pending);
      }
      return pending;
    },

    portalVisits(healthSystemId: string): Promise<PortalVisitRecord[]> {
      let pending = cache.visits.get(healthSystemId);
      if (pending === undefined) {
        pending = loadPortalVisits(repos, healthSystemId);
        cache.visits.set(healthSystemId, pending);
      }
      return pending;
    },

    async portalMessages(healthSystemId: string): Promise<PortalMessageRecord[]> {
      const loaded = await loadedMessages(healthSystemId);
      return loaded.records;
    },

    async portalAttachmentContent(
      healthSystemId: string,
      attachmentId: string,
    ): Promise<Uint8Array | null> {
      const loaded = await loadedMessages(healthSystemId);
      const key = loaded.keys.get(attachmentId);
      return key === undefined ? null : repos.portalMessageAttachments.content(healthSystemId, key);
    },

    portalMessageSync(): Promise<PortalMessageSyncEntry[]> {
      cache.messageSync ??= loadMessageSync(repos);
      return cache.messageSync;
    },

    counts(): Promise<CacheCount[]> {
      cache.counts ??= repos.fhirCache.countsByType();
      return cache.counts;
    },

    syncStatus(): Promise<SyncStatusEntry[]> {
      cache.syncStatus ??= repos.fhirSyncState.list();
      return cache.syncStatus;
    },

    documentText(input: DocumentTextRequest): Promise<DocumentTextResult> {
      return documentText({ repos, log }, input.healthSystemId, input.documentId);
    },

    async recordAudit(entry: AuditRecord): Promise<void> {
      await repos.mcpAudit.insert({
        tool: entry.tool,
        clientId: entry.clientId,
        grantId: entry.grantId,
        healthSystems: entry.healthSystemIds,
        resultCount: entry.resultCount,
        ok: entry.ok,
        errorCode: entry.errorCode,
        durationMs: entry.durationMs,
        jq: entry.jq,
      });
    },

    async pruneAudit(): Promise<void> {
      await repos.mcpAudit.prune();
    },
  };
}
