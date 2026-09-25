/**
 * Telling "no data" apart from "we could not get it".
 *
 * Every collection tool reads whatever the daily full refresh cached and never
 * touches a health system itself, so an empty `items` array is ambiguous on its
 * own: it means "this record has none of these", "the last refresh failed",
 * "this organisation was never asked" and "this organisation does not offer the
 * type" all the same way. `fhir_sync_state` already knows which of those is
 * true for every (health system, resource type) pair `worker/sync/full-refresh.ts`
 * attempts; this module turns that into the `coverage` array every tool answer
 * carries, so a caller can tell an absence from a gap without a second tool call.
 *
 * Ordering of the checks in {@link statusOf} matters and mirrors how the data was
 * produced:
 *
 *   1. `unsupported` -- the organisation's own CapabilityStatement does not
 *      offer this type. Not a failure of anything; see `UNSUPPORTED_ERROR_CODE`.
 *   2. `failed` -- the last attempt threw.
 *   3. `partial` -- the attempt succeeded overall, but one of several parameter
 *      sets (a `byCategory` search) was rejected; see `CATEGORY_REJECTED_PREFIX`.
 *   4. `stale` -- it succeeded, but longer ago than the refresh's own cadence
 *      allows for.
 *   5. `ok` -- everything else.
 *   6. `never` -- no row at all: the refresh has not reached this pair yet.
 *
 * Two invariants a test asserts on directly:
 *
 *  - A resource type the exposure policy denies never produces a coverage
 *    entry, for any health system, at any status -- coverage must not reveal
 *    the shape of what a `resource` deny rule hides any more than the items
 *    themselves may.
 *  - A health system the exposure policy denies never produces one either. In
 *    practice `healthSystems` is always already the deny-filtered, argument-
 *    narrowed set a tool is answering for (`selectHealthSystems`), so this is a
 *    second, redundant check -- deliberately, so a future caller that forgets
 *    to filter first cannot leak one through coverage instead.
 */

import { toIso } from "../lib/time.ts";
import { isHealthSystemDenied } from "../policy/rules.ts";
import { CATEGORY_REJECTED_PREFIX, UNSUPPORTED_ERROR_CODE } from "../sync/sync-state-codes.ts";

import type { HealthSystemInfo, SyncStatusEntry } from "./deps.ts";
import type { PolicyRules } from "../policy/rules.ts";

export type CoverageStatus = "ok" | "partial" | "stale" | "failed" | "never" | "unsupported";

export interface CoverageEntry {
  healthSystemId: string;
  /** Display name, exactly like every item's own `healthSystem` tag. */
  healthSystem: string;
  resourceType: string;
  status: CoverageStatus;
  /** Present for `failed`. Never present for `unsupported` (see `UNSUPPORTED_ERROR_CODE`). */
  errorCode?: string;
  /** ISO instant of the last successful full refresh. Present for ok/stale/partial. */
  lastOkAt?: string;
  /** Hours since the last successful full refresh. Present for `stale`. */
  ageHours?: number;
}

/**
 * How long a resource type may go since its last successful full refresh
 * before coverage calls it `stale` instead of `ok`.
 *
 * The refresh runs once every 24 hours (`worker/sync/scheduled.ts`); 36 gives it
 * a day and a half of slack -- a single missed or delayed cycle -- before flagging
 * it, so ordinary timing jitter is not reported as a gap.
 */
export const STALE_AFTER_SECONDS = 36 * 60 * 60;

/** The warning added when `items` came back empty and coverage says why it might not be everything. */
export const INCOMPLETE_WARNING = "incomplete_no_data_is_not_absence";

function key(healthSystemId: string, resourceType: string): string {
  return `${healthSystemId}\u{0}${resourceType}`;
}

function statusOf(
  state: SyncStatusEntry | undefined,
  now: number,
): Pick<CoverageEntry, "status" | "errorCode" | "lastOkAt" | "ageHours"> {
  if (state === undefined) return { status: "never" };
  if (!state.lastOk) {
    return state.lastErrorCode === UNSUPPORTED_ERROR_CODE
      ? { status: "unsupported" }
      : {
          status: "failed",
          ...(state.lastErrorCode !== null && { errorCode: state.lastErrorCode }),
        };
  }
  const lastOkAt = state.lastFullAt === null ? undefined : toIso(state.lastFullAt);
  const partial = state.warnings.some((warning) =>
    warning.code.startsWith(CATEGORY_REJECTED_PREFIX),
  );
  if (partial) return { status: "partial", ...(lastOkAt !== undefined && { lastOkAt }) };
  if (state.lastFullAt !== null) {
    const ageSeconds = now - state.lastFullAt;
    if (ageSeconds > STALE_AFTER_SECONDS) {
      return {
        status: "stale",
        ageHours: Math.floor(ageSeconds / 3600),
        ...(lastOkAt !== undefined && { lastOkAt }),
      };
    }
  }
  return { status: "ok", ...(lastOkAt !== undefined && { lastOkAt }) };
}

export interface BuildCoverageInput {
  /** The health systems this call actually reads from: already deny-filtered and argument-narrowed. */
  healthSystems: readonly HealthSystemInfo[];
  /** The FHIR resource types this tool (or this section of it) covers. */
  resourceTypes: readonly string[];
  /** `deps.syncStatus()`, unfiltered -- every health system and resource type there has ever been. */
  syncStatus: readonly SyncStatusEntry[];
  rules: PolicyRules;
  /** Unix seconds. */
  now: number;
}

/** Coverage for every (health system, resource type) pair one call's tool answers for. */
export function buildCoverage(input: BuildCoverageInput): CoverageEntry[] {
  const types = input.resourceTypes.filter(
    (resourceType) => !input.rules.resources.has(resourceType),
  );
  if (types.length === 0) return [];
  const byKey = new Map(
    input.syncStatus.map((state) => [key(state.healthSystemId, state.resourceType), state]),
  );

  const out: CoverageEntry[] = [];
  for (const healthSystem of input.healthSystems) {
    if (isHealthSystemDenied(input.rules, healthSystem.id)) continue;
    for (const resourceType of types) {
      const state = byKey.get(key(healthSystem.id, resourceType));
      out.push({
        healthSystemId: healthSystem.id,
        healthSystem: healthSystem.displayName,
        resourceType,
        ...statusOf(state, input.now),
      });
    }
  }
  return out;
}

/** Merge several tools' (or one tool's several sections') coverage into one deduplicated array. */
export function mergeCoverage(...groups: readonly (readonly CoverageEntry[])[]): CoverageEntry[] {
  const byKey = new Map<string, CoverageEntry>();
  for (const group of groups) {
    for (const entry of group) byKey.set(key(entry.healthSystemId, entry.resourceType), entry);
  }
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray() needs a lib newer than the ES2022 one this Worker compiles against (see `sortedWarnings` in `worker/policy/filter.ts`).
  return [...byKey.values()];
}

/**
 * Whether a covered pair is concerning enough that an empty `items` should not
 * be read as "nothing exists".
 *
 * `unsupported` is excluded on purpose: an organisation that does not offer a
 * type is not a gap, it is the answer, and treating it as one would put the
 * `incomplete` warning on nearly every call to an organisation smaller than
 * Epic's full USCDI surface.
 */
function isConcerning(entry: CoverageEntry): boolean {
  return entry.status !== "ok" && entry.status !== "unsupported";
}

/** True when `coverage` says an empty answer might not be the whole story. */
export function coverageIncomplete(coverage: readonly CoverageEntry[]): boolean {
  return coverage.some((entry) => isConcerning(entry));
}

/** One flat warning for a single non-`ok`, non-`unsupported` coverage entry. */
function warningFor(entry: CoverageEntry): string | null {
  switch (entry.status) {
    case "failed": {
      return `sync_failed:${entry.resourceType}:${entry.healthSystemId}:${entry.errorCode ?? "unknown"}`;
    }
    case "never": {
      return `never_synced:${entry.resourceType}:${entry.healthSystemId}`;
    }
    case "stale": {
      return `stale:${entry.resourceType}:${entry.healthSystemId}:${String(entry.ageHours ?? 0)}h`;
    }
    case "partial": {
      return `partial:${entry.resourceType}:${entry.healthSystemId}`;
    }
    case "ok":
    case "unsupported": {
      return null;
    }
  }
}

/**
 * One warning per non-`ok`, non-`unsupported` covered pair, whether or not
 * `items` is empty -- unlike {@link INCOMPLETE_WARNING}, which only fires when
 * it is. A gap in one health system's sync must be visible even when another
 * health system's data fills `items`: `get_conditions` reads two health systems,
 * one of theirs has data and the other's Condition sync is failing, and the
 * answer must say so rather than let the first health system's items make the
 * whole call look healthy.
 *
 * Never a health system *name* -- only the id, which every item and every
 * `coverage` entry already carries -- and never anything from the record
 * itself: resource type, health system id and a stable error code or age, the
 * same vocabulary `coverage` itself uses.
 */
export function coverageWarnings(coverage: readonly CoverageEntry[]): string[] {
  const out: string[] = [];
  for (const entry of coverage) {
    const warning = warningFor(entry);
    if (warning !== null) out.push(warning);
  }
  return out;
}
