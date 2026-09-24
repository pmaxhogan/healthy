/**
 * Appointments from both places they are known: the FHIR cache and the portal.
 *
 * Epic's patient-facing FHIR view never returns an Encounter before the visit
 * happens, so every *upcoming* appointment the owner has is known only to the
 * patient portal -- and the portal pass stores what it read in `portal_visits`.
 * This module merges the two into the one flat shape `get_appointments` has
 * always answered with (`NormalizedAppointmentView`, the same projection the
 * calendar maps from), so a caller cannot tell which source an item came from
 * except by its `source` field.
 *
 * ### One visit, one item
 *
 * A visit can be in both places -- the FHIR Encounter usually turns up once it
 * has happened, while the portal row is kept for a year. The match is the
 * calendar sync's own rule (`sameVisitWithinHealthSystem` in
 * `worker/sync/portal-dedupe.ts`), for the same health system: the CSN when both
 * sides carry one, otherwise a start within `DEDUPE_WINDOW_SECONDS` AND the same
 * practitioner. A start alone is not enough -- a cancelled Encounter would absorb a
 * different, live visit at the same time and answer for it as cancelled. A match
 * yields the FHIR item, with any field it lacks filled from the portal's copy; the
 * portal item is dropped.
 *
 * ### Policy
 *
 * Portal items are tagged `resourceType: "Encounter"` exactly as the FHIR ones
 * are, so a `resource` rule on Encounter removes them and every `Encounter.<field>`
 * rule reaches them through `applyPolicy` in `respond`. There is no raw FHIR
 * behind a portal item, and its stored payload is not offered as `raw` either:
 * the payload's own keys (`locationName`, `address`, `phone`, `isVideo`) are in
 * neither of the vocabularies a `field` rule is written in, so a rule the owner
 * wrote to hide an address would not reach them. Each portal item's `raw` entry is
 * therefore a bare `{ resourceType: "Encounter" }` placeholder -- one per item, so
 * `items` and `raw` stay index-aligned through the filter -- and the answer
 * carries the {@link PORTAL_RAW_WARNING} warning.
 *
 * A `health_system` deny rule removes the denied organisation before anything is
 * read -- but another organisation's portal can list the denied one's visit
 * (shared records), stored and tagged as the *listing* organisation's. So the
 * denied organisations' own sightings (their cached Encounters and stored portal
 * visits) are read as well, used only for matching, and any answer that is the
 * same visit as one of them is dropped, whichever copy would have outranked the
 * other (security review M1). Two limits, both in SECURITY.md: the match is the
 * cross-organisation one, so an allowed visit at the same time and place as a
 * denied one is hidden too -- the safe direction -- and a copy of a denied
 * organisation's visit that it has no stored record of itself cannot be
 * recognised, because the copy does not say whose it is.
 */

import { appointmentViewFromEncounter, mapResolver } from "../fhir/normalize/index.ts";
import {
  RANK_FHIR,
  outranks,
  portalRank,
  sameVisitAcrossHealthSystems,
  sameVisitWithinHealthSystem,
} from "../sync/portal-dedupe.ts";
import { portalVisitView } from "../sync/portal-mapping.ts";

import { collect, spec, withinWindow } from "./collect.ts";

import type { TaggedItem } from "./collect.ts";
import type { PortalVisitRecord, HealthSystemInfo, ToolDeps } from "./deps.ts";
import type { RawEntry } from "../policy/filter.ts";
import type { Sighting } from "../sync/portal-dedupe.ts";

/** Told to the caller whenever a portal item's `raw` is the bare placeholder. */
export const PORTAL_RAW_WARNING = "portal_items_have_no_raw";

/**
 * `appointmentViewFromEncounter` takes a NormalizeCtx but reads only
 * `ctx.health_system` -- every reference it needs was already resolved into the
 * normalized Encounter. An empty resolver is therefore correct, not a shortcut.
 */
const NO_REFS = mapResolver([]);

/**
 * Fields a FHIR item takes from the portal's copy of the same visit when it has
 * none of its own. Never `status` or `start`: where both sources speak, FHIR is
 * the record.
 */
const ENRICHED_FIELDS = ["practitioner", "department", "location", "end", "visitType"] as const;

export interface AppointmentOptions {
  /**
   * The health systems a `health_system` rule denies to this caller. Read only to
   * recognise their visits in an allowed organisation's portal; never answered
   * from. See the module comment.
   */
  denied: readonly HealthSystemInfo[];
  from?: string | undefined;
  to?: string | undefined;
  raw?: boolean | undefined;
  /** `asc` is soonest first; `desc` newest first. Undated items go last in both. */
  order: "asc" | "desc";
}

export interface Appointments {
  items: TaggedItem[];
  /** Empty unless `raw` was asked for. Index-aligned with `items`. */
  rawItems: RawEntry[];
  healthSystemIds: string[];
  /** The tool's own notes, e.g. {@link PORTAL_RAW_WARNING}. */
  warnings: string[];
}

interface Entry {
  item: TaggedItem;
  raw: RawEntry;
  healthSystemId: string;
  /** Start as unix ms, or NaN when the item has none. */
  start: number;
  portal: boolean;
  /** What both dedupes compare. See `worker/sync/portal-dedupe.ts`. */
  sighting: Sighting;
}

function stringOf(item: TaggedItem, key: string): string | undefined {
  const value: unknown = Object.hasOwn(item, key) ? Reflect.get(item, key) : undefined;
  return typeof value === "string" ? value : undefined;
}

function startOf(item: TaggedItem): number {
  const start = stringOf(item, "start");
  return start === undefined ? NaN : Date.parse(start);
}

/** The location's name, when the item has a location with one. */
function locationName(item: TaggedItem): string | undefined {
  const location: unknown = Object.hasOwn(item, "location") ? item.location : undefined;
  if (typeof location !== "object" || location === null) return undefined;
  const name: unknown = Reflect.get(location, "name");
  return typeof name === "string" ? name : undefined;
}

/** One item as the cross-health system matcher sees it. */
function sightingOf(item: TaggedItem, healthSystemId: string, rank: Sighting["rank"]): Sighting {
  return {
    healthSystemId,
    start: Math.floor(startOf(item) / 1000),
    csn: stringOf(item, "csn"),
    practitioner: stringOf(item, "practitioner"),
    department: stringOf(item, "department"),
    location: locationName(item),
    rank,
  };
}

/** The FHIR half: every cached Encounter, projected, unwindowed. */
async function fhirEntries(
  deps: ToolDeps,
  healthSystems: readonly HealthSystemInfo[],
  raw: boolean,
): Promise<Entry[]> {
  const collected = await collect(deps, healthSystems, {
    specs: [
      spec("Encounter", {
        dateOf: (item) => item.start,
        project: (item) => ({
          resourceType: "Encounter",
          ...appointmentViewFromEncounter(item, { healthSystem: item.healthSystem, refs: NO_REFS }),
          source: "fhir",
          firstParty: true,
        }),
      }),
    ],
    raw,
  });
  return collected.items.map((item, index) => {
    const healthSystemId = stringOf(item, "healthSystemId") ?? "";
    return {
      item,
      raw: collected.rawItems[index] ?? { healthSystem: "", healthSystemId, resource: {} },
      healthSystemId,
      start: startOf(item),
      portal: false,
      sighting: sightingOf(item, healthSystemId, RANK_FHIR),
    };
  });
}

/** One stored portal visit as an item, tagged exactly like a FHIR one. */
function portalEntry(
  healthSystem: HealthSystemInfo,
  record: PortalVisitRecord,
  now: number,
): Entry {
  // No `encounterId`: a portal visit has no Encounter, and the view's stand-in
  // (`csn:<csn>`) is the calendar's event-key format -- a second copy of the CSN
  // that an `Encounter.csn` deny rule would not reach.
  const view: Record<string, unknown> = { ...portalVisitView(healthSystem.id, record.visit) };
  delete view.encounterId;
  const external = record.visit.external;
  const tags = { healthSystem: healthSystem.displayName, healthSystemId: healthSystem.id };
  const item: TaggedItem = {
    resourceType: "Encounter",
    ...view,
    // A future visit the portal stopped listing is the calendar's ghost: as far
    // as anyone can tell, it was cancelled.
    ...(record.missing && { status: "canceled" }),
    source: "portal",
    // A copy another organisation's visit arrived through: which portal it was
    // seen in, so a caller can tell it is second-hand.
    firstParty: external !== true,
    ...(external === true && { via: healthSystem.id }),
    ...tags,
  };
  return {
    item,
    raw: { ...tags, resource: { resourceType: "Encounter" } },
    healthSystemId: healthSystem.id,
    start: startOf(item),
    portal: true,
    sighting: sightingOf(
      item,
      healthSystem.id,
      portalRank(external === true, record.fetchedAt, now),
    ),
  };
}

/**
 * True when a FHIR entry and a portal entry are two sightings of one visit: the
 * calendar's own rule, `sameVisitWithinHealthSystem`. The sightings carry the
 * start in seconds already.
 */
function sameVisit(fhir: Entry, portal: Entry): boolean {
  return (
    fhir.healthSystemId === portal.healthSystemId &&
    sameVisitWithinHealthSystem(fhir.sighting, portal.sighting)
  );
}

/** The FHIR item with whatever it lacks filled in from the portal's copy. */
function enrich(fhir: Entry, portal: Entry): void {
  const additions: [string, unknown][] = [];
  for (const key of ENRICHED_FIELDS) {
    if (Object.hasOwn(fhir.item, key) || !Object.hasOwn(portal.item, key)) continue;
    additions.push([key, Reflect.get(portal.item, key)]);
  }
  const telehealth = fhir.item.telehealth === true || portal.item.telehealth === true;
  fhir.item = { ...fhir.item, ...Object.fromEntries(additions), telehealth };
}

/**
 * Add the portal's visits to the FHIR entries, merging the ones that are the
 * same appointment. Mutates `entries` (only this module's own array).
 */
async function mergePortal(
  deps: ToolDeps,
  healthSystems: readonly HealthSystemInfo[],
  entries: Entry[],
  now: number,
): Promise<void> {
  const claimed = new Set<Entry>();
  for (const healthSystem of healthSystems) {
    const records = await deps.portalVisits(healthSystem.id);
    for (const record of records) {
      const portal = portalEntry(healthSystem, record, now);
      const match = entries.find(
        (entry) => !entry.portal && !claimed.has(entry) && sameVisit(entry, portal),
      );
      if (match === undefined) {
        entries.push(portal);
        continue;
      }
      claimed.add(match);
      enrich(match, portal);
    }
  }
}

/**
 * One item per visit across health systems: a visit several organisations' records
 * list is answered once, by the sighting that outranks the rest (see
 * `worker/sync/portal-dedupe.ts`). A visit only one of them lists is always kept.
 */
function collapseAcrossHealthSystems(entries: readonly Entry[]): Entry[] {
  const byPrecedence = [...entries];
  byPrecedence.sort((a, b) => {
    if (outranks(a.sighting, b.sighting)) return -1;
    return outranks(b.sighting, a.sighting) ? 1 : 0;
  });
  const kept: Entry[] = [];
  for (const entry of byPrecedence) {
    const covered = kept.some((winner) =>
      sameVisitAcrossHealthSystems(winner.sighting, entry.sighting),
    );
    if (!covered) kept.push(entry);
  }
  return kept;
}

/**
 * Every sighting a denied health system has of its own visits: its cached
 * Encounters and its stored portal visits. For matching only.
 */
async function deniedSightings(
  deps: ToolDeps,
  denied: readonly HealthSystemInfo[],
  now: number,
): Promise<Sighting[]> {
  if (denied.length === 0) return [];
  // Unmerged on purpose: a portal copy the FHIR item would absorb still carries
  // its own CSN and labels, and every one of them is something to match on.
  const encounters = await fhirEntries(deps, denied, false);
  const sightings = encounters.map((entry) => entry.sighting);
  for (const healthSystem of denied) {
    const records = await deps.portalVisits(healthSystem.id);
    for (const record of records) {
      sightings.push(portalEntry(healthSystem, record, now).sighting);
    }
  }
  return sightings;
}

function compare(order: "asc" | "desc"): (a: Entry, b: Entry) => number {
  return (a, b) => {
    const aMissing = Number.isNaN(a.start);
    const bMissing = Number.isNaN(b.start);
    if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
    return order === "asc" ? a.start - b.start : b.start - a.start;
  };
}

/**
 * Every appointment the selected health systems have, from both sources, windowed on
 * `start` and ordered as asked.
 *
 * The dedupe runs before the window, deliberately: a FHIR Encounter just outside
 * the window must still claim its portal twin, or the twin would be shown as a
 * separate visit just inside it.
 */
export async function collectAppointments(
  deps: ToolDeps,
  healthSystems: readonly HealthSystemInfo[],
  options: AppointmentOptions,
): Promise<Appointments> {
  const raw = options.raw === true;
  const now = deps.now();
  const entries = await fhirEntries(deps, healthSystems, raw);
  await mergePortal(deps, healthSystems, entries, now);
  const denied = await deniedSightings(deps, options.denied, now);

  // After the collapse, and regardless of rank: a denied organisation's own
  // copy may be stale and lose to the allowed one, which must still go.
  const kept = collapseAcrossHealthSystems(entries).filter(
    (entry) =>
      denied.every((sighting) => !sameVisitAcrossHealthSystems(sighting, entry.sighting)) &&
      withinWindow(stringOf(entry.item, "start"), options.from, options.to),
  );
  kept.sort(compare(options.order));

  return {
    items: kept.map((entry) => entry.item),
    rawItems: raw ? kept.map((entry) => entry.raw) : [],
    healthSystemIds: healthSystems.map((healthSystem) => healthSystem.id),
    warnings: raw && kept.some((entry) => entry.portal) ? [PORTAL_RAW_WARNING] : [],
  };
}
