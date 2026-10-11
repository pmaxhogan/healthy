/**
 * Health Connect coverage: a paired phone's record types, in the vocabulary of
 * the MCP `coverage[]` array.
 *
 * Pure: a device row and its `hc_sync_state` rows in, `CoverageEntry[]` out, so
 * the staleness boundary can be tested without a database.
 *
 * A phone is a source, not a health system, so its entries are keyed
 * `healthSystemId: "device:<id>"` and `resourceType: "hc:<Type>"`. That is what
 * lets the exposure policy's deny-list treat them exactly like FHIR pairs.
 *
 * There are TWO mappings here, for two readers who need different things:
 *
 *  - {@link adminDeviceCoverage}, for the owner's Phone page. The owner manages
 *    what the companion app may read there, so it tells the whole truth about
 *    every type the phone has reported, the state of its permission included.
 *  - {@link mcpDeviceCoverage}, for everything an MCP client sees. A client is
 *    told about data, not about permissions: a type is there when the store
 *    holds a record of it and absent when it holds none, whatever the phone
 *    said about being allowed to read it. See that function.
 *
 * Admin status, in the order the checks run:
 *
 *   1. `unsupported` -- the phone says the type is not permitted (the owner
 *      refused it) or not available (the installed Health Connect lacks it). The
 *      notice says which. Not a failure of anything.
 *   2. `never`       -- the phone has not reported the type (no row, or a row
 *      whose permission is still `unknown`), or has never uploaded at all.
 *   3. `stale`       -- the device is revoked, or its last upload is older than
 *      {@link HC_STALE_AFTER_SECONDS}.
 *   4. `ok`          -- everything else, including a granted type with no
 *      records: that is "permitted, no data", and `recordCount: 0` says so.
 */

import { toIso } from "../lib/time.ts";

import type { CoverageEntry } from "../mcp/coverage.ts";
import type { ExplainedSyncWarning } from "../sync/sync-state-codes.ts";

/**
 * How long a device may go without uploading before it is `stale`. The phone
 * syncs every 15 minutes, so six hours is many missed cycles: a phone that is
 * off, out of reach of a network, or has lost its permission to run in the
 * background. Exactly this long is still fresh; one second more is stale.
 */
export const HC_STALE_AFTER_SECONDS = 6 * 60 * 60;

/** The `coverage[].healthSystemId` of a device. */
export function deviceSourceId(deviceId: string): string {
  return `device:${deviceId}`;
}

/** The `coverage[].resourceType` of a Health Connect record type. */
export function coverageResourceType(recordType: string): string {
  return `hc:${recordType}`;
}

/** The pseudo-type older app builds used for exercise-route permission. Never a coverage row. */
const NOT_A_RECORD_TYPE = "ExerciseRoute";

export type DeviceStatus = "active" | "stale" | "revoked" | "never";

/** What `deviceStatus` reads of a device row. Unix seconds. */
export interface DeviceTimes {
  revokedAt: number | null;
  lastUploadAt: number | null;
}

export function deviceStatus(device: DeviceTimes, now: number): DeviceStatus {
  if (device.revokedAt !== null) return "revoked";
  if (device.lastUploadAt === null) return "never";
  return ageSeconds(now, device.lastUploadAt) > HC_STALE_AFTER_SECONDS ? "stale" : "active";
}

/** One `hc_sync_state` row, as far as coverage reads it. */
export interface CoverageSyncRow {
  recordType: string;
  permissionState: "granted" | "denied" | "unavailable" | "unknown";
  recordCount: number;
  lastUploadAt: number | null;
}

export interface DeviceCoverageInput {
  device: DeviceTimes & { id: string; name: string };
  rows: readonly CoverageSyncRow[];
  /** Unix seconds. */
  now: number;
  /**
   * Record types to report even when the phone has sent no row for them, as
   * `never`. Rows for other types are reported too.
   */
  expectedTypes?: readonly string[];
}

/**
 * Seconds since `instant`, never negative. The two clocks are not ordered: an
 * upload can be stamped a moment after the instant an answer calls "now", and
 * an age of minus one hour is not something to hand anybody.
 */
function ageSeconds(now: number, instant: number): number {
  return Math.max(0, now - instant);
}

/** Whole hours since `instant`, never negative. */
export function ageHours(now: number, instant: number): number {
  return Math.floor(ageSeconds(now, instant) / 3600);
}

const NOT_PERMITTED: ExplainedSyncWarning = {
  code: "permission_denied",
  count: 1,
  meaning:
    "Reading this record type is not permitted: it has not been granted to the companion app on the phone.",
  severity: "warning",
};

const NOT_AVAILABLE: ExplainedSyncWarning = {
  code: "permission_unavailable",
  count: 1,
  meaning:
    "This record type is not available on this phone: the installed Health Connect does not offer it.",
  severity: "info",
};

function entryFor(
  input: DeviceCoverageInput,
  recordType: string,
  row: CoverageSyncRow | undefined,
): CoverageEntry {
  const { device } = input;
  const base = {
    healthSystemId: deviceSourceId(device.id),
    healthSystem: device.name,
    resourceType: coverageResourceType(recordType),
  };

  if (row?.permissionState === "denied") {
    return { ...base, status: "unsupported", notices: [NOT_PERMITTED] };
  }
  if (row?.permissionState === "unavailable") {
    return { ...base, status: "unsupported", notices: [NOT_AVAILABLE] };
  }

  if (row === undefined || row.permissionState === "unknown") return { ...base, status: "never" };
  const uploadedAt = device.lastUploadAt ?? row.lastUploadAt;

  // A revoked phone is stale whether or not it ever uploaded: nothing more will come.
  if (uploadedAt === null && device.revokedAt !== null) {
    return { ...base, status: "stale", recordCount: row.recordCount };
  }
  return uploadedAt === null
    ? { ...base, status: "never" }
    : freshness(input, base, uploadedAt, row.recordCount);
}

/** `ok` or `stale` for a type whose phone last uploaded at `uploadedAt`. */
function freshness(
  input: DeviceCoverageInput,
  base: Pick<CoverageEntry, "healthSystemId" | "healthSystem" | "resourceType">,
  uploadedAt: number,
  recordCount: number,
): CoverageEntry {
  const { device, now } = input;
  const lastOkAt = toIso(uploadedAt);
  if (device.revokedAt !== null || ageSeconds(now, uploadedAt) > HC_STALE_AFTER_SECONDS) {
    return {
      ...base,
      status: "stale",
      ageHours: ageHours(now, uploadedAt),
      lastOkAt,
      recordCount,
    };
  }
  return { ...base, status: "ok", lastOkAt, recordCount };
}

/** The types of an input, sorted so the answer is stable, without the one that is not a type. */
function sortedTypes(types: Iterable<string>): string[] {
  const sorted = [...new Set(types)].filter((type) => type !== NOT_A_RECORD_TYPE);
  sorted.sort((a, b) => a.localeCompare(b));
  return sorted;
}

/**
 * The Phone page's coverage: one entry per reported record type (plus any
 * `expectedTypes` the phone has not reported), permission states and all.
 * Never shown to an MCP client; see {@link mcpDeviceCoverage}.
 */
export function adminDeviceCoverage(input: DeviceCoverageInput): CoverageEntry[] {
  const byType = new Map<string, CoverageSyncRow>();
  for (const row of input.rows) byType.set(row.recordType, row);
  const types = sortedTypes([...byType.keys(), ...(input.expectedTypes ?? [])]);
  return types.map((type) => entryFor(input, type, byType.get(type)));
}

export interface McpCoverageInput {
  device: DeviceTimes & { id: string; name: string };
  rows: readonly CoverageSyncRow[];
  /** Unix seconds. */
  now: number;
  /**
   * Record types the caller asked for by name. Each is reported even when the
   * store holds nothing of it, as an empty `ok` entry (`recordCount: 0`).
   */
  namedTypes?: readonly string[];
}

/**
 * What an MCP client is told a phone holds: one entry per record type the
 * store has at least one record of, and nothing else.
 *
 * The rule is about stored records and nothing but. A type with none is
 * simply not there -- it makes no difference whether the phone was allowed to
 * read it, refused, cannot offer it, or never mentioned it: the owner does not
 * have that data, by design as often as not, and a client told "not
 * permitted" goes on to tell the owner to grant something that does not
 * exist. The first record stored makes the type appear, with no list to
 * update: this reads `recordCount`, which the store recounts from its chunks.
 *
 * A type that HAS records reads as its data, `ok` or `stale` by when the phone
 * last uploaded. That stays true after its permission is taken away: the
 * records are still here, and once uploads stop arriving the phone goes
 * stale like any other that has stopped.
 *
 * A type the caller named gets an entry either way, so a question about it is
 * answered rather than ignored: `ok` with `recordCount: 0`, the same for every
 * reason there might be nothing.
 */
export function mcpDeviceCoverage(input: McpCoverageInput): CoverageEntry[] {
  const { device, now } = input;
  const byType = new Map<string, CoverageSyncRow>();
  for (const row of input.rows) {
    if (row.recordCount > 0) byType.set(row.recordType, row);
  }
  const out: CoverageEntry[] = [];
  const types = sortedTypes([...byType.keys(), ...(input.namedTypes ?? [])]);
  for (const type of types) {
    const base = {
      healthSystemId: deviceSourceId(device.id),
      healthSystem: device.name,
      resourceType: coverageResourceType(type),
    };
    const row = byType.get(type);
    const uploadedAt = device.lastUploadAt ?? row?.lastUploadAt ?? null;
    if (row === undefined) {
      out.push({ ...base, status: "ok", recordCount: 0 });
    } else if (uploadedAt === null) {
      // Records with no upload on file: say what is held, and that nothing is current.
      out.push({ ...base, status: "stale", recordCount: row.recordCount });
    } else {
      out.push(freshness({ device, rows: input.rows, now }, base, uploadedAt, row.recordCount));
    }
  }
  return out;
}
