/**
 * What a paired phone looks like once its row is read.
 *
 * Types only, and deliberately not in the repo that produces them
 * (`worker/src/db/repos/devices.ts`): that module reaches `Env`, and with it
 * every Durable Object class, which the plain-Node unit project cannot load.
 * The API's DTO mapping is unit-tested there, so it takes its shapes from here.
 */

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  lastUploadAt: number | null;
  appVersion: string | null;
}

/** What the ingest route reads to authenticate a request. Nothing sealed is opened. */
export interface DeviceAuthRow {
  id: string;
  tokenHash: string;
  revokedAt: number | null;
}

export interface MintedDevice {
  device: Device;
  /** The bearer token. Returned once; only its digest is stored. */
  token: string;
}

// --- Bookkeeping rows the Phone page and the MCP status tools read ----------

export type PermissionState = "granted" | "denied" | "unavailable" | "unknown";

export interface SyncStateRow {
  recordType: string;
  permissionState: PermissionState;
  /** Epoch milliseconds of the earliest and latest stored record. */
  firstMs: number | null;
  lastMs: number | null;
  recordCount: number;
  /** Unix seconds. */
  lastUploadAt: number | null;
  tokenAgeS: number | null;
  backlog: number | null;
  backfillComplete: boolean;
  backfillOldestMs: number | null;
}

export interface DeviceTotals {
  recordCount: number;
  typesGranted: number;
  typesDenied: number;
  /** Granted types whose backfill has finished: a part of `typesGranted`. */
  typesBackfilled: number;
}

/** What became of one device's uploaded batches, as counts. Instants are Unix seconds. */
export interface IngestSummary {
  queued: number;
  applying: number;
  applied: number;
  failed: number;
  /** Batches applied since the instant the caller asked about. */
  appliedRecently: number;
  lastAppliedAt: number | null;
  /** Median apply time of the newest `applySample` applied batches, in ms. */
  applyMsMedian: number | null;
  applySample: number;
}

export interface IngestLogRow {
  /** Unix seconds. */
  receivedAt: number;
  appliedAt: number | null;
  status: "queued" | "applying" | "applied" | "failed";
  errorCode: string | null;
  upserts: number;
  deletes: number;
  rejected: number;
  applied: number;
  superseded: number;
  removed: number;
  bodyBytes: number;
  rawBytes: number;
  applyMs: number | null;
}
