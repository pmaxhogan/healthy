/**
One stored Health Connect record as a tool row.

The store keeps a record exactly as the phone serialised it: epoch
milliseconds everywhere, `data` untouched. A row keeps every value and
changes only how instants are written -- ISO-8601 with the answer's zone
offset -- at the top level and inside the nested lists the wire contract
names. Numbers stay numbers, and no unit is repeated on a row.
*/

import { recordEndMs, recordStartMs } from "../../hc/wire.ts";

import type { ZoneClock } from "./time.ts";
import type { HcRecord } from "../../hc/wire.ts";

/** The nested lists of `data` whose elements carry times. */
const TIMED_LISTS: ReadonlySet<string> = new Set([
  "samples",
  "stages",
  "segments",
  "laps",
  "route",
  "deltas",
]);

/** The keys of such an element that hold an epoch-ms instant. */
const TIME_KEYS: ReadonlySet<string> = new Set(["t", "start", "end"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elementWithIsoTimes(element: unknown, clock: ZoneClock): unknown {
  if (!isObject(element)) return element;
  return Object.fromEntries(
    Object.entries(element).map(([key, value]) => [
      key,
      typeof value === "number" && Number.isFinite(value) && TIME_KEYS.has(key)
        ? clock.iso(value)
        : value,
    ]),
  );
}

/** `data` with the instants inside its timed lists written as ISO-8601, and optionally projected. */
function dataWithIsoTimes(
  data: Record<string, unknown>,
  clock: ZoneClock,
  fields?: readonly string[],
): Record<string, unknown> {
  const wanted = fields === undefined ? null : new Set(fields);
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(data)) {
    if (wanted !== null && !wanted.has(key)) continue;
    out.push([
      key,
      TIMED_LISTS.has(key) && Array.isArray(value)
        ? (value as unknown[]).map((element) => elementWithIsoTimes(element, clock))
        : value,
    ]);
  }
  return Object.fromEntries(out);
}

export interface RecordItemOptions {
  /** Keys of `data` to keep. Omitted: all of them. */
  fields?: readonly string[] | undefined;
  /** Also return the record's metadata. */
  metadata: boolean;
}

/** The row for one record, without the source tags the caller adds. */
export function recordItem(
  record: HcRecord,
  clock: ZoneClock,
  options: RecordItemOptions,
): Record<string, unknown> {
  const instantaneous = record.time !== undefined;
  return {
    id: record.id,
    origin: record.origin,
    ...(instantaneous
      ? { time: clock.iso(recordStartMs(record)) }
      : { start: clock.iso(recordStartMs(record)), end: clock.iso(recordEndMs(record)) }),
    data: dataWithIsoTimes(record.data, clock, options.fields),
    ...(options.metadata && {
      device: record.device ?? null,
      recordingMethod: record.recordingMethod ?? null,
      lastModified: clock.iso(record.lastModified),
      ...(instantaneous
        ? { offsetMin: record.offsetMin ?? null }
        : {
            startOffsetMin: record.startOffsetMin ?? null,
            endOffsetMin: record.endOffsetMin ?? null,
          }),
      clientRecordId: record.clientRecordId ?? null,
      clientRecordVersion: record.clientRecordVersion ?? null,
    }),
  };
}
