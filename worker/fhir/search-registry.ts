/**
 * What to fetch from an organisation, and how.
 *
 * One table drives both the hourly appointment sync and the daily full refresh.
 * Each entry says which resource type, whether it is searched or only read by
 * id, which Epic "Incoming API" the app registration must include, and which
 * USCDI generation it belongs to.
 *
 * Two shapes of Epic behaviour are baked in:
 *
 *  - Several resource types must be searched once per `category` rather than
 *    once overall. Epic's patient-facing Condition and Observation searches
 *    require a category and return only that category, so `params` returns a
 *    *list* of parameter sets and the caller runs one search per set.
 *  - Support varies by organisation and by Epic version. `filterSupported`
 *    intersects this table with the organisation's CapabilityStatement, dropping
 *    resource types it does not expose and parameters it does not advertise,
 *    rather than sending a search that returns 4122 or nothing.
 *
 * No organisation, base URL or patient id appears here: `patientId` is always an
 * argument.
 */

import type { CapabilityIndex, CapabilityResource, Encounter } from "./types.ts";

/** `_count` is a ceiling, not a floor; Epic may return fewer and page. */
const PAGE_SIZE = "100";

const READ = "read";
const SEARCH_TYPE = "search-type";

export type RegistryMode = "search" | "read";

export interface RegistryEntry {
  resourceType: string;
  /** `read`: fetched by id on demand only, never searched. */
  mode: RegistryMode;
  /** The Incoming API name on Epic's app-registration appendix. */
  epicApiName: string;
  uscdi: "v1" | "v3";
  /**
   * One parameter set per search to run. Several sets means several searches.
   * Empty for `mode: "read"` entries.
   */
  params: (patientId: string, sinceIso?: string) => Record<string, string>[];
  /**
   * A search parameter the organisation must advertise, or the entry is skipped
   * entirely -- a search that cannot be narrowed the way it needs to be would
   * either fail or return an unusable superset.
   */
  needsCapability?: string | undefined;
}

function none(): Record<string, string>[] {
  return [];
}

function patientOnly(patientId: string): Record<string, string>[] {
  return [{ patient: patientId, _count: PAGE_SIZE }];
}

function patientSince(patientId: string, sinceIso?: string): Record<string, string>[] {
  const params: Record<string, string> = { patient: patientId, _count: PAGE_SIZE };
  if (sinceIso !== undefined && sinceIso !== "") params.date = `ge${sinceIso}`;
  return [params];
}

/** One search per category: Epic's patient-facing searches are category-scoped. */
function byCategory(...categories: string[]): (patientId: string) => Record<string, string>[] {
  return (patientId) =>
    categories.map((category) => ({ patient: patientId, category, _count: PAGE_SIZE }));
}

/**
 * The full table.
 *
 * `uscdi` marks which generation of Epic's USCDI appendix an API comes from; the
 * app is registered for both v1 and v3, and the field exists so a v3-only
 * organisation can be told apart from one that simply does not expose a type.
 */
export const SEARCH_REGISTRY: readonly RegistryEntry[] = [
  // Read by id: the patient id comes from the token response, so there is
  // nothing to search for.
  { resourceType: "Patient", mode: READ, epicApiName: "Patient.Read", uscdi: "v1", params: none },

  {
    resourceType: "Encounter",
    mode: "search",
    epicApiName: "Encounter.Search",
    uscdi: "v1",
    params: patientSince,
    needsCapability: "date",
  },
  {
    resourceType: "Condition",
    mode: "search",
    epicApiName: "Condition.Search",
    uscdi: "v1",
    params: byCategory("problem-list-item", "encounter-diagnosis", "health-concern"),
    needsCapability: "category",
  },
  {
    resourceType: "Observation",
    mode: "search",
    epicApiName: "Observation.Search",
    uscdi: "v1",
    params: byCategory("laboratory", "vital-signs", "social-history", "survey"),
    needsCapability: "category",
  },
  {
    resourceType: "MedicationRequest",
    mode: "search",
    epicApiName: "MedicationRequest.Search",
    uscdi: "v1",
    params: patientOnly,
  },
  {
    resourceType: "MedicationDispense",
    mode: "search",
    epicApiName: "MedicationDispense.Search",
    uscdi: "v3",
    params: patientOnly,
  },
  {
    resourceType: "AllergyIntolerance",
    mode: "search",
    epicApiName: "AllergyIntolerance.Search",
    uscdi: "v1",
    params: patientOnly,
  },
  {
    resourceType: "Immunization",
    mode: "search",
    epicApiName: "Immunization.Search",
    uscdi: "v1",
    params: patientOnly,
  },
  {
    resourceType: "Procedure",
    mode: "search",
    epicApiName: "Procedure.Search",
    uscdi: "v1",
    params: patientSince,
  },
  {
    resourceType: "DiagnosticReport",
    mode: "search",
    epicApiName: "DiagnosticReport.Search",
    uscdi: "v1",
    params: patientSince,
  },
  {
    // Metadata only. The attached Binary is fetched lazily on MCP demand,
    // because Epic caps document queries per day (error 4135).
    resourceType: "DocumentReference",
    mode: "search",
    epicApiName: "DocumentReference.Search",
    uscdi: "v1",
    params: byCategory("clinical-note"),
    needsCapability: "category",
  },
  {
    resourceType: "CarePlan",
    mode: "search",
    epicApiName: "CarePlan.Search",
    uscdi: "v1",
    params: byCategory("assess-plan", "longitudinal"),
    needsCapability: "category",
  },
  {
    resourceType: "CareTeam",
    mode: "search",
    epicApiName: "CareTeam.Search",
    uscdi: "v1",
    params: patientOnly,
  },
  {
    resourceType: "Goal",
    mode: "search",
    epicApiName: "Goal.Search",
    uscdi: "v1",
    params: patientOnly,
  },
  {
    resourceType: "Device",
    mode: "search",
    epicApiName: "Device.Search",
    uscdi: "v1",
    params: patientOnly,
  },
  {
    resourceType: "Coverage",
    mode: "search",
    epicApiName: "Coverage.Search",
    uscdi: "v3",
    params: patientOnly,
  },
  {
    resourceType: "ServiceRequest",
    mode: "search",
    epicApiName: "ServiceRequest.Search",
    uscdi: "v3",
    params: patientOnly,
  },
  {
    resourceType: "Specimen",
    mode: "search",
    epicApiName: "Specimen.Search",
    uscdi: "v3",
    params: patientOnly,
  },

  // Referenced from the resources above and resolved by id when a reference is
  // seen. Cached for 30 days: they change far less often than clinical data.
  {
    resourceType: "Practitioner",
    mode: READ,
    epicApiName: "Practitioner.Read",
    uscdi: "v1",
    params: none,
  },
  {
    resourceType: "PractitionerRole",
    mode: READ,
    epicApiName: "PractitionerRole.Read",
    uscdi: "v3",
    params: none,
  },
  { resourceType: "Location", mode: READ, epicApiName: "Location.Read", uscdi: "v1", params: none },
  {
    resourceType: "Organization",
    mode: READ,
    epicApiName: "Organization.Read",
    uscdi: "v1",
    params: none,
  },
  {
    resourceType: "Medication",
    mode: READ,
    epicApiName: "Medication.Read",
    uscdi: "v1",
    params: none,
  },
  { resourceType: "Binary", mode: READ, epicApiName: "Binary.Read", uscdi: "v1", params: none },
];

/** The resource types only ever fetched by id, for the reference resolver. */
export const ON_DEMAND_READ_TYPES: readonly string[] = SEARCH_REGISTRY.filter(
  (entry) => entry.mode === READ && entry.resourceType !== "Patient",
).map((entry) => entry.resourceType);

export interface PreparedSearch {
  resourceType: string;
  params: Record<string, string>;
}

/**
 * The one search the hourly appointment sync runs.
 *
 * `status` is deliberately absent: at many organisations it is not a native
 * Encounter search parameter, so it is applied with `encounterStatusFilter`
 * instead. `date=ge{since}` covers the rolling past window and everything ahead
 * of it.
 */
export function appointmentEncounterSearch(patientId: string, sinceIso: string): PreparedSearch {
  return {
    resourceType: "Encounter",
    params: { patient: patientId, date: `ge${sinceIso}`, _count: PAGE_SIZE },
  };
}

function capabilityOf(
  index: CapabilityIndex,
  resourceType: string,
): CapabilityResource | undefined {
  return Object.hasOwn(index.resources, resourceType) ? index.resources[resourceType] : undefined;
}

/** `_`-prefixed parameters are FHIR-wide and are not listed per resource. */
function paramSupported(capability: CapabilityResource, name: string): boolean {
  return name.startsWith("_") || capability.searchParams.includes(name);
}

export function supportsInteraction(
  index: CapabilityIndex,
  resourceType: string,
  interaction: string,
): boolean {
  return capabilityOf(index, resourceType)?.interactions.includes(interaction) ?? false;
}

export function supportsSearchParam(
  index: CapabilityIndex,
  resourceType: string,
  name: string,
): boolean {
  const capability = capabilityOf(index, resourceType);
  return capability !== undefined && paramSupported(capability, name);
}

function prune(
  params: Record<string, string>,
  capability: CapabilityResource,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => paramSupported(capability, name)),
  );
}

/**
 * De-duplicate parameter sets.
 *
 * Needed because pruning collapses them: drop `category` from Condition's three
 * category searches and all three become the same search, which would otherwise
 * be run three times.
 */
function dedupe(sets: readonly Record<string, string>[]): Record<string, string>[] {
  const seen = new Set<string>();
  const out: Record<string, string>[] = [];
  for (const set of sets) {
    // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker is compiled against the ES2022 lib; the array here is a fresh one from Object.entries, so sorting in place mutates nothing shared.
    const key = JSON.stringify(Object.entries(set).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(set);
  }
  return out;
}

/**
 * Intersect the registry with one organisation's CapabilityStatement.
 *
 * Drops an entry when the organisation does not list the resource type at all,
 * does not support the interaction the entry needs, cannot scope a search to a
 * patient, or lacks the entry's `needsCapability` parameter. Keeps the entry but
 * prunes individual parameters otherwise, then de-duplicates the parameter sets
 * that pruning collapsed together.
 */
export function filterSupported(
  registry: readonly RegistryEntry[],
  index: CapabilityIndex,
): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const entry of registry) {
    const capability = capabilityOf(index, entry.resourceType);
    if (capability === undefined) continue;
    if (entry.mode === READ) {
      if (capability.interactions.includes(READ)) out.push(entry);
      continue;
    }
    if (!capability.interactions.includes(SEARCH_TYPE)) continue;
    // Without `patient` the search cannot be scoped to the owner at all.
    if (!paramSupported(capability, "patient")) continue;
    if (entry.needsCapability !== undefined && !paramSupported(capability, entry.needsCapability)) {
      continue;
    }
    const build = entry.params;
    out.push({
      ...entry,
      params: (patientId, sinceIso) =>
        dedupe(build(patientId, sinceIso).map((set) => prune(set, capability))),
    });
  }
  return out;
}

/**
 * Encounter statuses the calendar sync cares about.
 *
 * `cancelled` is included on purpose: a cancelled encounter is what turns an
 * existing calendar event into a ghost, so it has to come back from the search.
 */
export const CALENDAR_ENCOUNTER_STATUSES: readonly string[] = [
  "planned",
  "arrived",
  "triaged",
  "in-progress",
  "finished",
  "cancelled",
];

export interface EncounterStatusFilter {
  /** Merge into the search parameters. Empty when `status` is not native. */
  params: Record<string, string>;
  /** Always applied to the results, native parameter or not. */
  apply: (encounters: readonly Encounter[]) => Encounter[];
}

/**
 * Filter Encounters by status, natively where the organisation supports it.
 *
 * Epic added `status` as a *post-filter* parameter in some versions and does not
 * support it at all in others, so the client-side pass runs either way: when the
 * parameter is native it is a no-op, and when Epic quietly ignores it (the
 * documented post-filter behaviour varies by version) it is the thing that
 * actually works.
 *
 * `index` may be null when the CapabilityStatement has not been fetched yet, in
 * which case nothing is sent and everything is filtered locally.
 */
export function encounterStatusFilter(
  index: CapabilityIndex | null,
  allowed: readonly string[] = CALENDAR_ENCOUNTER_STATUSES,
): EncounterStatusFilter {
  const native = index !== null && supportsSearchParam(index, "Encounter", "status");
  const permitted = new Set(allowed);
  return {
    params: native ? { status: allowed.join(",") } : {},
    apply: (encounters) =>
      encounters.filter((encounter) => permitted.has(encounter.status as string)),
  };
}
