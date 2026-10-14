/**
What every Health Connect tool does before and after its own work: decide
which phones the call is about, say how fresh each record type is, and hand
the rows to `respond()` with the byte budget attached.

A phone is a source beside the health systems, not one of them. Its rows are
tagged `healthSystemId: "device:<id>"` and `resourceType: "hc:<Type>"`, which
is all the exposure policy needs to treat them exactly as it treats FHIR:
a `health_system` rule on `device:<id>` removes the phone, a `resource` rule
on `hc:HeartRate` removes the type, and a `field` rule scoped to either
reaches the rows. (`./policy.ts` covers the two cases where a number sits
on a row of another type.) Both whole-source denials are also applied HERE, before
anything is read -- a denied phone is never queried and a denied type never
opened -- for the reason `selectHealthSystems` gives: the policy filter on
the way out is the trusted path, this is the cheap one, and coverage must
not describe what the deny-list hides.

What a client hears about a type is about DATA: the store holds records of
it (and the phone is current, or stale), or it holds none. A type with none
is not mentioned at all unless the caller named it, and then it is `no_data`
-- never a word about whether the phone was allowed to read it. See
`mcpDeviceCoverage` in `worker/src/hc/coverage.ts` for the rule and why.
*/

import {
  coverageResourceType,
  deviceSourceId,
  hoursSince,
  mcpDeviceCoverage,
  uploadLateHours,
} from "../../hc/coverage.ts";
import { recordFieldsOf } from "../../hc/record-types.ts";
import { daysTouched } from "../../hc/rollup/day.ts";
import { isHealthSystemDenied } from "../../policy/rules.ts";
import { respond } from "../respond.ts";

import { DEFAULT_MAX_BYTES, writeCursor } from "./page.ts";
import {
  isPlatformAggregate,
  policyResourceType,
  sourceTypeOf,
  typeAllowed,
  typeDeniedWarning,
} from "./policy.ts";
import { SECOND_MS, zoneClock } from "./time.ts";

import type { StampedPage } from "./page.ts";
import type { HcDevice, StoreBacklog, SyncStateRow } from "./reads.ts";
import type { ZoneClock } from "./time.ts";
import type { PolicyRules } from "../../policy/rules.ts";
import type { CoverageEntry } from "../coverage.ts";
import type { ToolDeps } from "../deps.ts";
import type { ToolOutcome } from "../respond.ts";

export { coverageResourceType, deviceSourceId } from "../../hc/coverage.ts";
export { typeAllowed, typeDeniedWarning } from "./policy.ts";

/** What `coverageResourceType` puts before a record type. */
const HC_PREFIX = "hc:";

/** The arguments every Health Connect tool takes. */
export interface HcSharedArgs {
  devices?: string[] | undefined;
  tz?: string | undefined;
  limit?: number | undefined;
  max_bytes?: number | undefined;
  cursor?: string | undefined;
  jq?: string | undefined;
}

/** Phones a call may read: not denied, and matching `wanted` when it is given. */
function selectDevices(
  devices: readonly HcDevice[],
  rules: PolicyRules,
  wanted: readonly string[] | undefined,
): HcDevice[] {
  const allowed = devices.filter(
    (device) => !isHealthSystemDenied(rules, deviceSourceId(device.id)),
  );
  if (wanted === undefined || wanted.length === 0) return allowed;
  const needles = wanted.map((entry) => entry.trim().toLowerCase());
  return allowed.filter((device) => {
    const name = device.name.toLowerCase();
    return needles.some(
      (needle) =>
        needle === device.id.toLowerCase() ||
        needle === deviceSourceId(device.id).toLowerCase() ||
        (needle !== "" && name.includes(needle)),
    );
  });
}

/** What one call runs under. */
export interface HcCall {
  /** The phones this call reads, deny-list and `devices` applied. */
  devices: HcDevice[];
  rules: PolicyRules;
  /** Unix seconds, and the same instant in epoch ms. */
  now: number;
  nowMs: number;
  /** The zone this answer is in: `tz`, else the owner's setting. */
  clock: ZoneClock;
  /** True when that zone is the configured one, so day rollups may be used. */
  configuredZone: boolean;
  /**
  `hc_sync_state` of each phone of this call, by device id: where the
  newest stored record of every type ends, which is what an answer's
  `freshness` is read from. Bookkeeping the coverage of every tool reads
  anyway (one memoised read a phone), never a measurement.
  */
  syncRows?: ReadonlyMap<string, readonly SyncStateRow[]>;
}

export async function beginHcCall(
  deps: ToolDeps,
  run: { rules: PolicyRules; now: number },
  args: HcSharedArgs,
): Promise<HcCall> {
  const configured = await deps.timezone();
  const timeZone = args.tz ?? configured;
  const devices = selectDevices(await deps.hc.devices(), run.rules, args.devices);
  const syncRows = new Map<string, readonly SyncStateRow[]>();
  for (const device of devices) syncRows.set(device.id, await deps.hc.syncRows(device.id));
  return {
    devices,
    syncRows,
    rules: run.rules,
    now: run.now,
    nowMs: run.now * SECOND_MS,
    clock: zoneClock(timeZone),
    configuredZone: timeZone === configured,
  };
}

/**
What a client is told about one record type on one phone:

 - `ok`      the store holds records of it and the phone uploaded recently
 - `stale`   it holds records, but the phone has not uploaded lately
 - `no_data` it holds none. Only ever said of a type the caller NAMED; a
             type nobody asked about and nobody has data for is not listed

Nothing here says why there is no data, and that is the point: whether the
phone may read a type is the owner's business on the Phone page
(`worker/src/hc/coverage.ts`), not a client's.
*/
export type Availability = "ok" | "no_data" | "stale";

function availabilityOf(entry: CoverageEntry): Availability {
  if (entry.recordCount === 0) return "no_data";
  return entry.status === "ok" ? "ok" : "stale";
}

/** True for a record type the wire knows, a platform aggregate of one included. */
function isKnownType(type: string): boolean {
  const known = isPlatformAggregate(type) ? sourceTypeOf(type) : recordFieldsOf(type);
  return known !== null;
}

/**
The warnings that answer every type a caller NAMED and got no rows of, so a
name is never dropped in silence:

 - `no_data:hc:<Type>:device:<id>` per phone, for a type the wire knows and
   the store has nothing of;
 - `unknown_type:hc:<Type>` once, for a name that is no record type at all
   -- an `Agg.<Metric>` this Worker maps to no record type included (a
   misspelt one, or `Agg.` put before a type the platform does not
   aggregate). That says nothing about the policy: there is no such type for
   a rule to be on;
 - `policy_resource_denied:hc:<Type>` once, for a known type the owner's
   policy withholds. It has no coverage entry and no rows, by design, and
   the warning is the one every tool gives for a type it may not read.

A type that is there needs none; a stale one is announced with the rest of
coverage's warnings.
*/
function emptyTypeWarnings(
  call: HcCall,
  coverage: readonly CoverageEntry[],
  named: readonly string[],
): string[] {
  const out: string[] = [];
  for (const entry of coverage) {
    if (availabilityOf(entry) === "no_data") {
      out.push(`no_data:${entry.resourceType}:${entry.healthSystemId}`);
    }
  }
  const covered = new Set(coverage.map((entry) => entry.resourceType));
  const asked = new Set(named);
  for (const type of asked) {
    if (covered.has(coverageResourceType(type))) continue;
    if (!isKnownType(type)) out.push(`unknown_type:${coverageResourceType(type)}`);
    else if (!typeAllowed(call.rules, type)) out.push(typeDeniedWarning(type));
  }
  return out;
}

/** What the envelope's `freshness` says of one phone. */
interface PhoneFreshness {
  healthSystemId: string;
  /** When the phone last uploaded, in the answer's zone; null before the first upload. */
  lastUploadAt: string | null;
  /** Hours since then, to one decimal. */
  hoursSinceUpload: number | null;
  /**
  `hc:<Type>` -> the end of the newest stored record of that type, in the
  answer's zone: the answer holds nothing of the type after it.
  */
  dataThrough: Record<string, string>;
}

/**
How fresh the data behind an answer is, per phone: when it last uploaded,
and for every record type the answer's `coverage` lists with records, where
the newest stored record of it ends.

Read off `hc_sync_state` (`last_ms`, which the store recounts from its
chunks whenever a batch is applied), so it costs no read of its own and
opens no record. Only types in `coverage` are named: coverage has already
been through the deny-list, and this envelope field is not filtered again.
*/
function freshnessOf(call: HcCall, coverage: readonly CoverageEntry[]): PhoneFreshness[] {
  return call.devices.map((device) => {
    const source = deviceSourceId(device.id);
    const listed = new Set(
      coverage
        .filter((entry) => entry.healthSystemId === source)
        .map((entry) => entry.resourceType),
    );
    const rows = call.syncRows?.get(device.id) ?? [];
    const through: [string, string][] = [];
    for (const row of rows) {
      const resourceType = coverageResourceType(row.recordType);
      if (row.lastMs !== null && row.recordCount > 0 && listed.has(resourceType)) {
        through.push([resourceType, call.clock.iso(row.lastMs)]);
      }
    }
    const dataThrough = Object.fromEntries(through);
    return {
      healthSystemId: source,
      lastUploadAt:
        device.lastUploadAt === null ? null : call.clock.iso(device.lastUploadAt * SECOND_MS),
      hoursSinceUpload:
        device.lastUploadAt === null ? null : hoursSince(call.now, device.lastUploadAt),
      dataThrough,
    };
  });
}

/**
`hc_upload_stale:<source>:<age>h` for every phone of the call whose last
upload is more than an hour old (`HC_UPLOAD_LATE_AFTER_SECONDS`): the phone
syncs every fifteen minutes, so whatever it measured since then is not in
the answer. `<age>` is hours to one decimal. Said on every Health Connect
answer, with or without rows -- a quiet gap is the thing being announced.
*/
function uploadStaleWarnings(call: HcCall): string[] {
  const out: string[] = [];
  for (const device of call.devices) {
    const hours = uploadLateHours(device, call.now);
    if (hours !== null) {
      out.push(`hc_upload_stale:${deviceSourceId(device.id)}:${hours.toFixed(1)}h`);
    }
  }
  return out;
}

/** Which record types a tool's coverage is about. */
export interface CoverageScope {
  /**
  Only these types are reported, and only when the store holds records of
  them. Omitted: every type it holds records of -- except the platform
  aggregates (`Agg.<Metric>`), which are listed only when asked for.
  */
  types?: readonly string[] | undefined;
  /**
  Types the CALLER asked for by name (or the one type a tool is about):
  each is reported even when the store holds nothing of it, as `no_data`.
  */
  named?: readonly string[] | undefined;
}

/**
Coverage for the phones of this call: one entry per phone and record type
the store holds records of (`mcpDeviceCoverage`), within `scope`. A type the
policy denies is left out.
*/
export async function deviceCoverageFor(
  deps: ToolDeps,
  call: HcCall,
  scope: CoverageScope = {},
): Promise<CoverageEntry[]> {
  const named = (scope.named ?? []).filter((type) => isKnownType(type));
  const listed =
    scope.types === undefined && scope.named === undefined
      ? null
      : [...(scope.types ?? []), ...(scope.named ?? [])];
  const wanted = listed === null ? null : new Set(listed.map((t) => coverageResourceType(t)));
  const reported = (entry: CoverageEntry): boolean => {
    const type = entry.resourceType.slice(HC_PREFIX.length);
    // Judged as the record type, so a platform aggregate follows its source type.
    if (!typeAllowed(call.rules, type)) return false;
    // And an aggregate is only reported when asked for by name: it is the
    // platform's summary of another type, not a type of the phone's own.
    return wanted === null ? !isPlatformAggregate(type) : wanted.has(entry.resourceType);
  };
  const out: CoverageEntry[] = [];
  for (const device of call.devices) {
    const entries = mcpDeviceCoverage({
      device,
      rows: await deps.hc.syncRows(device.id),
      now: call.now,
      namedTypes: named,
    });
    out.push(...entries.filter((entry) => reported(entry)));
  }
  return out;
}

/** `availability` by `hc:<Type>` for one phone, from a coverage array. */
export function availabilityByType(
  coverage: readonly CoverageEntry[],
  deviceId: string,
): Map<string, Availability> {
  const source = deviceSourceId(deviceId);
  const out = new Map<string, Availability>();
  for (const entry of coverage) {
    if (entry.healthSystemId === source) out.set(entry.resourceType, availabilityOf(entry));
  }
  return out;
}

/** What a tool needs to know about one phone's store before it answers from it. */
export interface StoreState {
  /** Warnings to pass on: stable strings, the phone's source id, a count. */
  warnings: string[];
  /**
  True when the day rollups hold every applied record for the configured
  zone: nothing is waiting to be rebuilt and no rezone is under way. The
  device-wide answer; {@link dayRollupsUsable} narrows it to one type and
  range.
  */
  dayRollupsCurrent: boolean;
  /** Rollups and summaries waiting to be rebuilt, of any type. Parked marks are not counted. */
  dirty: number;
  /** True while day rollups built for another zone are still there. */
  rezonePending: boolean;
}

/**
Two things the store may tell a tool beyond `StoreBacklog` as `./reads.ts`
declares it. Both are optional, and read structurally, so this module works
against a store that offers neither -- it then answers conservatively.

 - `parkedMarks` on the backlog: marks set aside because what they must be
   rebuilt from will not open. They are not work in progress, so they are
   reported on their own and never as "pending".
 - `dirtyDays`: the local days in a range for which one type's day rollup is
   waiting to be rebuilt. With it, one type's unfinished rebuild no longer
   sends every other type's multi-year question to the hour rollups.
*/
interface FinerStore {
  dirtyDays: (window: {
    deviceId: string;
    type: string;
    /** Inclusive, `YYYY-MM-DD`. */
    startDay: string;
    /** Inclusive, `YYYY-MM-DD`. */
    endDay: string;
  }) => Promise<string[]>;
}

/**
The store's outstanding work for one phone, as warnings:

 - `hc_store_pending:<source>`: uploads are still being applied or rollups
   rebuilt, so the newest upload may not be in the answer yet;
 - `hc_batches_parked:<source>:<n>`: `n` uploads could not be applied and
   are set aside, so their records are missing from every answer;
 - `hc_rollups_parked:<source>:<n>`: `n` rollups or summaries could not be
   rebuilt and are set aside, so a figure answered from them may be missing
   or out of date. Not "pending": nothing is working on them.
*/
export async function storeState(deps: ToolDeps, device: HcDevice): Promise<StoreState> {
  const backlog: StoreBacklog & { parkedMarks?: number } = await deps.hc.backlog(device.id);
  const source = deviceSourceId(device.id);
  const pending = backlog.queuedBatches > 0 || backlog.dirty > 0 || backlog.rezonePending;
  const parkedMarks = backlog.parkedMarks ?? 0;
  return {
    warnings: [
      ...(pending ? [`hc_store_pending:${source}`] : []),
      ...(backlog.parkedBatches > 0
        ? [`hc_batches_parked:${source}:${String(backlog.parkedBatches)}`]
        : []),
      ...(parkedMarks > 0 ? [`hc_rollups_parked:${source}:${String(parkedMarks)}`] : []),
    ],
    dayRollupsCurrent: backlog.dirty === 0 && !backlog.rezonePending,
    dirty: backlog.dirty,
    rezonePending: backlog.rezonePending,
  };
}

/**
Whether the day rollups of ONE type can answer a range for a phone: the
answer is in the configured zone, no rezone is under way, and no day rollup
of that type in that range is waiting to be rebuilt.

The last is asked of the store when it offers `dirtyDays` (see
{@link FinerStore}). When it does not, any outstanding mark at all counts
against every type, which is slower and never wrong.
*/
export async function dayRollupsUsable(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
  query: { state: StoreState; type: string; range: { startMs: number; endMs: number } },
): Promise<boolean> {
  const { state, type, range } = query;
  if (!call.configuredZone || state.rezonePending) return false;
  if (state.dirty === 0) return true;
  const { dirtyDays } = deps.hc as Partial<FinerStore>;
  if (dirtyDays === undefined || range.endMs <= range.startMs) return false;
  const days = daysTouched(range.startMs, range.endMs, call.clock.timeZone);
  const startDay = days[0];
  const endDay = days.at(-1);
  if (startDay === undefined || endDay === undefined) return false;
  const waiting = await dirtyDays({ deviceId: device.id, type, startDay, endDay });
  return waiting.length === 0;
}

/** The tags every Health Connect row carries, which is what the policy judges it by. */
export function rowTags(
  device: HcDevice,
  type: string,
): { resourceType: string; healthSystemId: string } {
  return { resourceType: policyResourceType(type), healthSystemId: deviceSourceId(device.id) };
}

export interface HcAnswer {
  tool: string;
  call: HcCall;
  args: HcSharedArgs;
  /** The caller's cursor, from `openStampedPage` (`./page.ts`). */
  page: StampedPage;
  items: readonly unknown[];
  /** Coverage for what was read; see {@link deviceCoverageFor}. */
  coverage: readonly CoverageEntry[];
  /** The types the caller named, as given to {@link deviceCoverageFor}. */
  named?: readonly string[] | undefined;
  warnings?: readonly string[];
  /** Envelope fields beside `timeZone`. Never anything read from a record. */
  extra?: Readonly<Record<string, unknown>>;
  /**
  `hc_records` only: the cursor for "continue at row `next`" of this
  call's array, given the rows that were sent, when it can be anchored to a
  time. Otherwise the cursor is a plain offset into the whole answer.
  */
  cursorFor?: (next: number, sent: readonly unknown[]) => string;
  /**
  `data_quality` only: the stretch of the range this call read, when it
  walks the range a window at a time (`dataQualityPage`). `items` are then
  the rows of `[fromMs, untilMs)`, and unless `done` the answer is
  `truncated` with a cursor that goes on from `untilMs` -- whether or not
  the byte budget cut anything.
  */
  scan?: { fromMs: number; untilMs: number; done: boolean };
}

/**
The cursors of an answer that covers one stretch of a longer walk: a cut
inside its rows repeats the same stretch and skips what was sent, and the
end of its rows moves on to the next stretch.
*/
function scanCursors(
  page: StampedPage,
  scan: NonNullable<HcAnswer["scan"]>,
): {
  cursorFor: (next: number) => string;
  resume: ((rows: readonly unknown[]) => string) | undefined;
} {
  return {
    cursorFor: (next) =>
      writeCursor(page.digest, {
        offset: next,
        anchorMs: scan.fromMs,
        untilMs: scan.untilMs,
        before: page.before,
      }),
    resume: scan.done
      ? undefined
      : (rows) =>
          writeCursor(page.digest, {
            offset: 0,
            anchorMs: scan.untilMs,
            before: page.before + rows.length,
          }),
  };
}

/** The tools whose rows are ABOUT phones, one or more per phone by design. */
const DEVICE_LISTING_TOOLS: ReadonlySet<string> = new Set(["hc_coverage", "hc_sync_status"]);

/**
`multiple_devices:<n>` when the rows of a data tool come from more than one
phone. Revoking a phone keeps its data, so a phone paired again without the
old one's data being wiped answers beside it and every total is doubled:
the caller is told, and `devices` picks one.
*/
function multipleDevicesWarning(tool: string, items: readonly unknown[]): string[] {
  if (DEVICE_LISTING_TOOLS.has(tool)) return [];
  const sources = new Set<string>();
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const source = (item as { healthSystemId?: unknown }).healthSystemId;
    if (typeof source === "string") sources.add(source);
  }
  return sources.size > 1 ? [`multiple_devices:${String(sources.size)}`] : [];
}

/** Hand a Health Connect tool's rows to `respond()`, with coverage and the byte budget. */
export function hcRespond(answer: HcAnswer): Promise<ToolOutcome> {
  const { call, args, page } = answer;
  const scanned = answer.scan === undefined ? null : scanCursors(page, answer.scan);
  return respond({
    tool: answer.tool,
    rules: call.rules,
    items: answer.items,
    limit: args.limit,
    jq: args.jq,
    healthSystemIds: call.devices.map((device) => deviceSourceId(device.id)),
    // A tool that refused a type has usually said so itself: once is enough.
    warnings: [
      ...new Set([
        ...(answer.warnings ?? []),
        ...multipleDevicesWarning(answer.tool, answer.items),
        ...uploadStaleWarnings(call),
        ...emptyTypeWarnings(call, answer.coverage, answer.named ?? []),
      ]),
    ],
    coverage: answer.coverage,
    extra: {
      timeZone: call.clock.timeZone,
      freshness: freshnessOf(call, answer.coverage),
      ...answer.extra,
    },
    page: {
      maxBytes: args.max_bytes ?? DEFAULT_MAX_BYTES,
      offset: page.offset,
      // Rows a resumed read did not read again still count in `total`.
      before: page.before,
      cursorFor:
        answer.cursorFor ??
        scanned?.cursorFor ??
        ((next) => writeCursor(page.digest, page.before + next)),
      resume: scanned?.resume,
    },
    now: call.now,
  });
}
