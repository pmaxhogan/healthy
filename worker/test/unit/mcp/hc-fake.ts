// An in-memory Health Connect store for the tool tests.
//
// The tools are written against `HcReads`, so the store can be faked without
// D1: a list of records per phone, with every pre-aggregate computed from them
// on demand by the SAME pure functions the real store builds its rollups with
// (`worker/src/hc/rollup/**`). What a tool reads here is therefore what the
// real readers would hand it for the same records.
//
// Every reader call is logged in `calls`, so a test can assert not only what a
// tool answered but what it opened to answer it -- "a day by hour reads no raw
// chunk" is a property worth pinning.
//
// Everything is synthetic, per CLAUDE.md: invented values, RFC 2606 style
// package names, no real device, and no zone name (tests pass zones in).

import { localDay } from "../../../src/hc/rollup/day.ts";
import { summariseExercise } from "../../../src/hc/rollup/exercise.ts";
import { rollupBucket } from "../../../src/hc/rollup/hour.ts";
import { hrMinutesOfHour } from "../../../src/hc/rollup/hr-minute.ts";
import { heartRateSamples } from "../../../src/hc/rollup/hr.ts";
import { summariseSleep } from "../../../src/hc/rollup/sleep.ts";
import { recordEndMs, recordStartMs } from "../../../src/hc/wire.ts";

import type { IngestLogRow, PermissionState, SyncStateRow } from "../../../src/hc/device.ts";
import type { HcRecord, HcSyncState } from "../../../src/hc/wire.ts";
import type { HcDevice, HcReads, StoreBacklog } from "../../../src/mcp/hc/reads.ts";

export const WEARABLE = "com.example.wearable";
export const PHONE = "com.example.phone";
export const CUFF = "com.example.cuff";
/** The origin the companion app uploads the platform's own aggregates under. */
export const PLATFORM = "healthconnect";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The zone the fake's day rollups are "built" for when a test names none. */
const UTC = "UTC";

interface ReadCall {
  reader: string;
  type?: string;
  startMs?: number;
  endMs?: number;
}

export interface FakeHc {
  /** The configured zone: what `deps.timezone()` answers and day rollups are in. */
  timezone: string;
  devices: HcDevice[];
  records: Map<string, HcRecord[]>;
  syncRows: Map<string, SyncStateRow[]>;
  reports: Map<string, HcSyncState>;
  backlog: Map<string, StoreBacklog & { parkedMarks?: number }>;
  ingestLog: Map<string, IngestLogRow[]>;
  calls: ReadCall[];
  /**
   * Day rollups waiting to be rebuilt, per phone. Undefined (the default)
   * models a store that does not offer the finer `dirtyDays` reader at all;
   * a map, even an empty one, models one that does.
   */
  dirtyDays?: Map<string, { type: string; day: string }[]>;
}

/** The fake's readers: `HcReads`, plus the optional finer reader when the store offers it. */
export type FakeHcReads = HcReads & {
  dirtyDays?: (window: {
    deviceId: string;
    type: string;
    startDay: string;
    endDay: string;
  }) => Promise<string[]>;
};

export function emptyHc(): FakeHc {
  return {
    timezone: UTC,
    devices: [],
    records: new Map(),
    syncRows: new Map(),
    reports: new Map(),
    backlog: new Map(),
    ingestLog: new Map(),
    calls: [],
  };
}

type Extra = Partial<HcRecord>;

export function interval(
  id: string,
  type: string,
  startMs: number,
  endMs: number,
  data: Record<string, unknown>,
  extra: Extra = {},
): HcRecord {
  return {
    id,
    type,
    origin: WEARABLE,
    lastModified: startMs,
    start: startMs,
    end: endMs,
    data,
    ...extra,
  };
}

export function instant(
  id: string,
  type: string,
  timeMs: number,
  data: Record<string, unknown>,
  extra: Extra = {},
): HcRecord {
  return { id, type, origin: WEARABLE, lastModified: timeMs, time: timeMs, data, ...extra };
}

/** A HeartRate record; each sample is `[offsetMs from start, bpm]`. */
export function heartRate(
  id: string,
  startMs: number,
  samples: readonly (readonly [number, number])[],
  extra: Extra = {},
): HcRecord {
  const last = samples.at(-1)?.[0] ?? 0;
  return interval(
    id,
    "HeartRate",
    startMs,
    startMs + last + 1000,
    { samples: samples.map(([offset, bpm]) => ({ t: startMs + offset, bpm })) },
    extra,
  );
}

/** The platform's own hourly aggregate, as the phone uploads it. */
export function platformHour(metric: string, hourStartMs: number, value: number): HcRecord {
  return interval(
    `agg:${metric}:${String(hourStartMs)}`,
    `Agg.${metric}`,
    hourStartMs,
    hourStartMs + HOUR_MS,
    { value, unit: "", origins: [WEARABLE, PHONE] },
    { origin: PLATFORM },
  );
}

export function device(id: string, name: string, lastUploadAt: number | null): HcDevice {
  return {
    id,
    name,
    createdAt: 1_700_000_000,
    revokedAt: null,
    lastSeenAt: lastUploadAt,
    lastUploadAt,
    appVersion: "0.1.1",
  };
}

/** `hc_sync_state` rows as the store would hold them for these records. */
function syncRowsOf(
  records: readonly HcRecord[],
  lastUploadAt: number | null,
  extra: readonly { type: string; permission: PermissionState }[] = [],
): SyncStateRow[] {
  const byType = new Map<string, HcRecord[]>();
  for (const record of records) {
    const list = byType.get(record.type);
    if (list === undefined) byType.set(record.type, [record]);
    else list.push(record);
  }
  const rows: SyncStateRow[] = [...byType].map(([recordType, list]) => ({
    recordType,
    permissionState: "granted",
    firstMs: Math.min(...list.map((record) => recordStartMs(record))),
    lastMs: Math.max(...list.map((record) => recordStartMs(record))),
    recordCount: list.length,
    lastUploadAt,
    tokenAgeS: 120,
    backlog: 0,
    backfillComplete: true,
    backfillOldestMs: null,
  }));
  for (const entry of extra) {
    rows.push({
      recordType: entry.type,
      permissionState: entry.permission,
      firstMs: null,
      lastMs: null,
      recordCount: 0,
      lastUploadAt,
      tokenAgeS: null,
      backlog: null,
      backfillComplete: false,
      backfillOldestMs: null,
    });
  }
  return sorted(rows, (left, right) => left.recordType.localeCompare(right.recordType));
}

/**
 * A sorted copy. Not `Array#toSorted`: the workerd integration tests import
 * this file too, and they compile against the Worker's ES2022 lib.
 */
function sorted<T>(items: Iterable<T>, compare: (left: T, right: T) => number): T[] {
  const out = [...items];
  out.sort(compare);
  return out;
}

/** Add a phone and its records to a fake store. */
export function addDevice(
  hc: FakeHc,
  phone: HcDevice,
  records: readonly HcRecord[],
  extra: readonly { type: string; permission: PermissionState }[] = [],
): void {
  hc.devices.push(phone);
  hc.records.set(phone.id, [...records]);
  hc.syncRows.set(phone.id, syncRowsOf(records, phone.lastUploadAt, extra));
}

function overlaps(record: HcRecord, startMs: number, endMs: number): boolean {
  const start = recordStartMs(record);
  return start < endMs && Math.max(recordEndMs(record), start + 1) > startMs;
}

/** The distinct names of a list, in a fixed order. */
function distinct(names: readonly string[]): string[] {
  return sorted(new Set(names), (left, right) => left.localeCompare(right));
}

function byStart(left: HcRecord, right: HcRecord): number {
  return recordStartMs(left) - recordStartMs(right);
}

/** Records grouped by a key and by origin. */
function grouped<Key>(
  records: readonly HcRecord[],
  keyOf: (record: HcRecord) => Key,
): Map<Key, Map<string, HcRecord[]>> {
  const out = new Map<Key, Map<string, HcRecord[]>>();
  for (const record of records) {
    const key = keyOf(record);
    let origins = out.get(key);
    if (origins === undefined) {
      origins = new Map();
      out.set(key, origins);
    }
    const list = origins.get(record.origin);
    if (list === undefined) origins.set(record.origin, [record]);
    else list.push(record);
  }
  return out;
}

export function fakeHcReads(hc: FakeHc): FakeHcReads {
  const all = (deviceId: string): HcRecord[] => hc.records.get(deviceId) ?? [];
  const ofType = (deviceId: string, type: string, origins?: readonly string[]): HcRecord[] =>
    all(deviceId).filter(
      (record) =>
        record.type === type && (origins === undefined || origins.includes(record.origin)),
    );
  const within = (deviceId: string, type: string, startMs: number, endMs: number): HcRecord[] =>
    sorted(
      ofType(deviceId, type).filter((record) => overlaps(record, startMs, endMs)),
      byStart,
    );
  const log = (call: ReadCall): void => {
    hc.calls.push(call);
  };

  const { dirtyDays } = hc;
  return {
    ...(dirtyDays !== undefined && {
      dirtyDays: (window) => {
        log({ reader: "dirtyDays", type: window.type });
        const marks = dirtyDays.get(window.deviceId) ?? [];
        return Promise.resolve(
          marks
            .filter(
              (mark) =>
                mark.type === window.type &&
                mark.day >= window.startDay &&
                mark.day <= window.endDay,
            )
            .map((mark) => mark.day),
        );
      },
    }),
    devices: () => Promise.resolve(hc.devices),
    syncRows: (deviceId) => Promise.resolve(hc.syncRows.get(deviceId) ?? []),
    phoneReport: (deviceId) => Promise.resolve(hc.reports.get(deviceId) ?? null),
    backlog: (deviceId) =>
      Promise.resolve(
        hc.backlog.get(deviceId) ?? {
          queuedBatches: 0,
          parkedBatches: 0,
          dirty: 0,
          rezonePending: false,
        },
      ),
    ingestLog: (deviceId, limit) =>
      Promise.resolve((hc.ingestLog.get(deviceId) ?? []).slice(0, limit)),
    origins: (deviceId, type) =>
      Promise.resolve(distinct(ofType(deviceId, type).map((record) => record.origin))),

    records: (window) => {
      log({ reader: "records", type: window.type, startMs: window.startMs, endMs: window.endMs });
      const found = ofType(window.deviceId, window.type, window.origins).filter(
        (record) => window.endMs > window.startMs && overlaps(record, window.startMs, window.endMs),
      );
      return Promise.resolve(sorted(found, byStart));
    },

    hourRollups: (window) => {
      log({
        reader: "hourRollups",
        type: window.type,
        startMs: window.startMs,
        endMs: window.endMs,
      });
      const fromHour = Math.ceil(window.startMs / HOUR_MS);
      const toHour = Math.ceil(window.endMs / HOUR_MS);
      const hours = grouped(ofType(window.deviceId, window.type, window.origins), (record) =>
        Math.floor(recordStartMs(record) / HOUR_MS),
      );
      const rows = [];
      for (const [hourUtc, origins] of hours) {
        if (hourUtc < fromHour || hourUtc >= toHour) continue;
        for (const [origin, records] of origins) {
          rows.push({ hourUtc, origin, rollup: rollupBucket(window.type, records) });
        }
      }
      return Promise.resolve(sorted(rows, (left, right) => left.hourUtc - right.hourUtc));
    },

    dayRollups: (window) => {
      log({ reader: "dayRollups", type: window.type });
      const days = grouped(ofType(window.deviceId, window.type, window.origins), (record) =>
        localDay(recordStartMs(record), hc.timezone),
      );
      const rows = [];
      for (const [day, origins] of days) {
        if (day < window.startDay || day > window.endDay) continue;
        for (const [origin, records] of origins) {
          rows.push({ day, origin, rollup: rollupBucket(window.type, records) });
        }
      }
      return Promise.resolve(sorted(rows, (left, right) => left.day.localeCompare(right.day)));
    },

    hrMinutes: (window) => {
      log({ reader: "hrMinutes", startMs: window.startMs, endMs: window.endMs });
      if (window.endMs <= window.startMs) return Promise.resolve([]);
      const records = ofType(window.deviceId, "HeartRate", window.origins);
      const origins = distinct(records.map((record) => record.origin));
      const rows = [];
      const fromHour = Math.floor(window.startMs / HOUR_MS);
      const toHour = Math.ceil(window.endMs / HOUR_MS);
      for (let hourUtc = fromHour; hourUtc < toHour; hourUtc += 1) {
        for (const origin of origins) {
          const own = records.filter((record) => record.origin === origin);
          const { minutes } = hrMinutesOfHour(own, hourUtc);
          if (minutes.length > 0) rows.push({ hourUtc, origin, minutes });
        }
      }
      return Promise.resolve(rows);
    },

    sleepNights: (window) => {
      log({ reader: "sleepNights", startMs: window.startMs, endMs: window.endMs });
      const { deviceId } = window;
      const sessions = within(deviceId, "SleepSession", window.startMs, window.endMs);
      return Promise.resolve(
        sessions.map((session) => ({
          id: `blind-${session.id}`,
          night: summariseSleep(session, {
            hr: heartRateSamples(ofType(deviceId, "HeartRate", [session.origin])),
            hrv: ofType(deviceId, "HeartRateVariabilityRmssd"),
            respiratoryRate: ofType(deviceId, "RespiratoryRate"),
            skinTemperature: ofType(deviceId, "SkinTemperature"),
            restingHeartRate: ofType(deviceId, "RestingHeartRate"),
            others: ofType(deviceId, "SleepSession")
              .filter((other) => other.id !== session.id)
              .map((other) => ({ startMs: recordStartMs(other), endMs: recordEndMs(other) })),
          }),
        })),
      );
    },

    exerciseSessions: (window) => {
      log({ reader: "exerciseSessions", startMs: window.startMs, endMs: window.endMs });
      const { deviceId } = window;
      const every = ofType(deviceId, "ExerciseSession");
      const sessions = within(deviceId, "ExerciseSession", window.startMs, window.endMs);
      return Promise.resolve(
        sessions.map((session) => ({
          id: `blind-${session.id}`,
          session: summariseExercise(session, {
            hr: heartRateSamples(ofType(deviceId, "HeartRate", [session.origin])),
            steps: ofType(deviceId, "Steps", [session.origin]),
            distance: ofType(deviceId, "Distance", [session.origin]),
            activeCalories: ofType(deviceId, "ActiveCaloriesBurned", [session.origin]),
            others: every
              .filter((other) => other.id !== session.id)
              .map((other) => ({
                idBlind: `blind-${other.id}`,
                startMs: recordStartMs(other),
                endMs: recordEndMs(other),
              })),
          }),
        })),
      );
    },
  };
}

export const DEVICE_ID = "dev_test_phone";
const DEVICE_NAME = "Test phone";

/**
 * One invented day of everything, ending at `nowMs` (which must be a UTC
 * midnight so the day is whole in UTC). Laid out so that every rule the tools
 * apply has something to bite on:
 *
 *  - steps from a wearable AND a phone every hour 08:00-18:00, with the
 *    platform's own aggregate for 08:00-12:00 only;
 *  - a night's sleep with stages, overnight heart rate, HRV and the rest;
 *  - a morning of heart rate with one sustained rise and one implausible sample;
 *  - two blood-pressure readings from a cuff, the first relayed again by the
 *    phone, and the cuff's pulse written as a "resting heart rate";
 *  - a weighing, and a weight typed into a profile beside a height;
 *  - a walk, and a four-hour session nobody stopped.
 */
export function hcWorldRecords(nowMs: number): HcRecord[] {
  const day = nowMs - DAY_MS;
  const at = (hour: number, minute = 0): number => day + hour * HOUR_MS + minute * MINUTE_MS;
  const records: HcRecord[] = [];

  for (let hour = 8; hour < 18; hour += 1) {
    records.push(
      interval(`steps-w-${String(hour)}`, "Steps", at(hour), at(hour, 1), { count: 500 }),
      interval(
        `steps-p-${String(hour)}`,
        "Steps",
        at(hour),
        at(hour, 1),
        { count: 300 },
        {
          origin: PHONE,
        },
      ),
      interval(`total-${String(hour)}`, "TotalCaloriesBurned", at(hour), at(hour + 1), {
        energy: 100,
      }),
      interval(`active-${String(hour)}`, "ActiveCaloriesBurned", at(hour), at(hour + 1), {
        energy: 20,
      }),
    );
    if (hour < 12) records.push(platformHour("Steps", at(hour), 520));
  }

  // The night before: 23:00 to 07:00, measured every five minutes.
  const bedtime = at(-1);
  const wake = at(7);
  records.push(
    interval(
      "sleep-1",
      "SleepSession",
      bedtime,
      wake,
      {
        title: "Night",
        stages: [
          { start: bedtime, end: bedtime + 20 * MINUTE_MS, stage: "AWAKE" },
          { start: bedtime + 20 * MINUTE_MS, end: at(2), stage: "LIGHT" },
          { start: at(2), end: at(4), stage: "DEEP" },
          { start: at(4), end: at(6), stage: "REM" },
          { start: at(6), end: wake, stage: "LIGHT" },
        ],
      },
      { startOffsetMin: 0, endOffsetMin: 0 },
    ),
  );
  const overnight: [number, number][] = [];
  for (let offset = 0; offset < 8 * HOUR_MS; offset += 5 * MINUTE_MS) overnight.push([offset, 54]);
  records.push(heartRate("hr-night", bedtime, overnight));
  for (let hour = 0; hour < 7; hour += 1) {
    records.push(
      instant(`hrv-${String(hour)}`, "HeartRateVariabilityRmssd", at(hour, 30), {
        rmssd: 40 + hour,
      }),
      instant(`rr-${String(hour)}`, "RespiratoryRate", at(hour, 30), { rate: 14 }),
    );
  }
  records.push(
    interval("skin-1", "SkinTemperature", bedtime, wake, {
      baseline: 33,
      deltas: [
        { t: at(1), delta: 0.2 },
        { t: at(4), delta: 0.4 },
      ],
    }),
    instant("rhr-1", "RestingHeartRate", wake, { bpm: 52 }),
  );

  // The morning: a minute-by-minute resting rate, a rise at 08:30, a bad sample at 08:50.
  const morning: [number, number][] = [];
  for (let minute = 0; minute < 120; minute += 1) {
    const rising = minute >= 90 && minute < 96;
    morning.push([minute * MINUTE_MS, rising ? 105 : 62]);
  }
  morning.push([110 * MINUTE_MS + 30_000, 232]);
  records.push(
    heartRate(
      "hr-morning",
      at(7),
      sorted(morning, (left, right) => left[0] - right[0]),
    ),
    // The cuff: two readings a sitting, its pulse as heart rate and as "resting".
    instant(
      "bp-1",
      "BloodPressure",
      at(9),
      {
        systolic: 121,
        diastolic: 79,
        bodyPosition: "SITTING_DOWN",
        measurementLocation: "LEFT_UPPER_ARM",
      },
      { origin: CUFF },
    ),
    instant(
      "bp-1-relayed",
      "BloodPressure",
      at(9),
      { systolic: 121, diastolic: 79 },
      {
        origin: PHONE,
        lastModified: at(9, 5),
      },
    ),
    instant("bp-2", "BloodPressure", at(9, 2), { systolic: 117, diastolic: 77 }, { origin: CUFF }),
    heartRate("hr-cuff", at(9), [[0, 68]], { origin: CUFF }),
    instant("rhr-cuff", "RestingHeartRate", at(9), { bpm: 68 }, { origin: CUFF }),
    // A weighing, and a profile screen's weight beside a height and a BMR.
    instant("weight-1", "Weight", at(7, 10), { weight: 70.5 }, { origin: PHONE }),
    instant("weight-profile", "Weight", at(12), { weight: 70 }, { origin: PHONE }),
    instant("height-1", "Height", at(12), { height: 1.75 }, { origin: PHONE }),
    instant("bmr-1", "BasalMetabolicRate", at(12), { bmr: 1600 }, { origin: PHONE }),
  );

  // A walk with its own heart rate, and a session left running.
  const walk: [number, number][] = [];
  for (let minute = 0; minute < 40; minute += 1) walk.push([minute * MINUTE_MS, 128]);
  records.push(
    interval("walk-1", "ExerciseSession", at(18, 30), at(19, 10), {
      exerciseType: "WALKING",
      title: "Evening walk",
    }),
    heartRate("hr-walk", at(18, 30), walk),
    interval("distance-1", "Distance", at(18, 30), at(19, 10), { distance: 3000 }),
    interval(
      "left-running",
      "ExerciseSession",
      at(19, 30),
      at(23, 30),
      {
        exerciseType: "OTHER_WORKOUT",
      },
      { origin: PHONE },
    ),
    interval("floors-1", "FloorsClimbed", at(10), at(10, 5), { floors: 2 }),
  );
  return records;
}

/** A fake store holding {@link hcWorldRecords} on one phone that uploaded ten minutes ago. */
export function hcWorld(nowSeconds: number): FakeHc {
  const hc = emptyHc();
  addDevice(
    hc,
    device(DEVICE_ID, DEVICE_NAME, nowSeconds - 600),
    hcWorldRecords(nowSeconds * 1000),
    [
      { type: "BodyTemperature", permission: "denied" },
      { type: "OxygenSaturation", permission: "unavailable" },
      { type: "Hydration", permission: "granted" },
    ],
  );
  hc.reports.set(DEVICE_ID, {
    types: [],
    backgroundRead: true,
    historyRead: true,
    batteryExempt: true,
    backfillComplete: false,
    androidSdk: 37,
  });
  hc.ingestLog.set(DEVICE_ID, [
    {
      receivedAt: nowSeconds - 600,
      appliedAt: nowSeconds - 590,
      status: "applied",
      errorCode: null,
      upserts: 10,
      deletes: 0,
      rejected: 0,
      applied: 10,
      superseded: 0,
      removed: 0,
      bodyBytes: 100,
      rawBytes: 1000,
      applyMs: 12,
    },
    {
      receivedAt: nowSeconds - 4000,
      appliedAt: null,
      status: "failed",
      errorCode: "apply_failed",
      upserts: 1,
      deletes: 0,
      rejected: 0,
      applied: 0,
      superseded: 0,
      removed: 0,
      bodyBytes: 10,
      rawBytes: 100,
      applyMs: null,
    },
  ]);
  return hc;
}
