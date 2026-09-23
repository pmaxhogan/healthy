/**
 * Resolving the Practitioner, Location and Organization an Encounter points at.
 *
 * Epic routinely omits `Reference.display`, so an appointment whose references
 * are not resolved has no practitioner name, no clinic address and no
 * organisation -- which is most of the calendar event. The normalizers are pure
 * and take a synchronous `RefResolver`, so everything has to be in hand before
 * they run: that is what this module assembles.
 *
 * Three deliberate limits:
 *
 *   - **30-day cache.** A practitioner's name and a clinic's address change on a
 *     scale of years. Re-reading them hourly would be the single largest source of
 *     upstream requests in the whole app.
 *   - **50 reads per health system per run -- a pace, not a ceiling.** This is the
 *     hourly cron pass, which gets one invocation and no alarm to resume in (the
 *     Durable Object chunking `full-refresh.ts` uses does not apply here). A first
 *     sync of a long history, or a wide `window_past_days`, can reference hundreds
 *     of clinicians in one pass; without a per-run cap the run would spend its
 *     whole CPU budget on `Practitioner.Read` calls and never write an event. What
 *     it defers is not lost: `collectEncounterReferences` recomputes the same
 *     references from the same encounters next hour, so a deferred name or
 *     address resolves within a few runs rather than never -- and every run that
 *     defers any says so loudly, both in the logs (`sync.refs.deferred` at `warn`)
 *     and in the run's own warnings (`references_deferred`), never silently.
 *   - **A failed read is a miss, not a failure.** An organisation that refuses one
 *     Practitioner (Epic's 4118, or a 404 for a clinician who has left) must not
 *     fail the appointment that mentions them -- the event is simply written
 *     without that name.
 *
 * `parseReference` is local rather than imported because `refs.ts` keeps its
 * equivalent private. It handles the three forms Epic sends: a relative
 * `Practitioner/123`, an absolute URL under the FHIR base, and either with a
 * `/_history/N` suffix.
 */

import { errorFields } from "../lib/log.ts";

import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { Encounter, Resource } from "../fhir/types.ts";
import type { FhirClient } from "../providers/epic/fhir-client.ts";
import type * as fhir4 from "fhir/r4";

/** How long a resolved reference stays usable. 30 days, in milliseconds. */
const REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Reads one health system may make in one run. See the module comment. */
const MAX_REFERENCE_READS = 50;

/**
 * Reference targets worth resolving for a calendar event.
 *
 * `PractitionerRole` is absent on purpose: nothing in the appointment view reads
 * it, and fetching it would spend reads for no visible change.
 */
const RESOLVABLE: ReadonlySet<string> = new Set(["Practitioner", "Location", "Organization"]);

export interface ParsedReference {
  resourceType: string;
  id: string;
  /** `ResourceType/id`, matching what `mapResolver` keys on. */
  key: string;
}

/** Split a FHIR reference into its type and id, or null when it is not one. */
function parseReference(reference: string | undefined): ParsedReference | null {
  if (reference === undefined || reference === "") return null;
  const withoutHistory = reference.split("/_history/", 1)[0] ?? reference;
  const segments = withoutHistory.split("/").filter((segment) => segment !== "");
  const id = segments.at(-1);
  const resourceType = segments.at(-2);
  return id === undefined || resourceType === undefined
    ? null
    : { resourceType, id, key: `${resourceType}/${id}` };
}

/** Every distinct reference the given Encounters point at, in first-seen order. */
export function collectEncounterReferences(encounters: readonly Encounter[]): ParsedReference[] {
  const seen = new Set<string>();
  const out: ParsedReference[] = [];
  const add = (reference: fhir4.Reference | undefined): void => {
    const parsed = parseReference(reference?.reference);
    if (parsed === null || !RESOLVABLE.has(parsed.resourceType) || seen.has(parsed.key)) return;
    seen.add(parsed.key);
    out.push(parsed);
  };
  for (const encounter of encounters) {
    const participants = encounter.participant ?? [];
    const locations = encounter.location ?? [];
    for (const participant of participants) add(participant.individual);
    for (const location of locations) add(location.location);
    add(encounter.serviceProvider);
  }
  return out;
}

export interface ResolveReport {
  /** Everything resolved, whether from the cache or freshly read. */
  resources: Resource[];
  /** Resources served from `fhir_cache`. */
  fromCache: number;
  /** Upstream reads actually performed. */
  read: number;
  /** References left unresolved because the cap was reached. */
  deferred: number;
}

/**
 * Resolve references through `fhir_cache`, reading the misses upstream.
 *
 * Newly read resources are written back with a 30-day TTL, so the next run's
 * misses are only the genuinely new ones.
 */
export async function resolveReferences(
  ctx: Ctx,
  repos: Repos,
  healthSystemId: string,
  references: readonly ParsedReference[],
  client: FhirClient,
  options: { maxReads?: number } = {},
): Promise<ResolveReport> {
  const maxReads = options.maxReads ?? MAX_REFERENCE_READS;
  const report: ResolveReport = { resources: [], fromCache: 0, read: 0, deferred: 0 };
  const fetched: Resource[] = [];

  for (const reference of references) {
    const cached = await repos.fhirCache.get(healthSystemId, reference.resourceType, reference.id);
    if (cached !== null) {
      report.fromCache += 1;
      report.resources.push(cached.resource as Resource);
      continue;
    }
    if (report.read >= maxReads) {
      report.deferred += 1;
      continue;
    }
    report.read += 1;
    const resource = await readOne(ctx, client, reference);
    if (resource === null) continue;
    report.resources.push(resource);
    fetched.push(resource);
  }

  if (fetched.length > 0) {
    await repos.fhirCache.upsertMany(
      healthSystemId,
      fetched.map((resource) => ({
        ...resource,
        resourceType: resource.resourceType,
        // A resource with no id cannot be cached under a key; `read` never
        // returns one, but the FHIR type says it may.
        id: resource.id ?? "",
      })),
      REFERENCE_TTL_MS,
    );
  }
  if (report.deferred > 0) {
    // `warn`, not `info`: a deferred reference is a name or an address this run
    // did not have time to fetch, not a routine event. It is not lost -- the same
    // reference is collected again from next hour's encounters and resolved then,
    // one `MAX_REFERENCE_READS` batch at a time -- but the caller has to be able
    // to see that it happened rather than notice only that an event is missing a
    // practitioner's name.
    ctx.log.warn("sync.refs.deferred", { healthSystemId, deferred: report.deferred, maxReads });
  }
  return report;
}

/** One read, with a failure treated as a miss. See the module comment. */
async function readOne(
  ctx: Ctx,
  client: FhirClient,
  reference: ParsedReference,
): Promise<Resource | null> {
  try {
    return await client.read(reference.resourceType, reference.id);
  } catch (error) {
    ctx.log.warn("sync.refs.read_failed", {
      resourceType: reference.resourceType,
      ...errorFields(error),
    });
    return null;
  }
}
