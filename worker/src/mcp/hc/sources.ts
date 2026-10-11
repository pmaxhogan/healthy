/**
 * What every Health Connect tool does before and after its own work: decide
 * which phones the call is about, say how fresh each record type is, and hand
 * the rows to `respond()` with the byte budget attached.
 *
 * A phone is a source beside the health systems, not one of them. Its rows are
 * tagged `healthSystemId: "device:<id>"` and `resourceType: "hc:<Type>"`, which
 * is all the exposure policy needs to treat them exactly as it treats FHIR:
 * a `health_system` rule on `device:<id>` removes the phone, a `resource` rule
 * on `hc:HeartRate` removes the type, and a `field` rule scoped to either
 * reaches the rows. (`./policy.ts` covers the two cases where a number sits
 * on a row of another type.) Both whole-source denials are also applied HERE, before
 * anything is read -- a denied phone is never queried and a denied type never
 * opened -- for the reason `selectHealthSystems` gives: the policy filter on
 * the way out is the trusted path, this is the cheap one, and coverage must
 * not describe what the deny-list hides.
 *
 * "No rows" has four different meanings for phone data, and none of them is
 * "nothing happened". Coverage's vocabulary carries three (`unsupported` with a
 * notice for a type that is not permitted or not available on the phone,
 * `never`, `stale`); `availability` spells all of them out per type, and a
 * warning is added for the ones coverage itself is silent about.
 */

import { coverageResourceType, deviceCoverage, deviceSourceId } from "../../hc/coverage.ts";
import { daysTouched } from "../../hc/rollup/day.ts";
import { isHealthSystemDenied } from "../../policy/rules.ts";
import { respond } from "../respond.ts";

import { DEFAULT_MAX_BYTES, writeCursor } from "./page.ts";
import { isPlatformAggregate, policyResourceType, typeAllowed } from "./policy.ts";
import { SECOND_MS, zoneClock } from "./time.ts";

import type { StampedPage } from "./page.ts";
import type { HcDevice, StoreBacklog } from "./reads.ts";
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
}

export async function beginHcCall(
  deps: ToolDeps,
  run: { rules: PolicyRules; now: number },
  args: HcSharedArgs,
): Promise<HcCall> {
  const configured = await deps.timezone();
  const timeZone = args.tz ?? configured;
  return {
    devices: selectDevices(await deps.hc.devices(), run.rules, args.devices),
    rules: run.rules,
    now: run.now,
    nowMs: run.now * SECOND_MS,
    clock: zoneClock(timeZone),
    configuredZone: timeZone === configured,
  };
}

/**
 * Why a type may have no rows, in plain words:
 *
 *  - `ok`            permitted, uploaded recently, and there are records
 *  - `no_data`       permitted and current, but the phone holds no such records
 *  - `stale`         there may be records, but the phone has not uploaded lately
 *  - `never_synced`  the phone has not reported this type (or has never uploaded)
 *  - `not_permitted` the companion app has not been granted this type
 *  - `not_available` the phone's Health Connect does not offer this type
 */
export type Availability =
  "ok" | "no_data" | "stale" | "never_synced" | "not_permitted" | "not_available";

function availabilityOf(entry: CoverageEntry): Availability {
  switch (entry.status) {
    case "unsupported": {
      return entry.notices?.some((notice) => notice.code === "permission_unavailable") === true
        ? "not_available"
        : "not_permitted";
    }
    case "never": {
      return "never_synced";
    }
    case "stale": {
      return "stale";
    }
    case "ok": {
      return entry.recordCount === 0 ? "no_data" : "ok";
    }
    // A device entry is never `failed` or `partial`; read as stale if one ever is.
    case "failed":
    case "partial": {
      return "stale";
    }
  }
}

/** The availabilities coverage's own warnings do not already announce. */
const ANNOUNCED_HERE: ReadonlySet<Availability> = new Set<Availability>([
  "no_data",
  "not_permitted",
  "not_available",
]);

/** `not_permitted:hc:<Type>:device:<id>` and its siblings, one per quiet gap. */
function availabilityWarnings(coverage: readonly CoverageEntry[]): string[] {
  const out: string[] = [];
  for (const entry of coverage) {
    const availability = availabilityOf(entry);
    if (ANNOUNCED_HERE.has(availability)) {
      out.push(`${availability}:${entry.resourceType}:${entry.healthSystemId}`);
    }
  }
  return out;
}

/**
 * Coverage for the phones of this call.
 *
 * `types` names the record types the tool answers for: each is reported for
 * every phone, as `never` when the phone has said nothing about it. Omitted,
 * every type the phone has reported is -- except the platform aggregates
 * (`Agg.<Metric>`), which are listed only when named. A type the policy denies
 * is left out either way.
 */
export async function deviceCoverageFor(
  deps: ToolDeps,
  call: HcCall,
  types?: readonly string[],
): Promise<CoverageEntry[]> {
  const wanted = types === undefined ? null : new Set(types.map((t) => coverageResourceType(t)));
  const out: CoverageEntry[] = [];
  for (const device of call.devices) {
    const entries = deviceCoverage({
      device,
      rows: await deps.hc.syncRows(device.id),
      now: call.now,
      ...(types !== undefined && { expectedTypes: types }),
    });
    for (const entry of entries) {
      const type = entry.resourceType.slice(HC_PREFIX.length);
      // Judged as the record type, so a platform aggregate follows its source type.
      if (!typeAllowed(call.rules, type)) continue;
      // And an aggregate is only reported when asked for by name: it is the
      // platform's summary of another type, not a type of the phone's own.
      if (wanted === null && isPlatformAggregate(type)) continue;
      if (wanted === null || wanted.has(entry.resourceType)) out.push(entry);
    }
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
   * True when the day rollups hold every applied record for the configured
   * zone: nothing is waiting to be rebuilt and no rezone is under way. The
   * device-wide answer; {@link dayRollupsUsable} narrows it to one type and
   * range.
   */
  dayRollupsCurrent: boolean;
  /** Rollups and summaries waiting to be rebuilt, of any type. Parked marks are not counted. */
  dirty: number;
  /** True while day rollups built for another zone are still there. */
  rezonePending: boolean;
}

/**
 * Two things the store may tell a tool beyond `StoreBacklog` as `./reads.ts`
 * declares it. Both are optional, and read structurally, so this module works
 * against a store that offers neither -- it then answers conservatively.
 *
 *  - `parkedMarks` on the backlog: marks set aside because what they must be
 *    rebuilt from will not open. They are not work in progress, so they are
 *    reported on their own and never as "pending".
 *  - `dirtyDays`: the local days in a range for which one type's day rollup is
 *    waiting to be rebuilt. With it, one type's unfinished rebuild no longer
 *    sends every other type's multi-year question to the hour rollups.
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
 * The store's outstanding work for one phone, as warnings:
 *
 *  - `hc_store_pending:<source>`: uploads are still being applied or rollups
 *    rebuilt, so the newest upload may not be in the answer yet;
 *  - `hc_batches_parked:<source>:<n>`: `n` uploads could not be applied and
 *    are set aside, so their records are missing from every answer;
 *  - `hc_rollups_parked:<source>:<n>`: `n` rollups or summaries could not be
 *    rebuilt and are set aside, so a figure answered from them may be missing
 *    or out of date. Not "pending": nothing is working on them.
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
 * Whether the day rollups of ONE type can answer a range for a phone: the
 * answer is in the configured zone, no rezone is under way, and no day rollup
 * of that type in that range is waiting to be rebuilt.
 *
 * The last is asked of the store when it offers `dirtyDays` (see
 * {@link FinerStore}). When it does not, any outstanding mark at all counts
 * against every type, which is slower and never wrong.
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
  warnings?: readonly string[];
  /** Envelope fields beside `timeZone`. Never anything read from a record. */
  extra?: Readonly<Record<string, unknown>>;
  /**
   * `hc_records` only: the cursor for "continue at row `next`" of this
   * call's array, given the rows that were sent, when it can be anchored to a
   * time. Otherwise the cursor is a plain offset into the whole answer.
   */
  cursorFor?: (next: number, sent: readonly unknown[]) => string;
}

/** The tools whose rows are ABOUT phones, one or more per phone by design. */
const DEVICE_LISTING_TOOLS: ReadonlySet<string> = new Set(["hc_coverage", "hc_sync_status"]);

/**
 * `multiple_devices:<n>` when the rows of a data tool come from more than one
 * phone. Revoking a phone keeps its data, so a phone paired again without the
 * old one's data being wiped answers beside it and every total is doubled:
 * the caller is told, and `devices` picks one.
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
  return respond({
    tool: answer.tool,
    rules: call.rules,
    items: answer.items,
    limit: args.limit,
    jq: args.jq,
    healthSystemIds: call.devices.map((device) => deviceSourceId(device.id)),
    warnings: [
      ...(answer.warnings ?? []),
      ...multipleDevicesWarning(answer.tool, answer.items),
      ...availabilityWarnings(answer.coverage),
    ],
    coverage: answer.coverage,
    extra: { timeZone: call.clock.timeZone, ...answer.extra },
    page: {
      maxBytes: args.max_bytes ?? DEFAULT_MAX_BYTES,
      offset: page.offset,
      // Rows a resumed read did not read again still count in `total`.
      before: page.before,
      cursorFor: answer.cursorFor ?? ((next) => writeCursor(page.digest, page.before + next)),
    },
    now: call.now,
  });
}
