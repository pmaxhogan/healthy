/**
 * `hc_coverage` and `hc_sync_status`: what the paired phone has sent, and how
 * the pipeline that brings it here is doing.
 *
 * They are to phone data what `list_health_systems` and `get_sync_status` are
 * to the FHIR cache, and they go through `respond()` for the same reason: a
 * denied phone that still appears in a status listing has been announced, and
 * a denied record type whose row still says how many records there are has
 * leaked the shape of what the rule hides. So both list only the phones the
 * call may read (`beginHcCall`) and only the types coverage has an entry for,
 * which is the allowed ones; a count that sums over types sums over those.
 *
 * Neither reads a single measurement except `hc_coverage`'s `lastRecordFrom`,
 * which opens the one hour each type's newest record sits in to say which app
 * and which hardware wrote it.
 */

import { z } from "zod";

import { ageHours, deviceStatus } from "../../hc/coverage.ts";
import { recordStartMs } from "../../hc/wire.ts";
import { AVAILABILITY_NOTE, BUDGET_NOTE, hcArgs } from "../hc/args.ts";
import { openStampedPage } from "../hc/page.ts";
import { policyResourceType } from "../hc/policy.ts";
import {
  availabilityByType,
  beginHcCall,
  coverageResourceType,
  deviceCoverageFor,
  deviceSourceId,
  hcRespond,
  storeState,
} from "../hc/sources.ts";
import { SECOND_MS } from "../hc/time.ts";
import { sortedText } from "../hc/util.ts";
import { toolError } from "../respond.ts";

import { readTool } from "./register.ts";

import type { CoverageEntry } from "../coverage.ts";
import type { ToolDeps } from "../deps.ts";
import type { HcDevice, SyncStateRow } from "../hc/reads.ts";
import type { Availability, HcCall } from "../hc/sources.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** How many of the newest uploads `hc_sync_status` looks through for failures. */
const DEFAULT_RECENT_BATCHES = 50;

/**
 * The one store warning this tool repeats. Queued and pending work is what its
 * rows are for; parked uploads are data that is missing, which deserves saying twice.
 */
const PARKED_WARNING = "hc_batches_parked:";

const TYPE_NAME = z.string().min(1);

const TYPES_ARG = z
  .array(TYPE_NAME)
  .max(200)
  .optional()
  .describe(
    "Record types to report (`HeartRate`, `Steps`, `SleepSession`, ...). A named " +
      "type with no stored records comes back as `no_data`. Omit for every type " +
      "there are records of.",
  );

const ORIGINS_ARG = z
  .boolean()
  .optional()
  .describe(
    "False leaves out `origins` and `lastRecordFrom`, the only part of this tool " +
      "that opens stored records. Default true.",
  );

const RECENT_BATCHES_ARG = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    `How many of the newest uploads to look through for failures (default ${String(DEFAULT_RECENT_BATCHES)}). ` +
      "No maximum.",
  );

const COVERAGE_SCHEMA = hcArgs("hc_coverage", { types: TYPES_ARG, origins: ORIGINS_ARG });
const SYNC_SCHEMA = hcArgs("hc_sync_status", { recent_batches: RECENT_BATCHES_ARG });

/**
 * A unix-second bookkeeping instant in the answer's zone, like every other
 * time these tools return; null when it never happened.
 */
function at(call: HcCall, seconds: number | null): string | null {
  return seconds === null ? null : call.clock.iso(seconds * SECOND_MS);
}

/** Which app and hardware wrote a type's newest record. Null when there is none to open. */
async function lastRecordFrom(
  deps: ToolDeps,
  device: HcDevice,
  row: SyncStateRow,
): Promise<Record<string, unknown> | null> {
  if (row.lastMs === null) return null;
  const records = await deps.hc.records({
    deviceId: device.id,
    type: row.recordType,
    startMs: row.lastMs,
    endMs: row.lastMs + 1,
  });
  let newest = records.at(-1);
  for (const record of records) {
    if (newest === undefined || recordStartMs(record) >= recordStartMs(newest)) newest = record;
  }
  if (newest === undefined) return null;
  return {
    origin: newest.origin,
    ...(newest.device !== undefined && { device: newest.device }),
    ...(newest.recordingMethod !== undefined && { recordingMethod: newest.recordingMethod }),
  };
}

/** Mean time between records, in seconds: the type's typical cadence. Null for fewer than two. */
function meanIntervalS(row: SyncStateRow | undefined): number | null {
  const firstMs = row?.firstMs ?? null;
  const lastMs = row?.lastMs ?? null;
  const count = row?.recordCount ?? 0;
  return firstMs === null || lastMs === null || count < 2
    ? null
    : Math.round((lastMs - firstMs) / (count - 1) / SECOND_MS);
}

/** What one phone's coverage rows are built from. */
interface DeviceView {
  device: HcDevice;
  /** `hc:<Type>` -> the coverage entry, for the types this call may see. */
  entries: Map<string, CoverageEntry>;
  availability: Map<string, Availability>;
  rows: Map<string, SyncStateRow>;
}

async function deviceView(
  deps: ToolDeps,
  device: HcDevice,
  coverage: readonly CoverageEntry[],
): Promise<DeviceView> {
  const source = deviceSourceId(device.id);
  const rows = await deps.hc.syncRows(device.id);
  return {
    device,
    entries: new Map(
      coverage
        .filter((entry) => entry.healthSystemId === source)
        .map((entry) => [entry.resourceType, entry]),
    ),
    availability: availabilityByType(coverage, device.id),
    rows: new Map(rows.map((row) => [row.recordType, row])),
  };
}

/** The app names and newest record's source of one type: the part that opens stored records. */
async function originFields(
  deps: ToolDeps,
  device: HcDevice,
  row: SyncStateRow | undefined,
): Promise<Record<string, unknown>> {
  if (row === undefined || row.recordCount === 0) return { origins: [], lastRecordFrom: null };
  return {
    origins: await deps.hc.origins(device.id, row.recordType),
    lastRecordFrom: await lastRecordFrom(deps, device, row),
  };
}

async function coverageItem(
  deps: ToolDeps,
  call: HcCall,
  view: DeviceView,
  type: string,
  withOrigins: boolean,
): Promise<Record<string, unknown> | null> {
  const entry = view.entries.get(coverageResourceType(type));
  // No entry: there are no records of it and it was not named, the policy
  // denies it, or the caller did not ask for it.
  if (entry === undefined) return null;
  const { device } = view;
  const row = view.rows.get(type);
  return {
    kind: "type_coverage",
    healthSystem: device.name,
    healthSystemId: deviceSourceId(device.id),
    resourceType: policyResourceType(type),
    type,
    availability: view.availability.get(entry.resourceType) ?? "no_data",
    status: entry.status,
    recordCount: row?.recordCount ?? 0,
    firstAt: call.clock.isoOrNull(row?.firstMs),
    lastAt: call.clock.isoOrNull(row?.lastMs),
    meanIntervalS: meanIntervalS(row),
    lastSyncAt: at(call, device.lastUploadAt ?? row?.lastUploadAt ?? null),
    staleHours: entry.ageHours ?? null,
    ...(withOrigins && (await originFields(deps, device, row))),
  };
}

async function coverageItems(
  deps: ToolDeps,
  call: HcCall,
  coverage: readonly CoverageEntry[],
  options: { types: readonly string[] | undefined; origins: boolean },
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (const device of call.devices) {
    const view = await deviceView(deps, device, coverage);
    const types = sortedText(new Set([...view.rows.keys(), ...(options.types ?? [])]));
    for (const type of types) {
      const item = await coverageItem(deps, call, view, type, options.origins);
      if (item !== null) items.push(item);
    }
  }
  return items;
}

async function deviceItem(
  deps: ToolDeps,
  call: HcCall,
  view: DeviceView,
  recentBatches: number,
): Promise<Record<string, unknown>> {
  const { device } = view;
  const [report, backlog, log] = await Promise.all([
    deps.hc.phoneReport(device.id),
    deps.hc.backlog(device.id),
    deps.hc.ingestLog(device.id, recentBatches),
  ]);
  // Only the types this call lists are counted: the ones with stored records
  // that the policy lets it see. A total over all of them would say how much a
  // denied type holds.
  const visible: SyncStateRow[] = [];
  for (const [type, row] of view.rows) {
    if (view.entries.has(coverageResourceType(type))) visible.push(row);
  }
  const lastError = report?.lastError ?? null;
  return {
    kind: "device",
    healthSystem: device.name,
    healthSystemId: deviceSourceId(device.id),
    status: deviceStatus(device, call.now),
    pairedAt: at(call, device.createdAt),
    revokedAt: at(call, device.revokedAt),
    lastSeenAt: at(call, device.lastSeenAt),
    lastUploadAt: at(call, device.lastUploadAt),
    hoursSinceUpload: device.lastUploadAt === null ? null : ageHours(call.now, device.lastUploadAt),
    appVersion: device.appVersion,
    // What the phone last said about itself; null until it has said anything.
    backgroundRead: report?.backgroundRead ?? null,
    historyRead: report?.historyRead ?? null,
    batteryOptimisationExempt: report?.batteryExempt ?? null,
    backfillComplete: report?.backfillComplete ?? null,
    androidSdk: report?.androidSdk ?? null,
    healthConnectVersion: report?.hcProviderVersion ?? null,
    lastPhoneError:
      lastError === null
        ? null
        : { errorCode: lastError.errorCode, at: call.clock.iso(lastError.at) },
    typesWithData: visible.length,
    records: visible.reduce((sum, row) => sum + row.recordCount, 0),
    // Records the phone still has to upload, by its own count.
    phoneBacklog: visible.reduce((sum, row) => sum + (row.backlog ?? 0), 0),
    // Uploads accepted here and not yet applied, and rollups not yet rebuilt.
    queuedBatches: backlog.queuedBatches,
    // Uploads that could not be applied and are set aside: their records are missing.
    parkedBatches: backlog.parkedBatches,
    rollupsPending: backlog.dirty,
    recentBatches: log.length,
    recentFailures: log
      .filter((entry) => entry.status === "failed")
      .map((entry) => ({ receivedAt: at(call, entry.receivedAt), errorCode: entry.errorCode })),
  };
}

function typeSyncItems(call: HcCall, view: DeviceView): Record<string, unknown>[] {
  const { device } = view;
  const items: Record<string, unknown>[] = [];
  for (const [type, row] of view.rows) {
    const availability = view.availability.get(coverageResourceType(type));
    if (availability === undefined) continue;
    items.push({
      kind: "type_sync",
      healthSystem: device.name,
      healthSystemId: deviceSourceId(device.id),
      resourceType: policyResourceType(type),
      type,
      availability,
      recordCount: row.recordCount,
      tokenAgeS: row.tokenAgeS,
      backlog: row.backlog,
      backfillComplete: row.backfillComplete,
      backfillOldestAt: call.clock.isoOrNull(row.backfillOldestMs),
      lastUploadAt: at(call, row.lastUploadAt),
    });
  }
  return items;
}

export function registerHcStatusTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "hc_coverage",
      description:
        "What the paired phone's Health Connect holds, one row per record type per phone: " +
        "`availability` (`ok`; `stale` = there are records but the phone has not uploaded " +
        "for six hours), `recordCount`, `firstAt` " +
        "and `lastAt` (the oldest and newest record), `meanIntervalS` (typical cadence), " +
        "`origins` (the apps that wrote it, by package name), `lastRecordFrom` (the app and " +
        "hardware behind the newest record), `lastSyncAt` and `staleHours`. Only record " +
        "types with at least one stored record are listed: a type that is not here has no " +
        "data, and appears by itself once it has some. A type named in `types` is always " +
        "answered, as `no_data` when there is nothing of it. Call it first: " +
        "it says which of the other Health Connect tools have anything to answer with, and " +
        "the `type` names they take. Health Connect's own hourly totals (`Agg.<Metric>`, " +
        "which `hc_aggregate` uses) are listed only when named in `types`. Phone data is " +
        "separate from the health " +
        `systems' records; \`get_vitals\` does not include it. ${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: COVERAGE_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "hc_coverage", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const coverage = await deviceCoverageFor(deps, call, { named: args.types });
      const items = await coverageItems(deps, call, coverage, {
        types: args.types,
        origins: args.origins ?? true,
      });
      return hcRespond({
        tool: "hc_coverage",
        call,
        args,
        page,
        items,
        coverage,
        named: args.types,
        extra: { units: { meanIntervalS: "s", staleHours: "h" } },
      });
    },
  );

  readTool(
    server,
    deps,
    {
      name: "hc_sync_status",
      description:
        "How the phone-to-server pipeline is doing. One `kind: device` row per paired " +
        "phone: `status` (`active`, `stale` after six hours without an upload, `revoked`, " +
        "`never`), `lastUploadAt`, `lastSeenAt`, `hoursSinceUpload`, `appVersion`, " +
        "`backgroundRead`, `historyRead`, `batteryOptimisationExempt`, `backfillComplete`, " +
        "`lastPhoneError`, `phoneBacklog` (records the phone still has to send), " +
        "`queuedBatches` and `rollupsPending` (work this server still has to do: non-zero " +
        "means the newest upload may not be in every answer yet), `parkedBatches` (uploads " +
        "that could not be applied and are set aside: their records are missing until they " +
        "are queued again, and the answer warns `hc_batches_parked:...`), and `recentFailures` " +
        "among the last `recent_batches` uploads. Then one `kind: type_sync` row per record " +
        "type that has stored records: `availability`, `tokenAgeS` (age of the phone's " +
        "change token), `backlog`, `backfillComplete`, `backfillOldestAt`, `recordCount`. " +
        "`typesWithData` on the `device` row counts those rows. The queue, " +
        "rollup and upload figures on the `device` row are bookkeeping for the whole phone, " +
        "not per record type; `records`, `phoneBacklog` and the type counts cover only the " +
        "types the owner's policy lets this call see, and a type it withholds has no row. " +
        `${AVAILABILITY_NOTE} ${BUDGET_NOTE}`,
      schema: SYNC_SCHEMA,
    },
    async (args, run) => {
      const call = await beginHcCall(deps, run, args);
      const opened = await openStampedPage(deps.hc, call.devices, "hc_sync_status", args);
      if (!opened.ok) return toolError(opened.errorCode);
      const { page } = opened;
      const coverage = await deviceCoverageFor(deps, call);
      const recent = args.recent_batches ?? DEFAULT_RECENT_BATCHES;
      const deviceRows: Record<string, unknown>[] = [];
      const typeRows: Record<string, unknown>[] = [];
      const warnings: string[] = [];
      for (const device of call.devices) {
        const view = await deviceView(deps, device, coverage);
        deviceRows.push(await deviceItem(deps, call, view, recent));
        const store = await storeState(deps, device);
        warnings.push(...store.warnings.filter((warning) => warning.startsWith(PARKED_WARNING)));
        typeRows.push(...typeSyncItems(call, view));
      }
      return hcRespond({
        tool: "hc_sync_status",
        call,
        args,
        page,
        items: [...deviceRows, ...typeRows],
        coverage,
        warnings,
        extra: { units: { tokenAgeS: "s", hoursSinceUpload: "h" } },
      });
    },
  );
}
