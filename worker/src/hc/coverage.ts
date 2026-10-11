/**
 * Health Connect coverage: a paired phone's record types, in the vocabulary of
 * the MCP `coverage[]` array.
 *
 * Pure: a device row and its `hc_sync_state` rows in, `CoverageEntry[]` out, so
 * the same function serves the Phone page and (a later wave) the MCP tools, and
 * the staleness boundary can be tested without a database.
 *
 * A phone is a source, not a health system, so its entries are keyed
 * `healthSystemId: "device:<id>"` and `resourceType: "hc:<Type>"`. That is what
 * lets the exposure policy's deny-list treat them exactly like FHIR pairs.
 *
 * Status, in the order the checks run:
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
  return now - device.lastUploadAt > HC_STALE_AFTER_SECONDS ? "stale" : "active";
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
  const { device, now } = input;
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
  if (uploadedAt === null) return { ...base, status: "never" };

  const lastOkAt = toIso(uploadedAt);
  const age = now - uploadedAt;
  if (device.revokedAt !== null || age > HC_STALE_AFTER_SECONDS) {
    return {
      ...base,
      status: "stale",
      ageHours: Math.floor(age / 3600),
      lastOkAt,
      recordCount: row.recordCount,
    };
  }
  return { ...base, status: "ok", lastOkAt, recordCount: row.recordCount };
}

/**
 * One entry per reported record type (plus any `expectedTypes` the phone has not
 * reported), sorted by type so the answer is stable.
 */
export function deviceCoverage(input: DeviceCoverageInput): CoverageEntry[] {
  const byType = new Map<string, CoverageSyncRow>();
  for (const row of input.rows) byType.set(row.recordType, row);
  const types = new Set([...byType.keys(), ...(input.expectedTypes ?? [])]);
  // Exercise-route permission is not a record type (older app builds reported it as one).
  types.delete(NOT_A_RECORD_TYPE);
  const sorted = [...types];
  sorted.sort((a, b) => a.localeCompare(b));
  return sorted.map((type) => entryFor(input, type, byType.get(type)));
}
