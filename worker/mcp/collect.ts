/**
 * Reading the cache and normalizing it: the step every clinical tool shares.
 *
 * A tool describes *what* it wants -- one or more resource types, the date field
 * that kind of resource is filtered and ordered by, and any predicate of its own
 * -- and this module does the rest: pick the providers, resolve each provider's
 * references, normalize, window, merge across providers, order newest first.
 *
 * Two invariants it maintains that the layers above depend on:
 *
 *  - Each item carries `provider` (the display name, which is what a model should
 *    say back to a human) and `providerId` (the id, which is what the policy layer
 *    and the audit row key off). Nothing downstream has to look a provider up.
 *  - The normalized item and the raw resource behind it stay index-aligned, so
 *    `applyPolicy` dropping one drops the other.
 *
 * Nothing here talks to a health system. Every tool but `get_document_text` reads
 * only what the scheduled refresh already cached, which is why they are all fast
 * and none of them can be made to spend an organisation's API quota.
 */

import { mapResolver, normalizeResource } from "../fhir/normalize/index.ts";
import { isProviderDenied } from "../policy/rules.ts";

import type { CachedRow, ProviderInfo, ToolDeps } from "./deps.ts";
import type { NormalizeCtx, NormalizedResource } from "../fhir/normalize/index.ts";
import type { RawEntry } from "../policy/filter.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type * as fhir4 from "fhir/r4";

/** Resource types a reference in a clinical resource can point at. */
export const REFERENCE_TYPES: readonly string[] = [
  "Practitioner",
  "PractitionerRole",
  "Location",
  "Organization",
  "Medication",
];

/** Any normalized shape, as a plain record, plus the provider tags. */
export type TaggedItem = Record<string, unknown>;

/** One resource type a tool wants, and how to treat it. */
export interface CollectSpec {
  resourceType: string;
  /** The date this kind of item is windowed and ordered by. */
  dateOf?: ((item: NormalizedResource) => string | undefined) | undefined;
  /**
   * A predicate of the tool's own: category, status, code match.
   *
   * It gets the raw resource as well as the normalized item, because the codes a
   * caller filters on (`laboratory`, a LOINC number) survive normalization only
   * as a display string -- `codeText` prefers `text` and then `display`, so the
   * machine-readable code is only in the resource.
   */
  keep?: ((item: NormalizedResource, resource: fhir4.FhirResource) => boolean) | undefined;
  /** Rewrite the normalized item before it is tagged (appointments do this). */
  project?: ((item: NormalizedResource) => TaggedItem) | undefined;
}

/**
 * Build a spec for one resource type with the narrowed item type in hand.
 *
 * Without this every `dateOf` and `keep` in the tool layer would have to
 * re-narrow the `NormalizedResource` union by hand, which is noise that hides
 * what the predicate actually says.
 */
export function spec<K extends NormalizedResource["resourceType"]>(
  resourceType: K,
  options: {
    dateOf?: (item: Extract<NormalizedResource, { resourceType: K }>) => string | undefined;
    keep?: (
      item: Extract<NormalizedResource, { resourceType: K }>,
      resource: fhir4.FhirResource,
    ) => boolean;
    project?: (item: Extract<NormalizedResource, { resourceType: K }>) => TaggedItem;
  } = {},
): CollectSpec {
  type Narrowed = Extract<NormalizedResource, { resourceType: K }>;
  const { dateOf, keep, project } = options;
  // The cast is sound because `collect` only ever calls these on items it just
  // produced from a resource of exactly this `resourceType`.
  const narrow = (item: NormalizedResource): Narrowed => item as Narrowed;
  return {
    resourceType,
    ...(dateOf && { dateOf: (item: NormalizedResource) => dateOf(narrow(item)) }),
    ...(keep && {
      keep: (item: NormalizedResource, resource: fhir4.FhirResource) =>
        keep(narrow(item), resource),
    }),
    ...(project && { project: (item: NormalizedResource) => project(narrow(item)) }),
  };
}

export interface CollectOptions {
  specs: readonly CollectSpec[];
  /** Inclusive lower bound on the spec's date, as an ISO date or instant. */
  from?: string | undefined;
  /** Inclusive upper bound. A bare date means the end of that day. */
  to?: string | undefined;
  /** Include the raw FHIR resources alongside the normalized items. */
  raw?: boolean | undefined;
}

export interface Collected {
  items: TaggedItem[];
  /** Empty unless `raw` was asked for. Index-aligned with `items`. */
  rawItems: RawEntry[];
  /** The providers actually read from, by id. For the audit row. */
  providerIds: string[];
}

/**
 * Pick the providers a call applies to.
 *
 * A denied provider is removed first and can never be named back in: the
 * `providers` argument narrows the allowed set, it does not choose from the full
 * one. An argument that matches nothing yields no providers -- and so an empty
 * answer -- rather than silently falling back to all of them.
 */
export function selectProviders(
  all: readonly ProviderInfo[],
  rules: PolicyRules,
  requested: readonly string[] | undefined,
): ProviderInfo[] {
  const allowed = all.filter((provider) => !isProviderDenied(rules, provider.id));
  if (requested === undefined || requested.length === 0) return allowed;
  const needles = requested.map((value) => value.trim().toLowerCase()).filter((v) => v.length > 0);
  return allowed.filter((provider) =>
    needles.some(
      (needle) =>
        provider.id.toLowerCase() === needle || provider.displayName.toLowerCase().includes(needle),
    ),
  );
}

/**
 * A caller's `limit`, made safe to slice with -- or `undefined` for "no limit
 * at all", which is what an absent `limit` means.
 *
 * There is no ceiling: a tool answers everything it found unless the caller
 * asked to see less of it. An explicit `limit` is still floored at 1 and
 * truncated to an integer, because "give me the top -5" and "the top 3.7" are
 * not requests `respond()`'s `slice` can act on.
 */
export function effectiveLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(1, Math.trunc(limit));
}

function isResource(value: unknown): value is fhir4.FhirResource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { resourceType?: unknown }).resourceType === "string"
  );
}

/** A date bound as a comparable millisecond value; `end` pads a bare date out. */
function bound(value: string | undefined, end: boolean): number | undefined {
  if (value === undefined) return undefined;
  // A bare `YYYY-MM-DD` upper bound should include that whole day, or `to` would
  // silently exclude everything that happened after midnight on the last day.
  const padded = end && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T23:59:59.999Z` : value;
  const ms = Date.parse(padded);
  return Number.isNaN(ms) ? undefined : ms;
}

interface Entry {
  item: TaggedItem;
  raw: RawEntry;
  /** Sort key: the spec's date as ms, or {@link NO_DATE}. */
  order: number;
}

/** The sort key of an item whose date is missing or unparseable. Orders last. */
const NO_DATE = -Infinity;

/** The sort key for one item: its spec date in ms, or {@link NO_DATE}. */
function orderOf(current: CollectSpec, item: NormalizedResource): number {
  const date = current.dateOf?.(item) ?? item.lastUpdated;
  if (date === undefined) return NO_DATE;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? NO_DATE : ms;
}

/**
 * Whether an item's date falls inside the caller's window.
 *
 * An item with no usable date cannot be shown to be inside a window, so a windowed
 * call excludes it rather than guessing. An unwindowed call keeps everything.
 */
function inWindow(order: number, after: number | undefined, before: number | undefined): boolean {
  return order === NO_DATE
    ? after === undefined && before === undefined
    : (after === undefined || order >= after) && (before === undefined || order <= before);
}

/**
 * Whether one ISO date falls inside a caller's `from`/`to` window, by exactly the
 * rules `collect` applies: a bare `to` date covers that whole day, and an item
 * with no usable date is only kept when there is no window at all.
 *
 * For items that do not come out of the FHIR cache (the portal's visits) but
 * must be windowed as if they did.
 */
export function withinWindow(
  date: string | undefined,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const ms = date === undefined ? NaN : Date.parse(date);
  return inWindow(Number.isNaN(ms) ? NO_DATE : ms, bound(from, false), bound(to, true));
}

/** Every entry one provider contributes for one spec. */
function entriesFor(
  provider: ProviderInfo,
  ctx: NormalizeCtx,
  current: CollectSpec,
  rows: readonly CachedRow[],
  after: number | undefined,
  before: number | undefined,
): Entry[] {
  const out: Entry[] = [];
  const tags = { provider: provider.displayName, providerId: provider.id };
  for (const row of rows) {
    if (!isResource(row.resource)) continue;
    const normalized = normalizeResource(row.resource, ctx);
    if (current.keep && !current.keep(normalized, row.resource)) continue;
    const order = orderOf(current, normalized);
    if (!inWindow(order, after, before)) continue;
    const projected = current.project ? current.project(normalized) : { ...normalized };
    out.push({
      item: { ...projected, ...tags },
      raw: { ...tags, resource: row.resource },
      order,
    });
  }
  return out;
}

/**
 * Read, normalize, filter and merge.
 *
 * Ordering is newest-first on the spec's own date, with items that have no date
 * last. That is the order a model wants for "what happened recently" and it is
 * stable across providers, which the cache's per-provider ordering is not.
 */
export async function collect(
  deps: ToolDeps,
  providers: readonly ProviderInfo[],
  options: CollectOptions,
): Promise<Collected> {
  const after = bound(options.from, false);
  const before = bound(options.to, true);
  const entries: Entry[] = [];

  for (const provider of providers) {
    const pool = await deps.referencePool(provider.id);
    const refs = mapResolver(pool.filter(isResource));
    const ctx: NormalizeCtx = { provider: provider.displayName, refs };

    for (const current of options.specs) {
      const rows = await deps.resources(provider.id, current.resourceType);
      entries.push(...entriesFor(provider, ctx, current, rows, after, before));
    }
  }

  entries.sort((a, b) => b.order - a.order);

  return {
    items: entries.map((entry) => entry.item),
    rawItems: options.raw === true ? entries.map((entry) => entry.raw) : [],
    providerIds: providers.map((provider) => provider.id),
  };
}
