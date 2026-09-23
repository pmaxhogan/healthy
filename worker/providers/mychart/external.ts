/**
 * Whether an upcoming visit belongs to a *different* organisation than the portal
 * that listed it.
 *
 * A chart account can be linked to other health systems (shared records), and a
 * portal's upcoming list can then include visits booked elsewhere. The same visit
 * is also listed by its own organisation's portal, so the sync has to know which
 * copy is first-hand -- see `worker/sync/portal-dedupe.ts`.
 *
 * **Every key here is a [guess].** No live capture has yet shown a visit from
 * another organisation, so the names below are the plausible ones, tried in
 * order, and a payload that uses none of them simply reads as first-party. That
 * is the safe way round: an unrecognised external visit is still kept, it only
 * loses the precedence tie-break it would otherwise lose on purpose.
 *
 * Kept out of `wire.ts` so the confirmed vocabulary there is not mixed with a
 * list nobody has seen on the wire. Nothing here returns or logs an
 * organisation's name: a boolean is all the dedupe needs.
 */

/** [guess] Top-level flags meaning "this visit is at another organisation". */
const EXTERNAL_FLAG_KEYS: readonly string[] = [
  "IsExternal",
  "IsExternalVisit",
  "IsExternalAppointment",
  "IsOutsideVisit",
  "IsHappyTogether",
];

/** [guess] Keys holding a nested organisation object on the visit. */
const ORGANIZATION_OBJECT_KEYS: readonly string[] = ["Organization", "OrganizationInfo", "Org"];

/** [guess] The same flag, inside that nested object. */
const ORGANIZATION_EXTERNAL_KEYS: readonly string[] = ["IsExternal", "External", "IsExternalOrg"];

const TRUTHY: ReadonlySet<unknown> = new Set([true, 1, "true", "True"]);

function flagged(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => TRUTHY.has(fields.get(key)));
}

/**
 * True when the visit says it is another organisation's.
 *
 * `fields` is the visit record's own keys as a Map, exactly as `visits.ts` reads
 * every other field, so nothing inherited can be read.
 */
export function isExternalVisit(fields: ReadonlyMap<string, unknown>): boolean {
  if (flagged(fields, EXTERNAL_FLAG_KEYS)) return true;
  for (const key of ORGANIZATION_OBJECT_KEYS) {
    const value = fields.get(key);
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if (flagged(new Map(Object.entries(value)), ORGANIZATION_EXTERNAL_KEYS)) return true;
  }
  return false;
}
