/**
 * What the Health Connect tools may read: the `hc` half of `ToolDeps`.
 *
 * The same reasoning as the rest of the seam (`../deps.ts`): the tools are
 * written against this interface and never against D1, so the list below is
 * the whole of what a Health Connect tool can reach, and every tool runs in a
 * plain-Node test over an in-memory implementation of it.
 *
 * Nothing here writes, and nothing here caps: every reader returns everything
 * in the window it is given. Windows are half-open `[startMs, endMs)` in epoch
 * milliseconds. The real implementation is `worker/src/hc/store/read.ts`
 * behind `worker/src/mcp/deps-d1.ts`.
 */

import type { IngestLogRow, SyncStateRow } from "../../hc/device.ts";
import type { BucketRollup, ExerciseSummary, HrMinute, SleepNight } from "../../hc/rollup/types.ts";
import type { HcRecord, HcSyncState } from "../../hc/wire.ts";

// The reader shapes are declared here, structurally, and not imported from
// `worker/src/hc/store/read.ts`: that module names D1, and this one is part of
// the seam the plain-Node unit tests compile. `deps-d1.ts` is where the two
// are checked against each other.

interface RecordWindow {
  deviceId: string;
  type: string;
  /** Inclusive, epoch ms. */
  startMs: number;
  /** Exclusive, epoch ms. */
  endMs: number;
  /** Package names. Omitted: every origin. */
  origins?: readonly string[] | undefined;
}

interface DayWindow {
  deviceId: string;
  type: string;
  /** Inclusive, `YYYY-MM-DD`. */
  startDay: string;
  /** Inclusive, `YYYY-MM-DD`. */
  endDay: string;
  origins?: readonly string[] | undefined;
}

interface HourRollupRow {
  /** Hours since the epoch. */
  hourUtc: number;
  origin: string;
  rollup: BucketRollup;
}

interface DayRollupRow {
  /** `YYYY-MM-DD` in the configured zone. */
  day: string;
  origin: string;
  rollup: BucketRollup;
}

interface HrMinuteRow {
  hourUtc: number;
  origin: string;
  minutes: HrMinute[];
}

interface StoredSleepNight {
  /** The session's blinded record id: stable, and names nothing. */
  id: string;
  night: SleepNight;
}

interface StoredExerciseSession {
  id: string;
  session: ExerciseSummary;
}

export interface StoreBacklog {
  /** Batches accepted and waiting to be applied. */
  queuedBatches: number;
  /**
   * Batches that could not be applied and are set aside. Their records are
   * not in the store, so a non-zero count means data is missing.
   */
  parkedBatches: number;
  /** Rollups and summaries marked for rebuilding and not yet rebuilt. */
  dirty: number;
  /**
   * True while day rollups built for another zone are still there: the
   * `timezone` setting changed and the runner has not been round yet.
   */
  rezonePending: boolean;
}

/** A paired phone, as the tools see it. Instants are unix seconds. */
export interface HcDevice {
  id: string;
  /** The name the owner gave it. What every coverage entry is tagged with. */
  name: string;
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
  lastUploadAt: number | null;
  appVersion: string | null;
}

/** A window with no record type: heart-rate minutes, nights, sessions. */
type DeviceWindow = Omit<RecordWindow, "type" | "origins">;

export interface HcReads {
  /** Every paired phone, revoked ones included, deny-list not yet applied. */
  devices(): Promise<HcDevice[]>;
  /** `hc_sync_state`: what the phone has reported per record type. */
  syncRows(deviceId: string): Promise<SyncStateRow[]>;
  /** The phone's own last report of its sync health, or null before the first. */
  phoneReport(deviceId: string): Promise<HcSyncState | null>;
  /** Uploads accepted and not yet applied, and rollups not yet rebuilt. */
  backlog(deviceId: string): Promise<StoreBacklog>;
  /** The newest `limit` batches, newest first. Counts and stable codes only. */
  ingestLog(deviceId: string, limit: number): Promise<IngestLogRow[]>;
  /** Package names of the apps that have written records of one type. */
  origins(deviceId: string, type: string): Promise<string[]>;
  /** Raw records with anything in the window, by start time. */
  records(window: RecordWindow): Promise<HcRecord[]>;
  /** Hour rollups whose UTC hour starts in the window. */
  hourRollups(window: RecordWindow): Promise<HourRollupRow[]>;
  /**
   * Day rollups, in the configured zone ONLY: a caller answering in another
   * zone must not use them.
   */
  dayRollups(window: DayWindow): Promise<DayRollupRow[]>;
  /** Per-minute heart rate: whole UTC-hour rows for every hour the window touches. */
  hrMinutes(window: Omit<RecordWindow, "type">): Promise<HrMinuteRow[]>;
  sleepNights(window: DeviceWindow): Promise<StoredSleepNight[]>;
  exerciseSessions(window: DeviceWindow): Promise<StoredExerciseSession[]>;
}

export { type SyncStateRow } from "../../hc/device.ts";
